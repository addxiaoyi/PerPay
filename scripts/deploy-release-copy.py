"""Upgrade a maintenance candidate using a fresh database copy and retain both releases."""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request

NODE = '/opt/perpay-candidate-20261104a/runtime/bin/node'
UNIT = Path('/etc/systemd/system/perpay-candidate.service')
SERVICE = 'perpay-candidate.service'
SYNC_UNIT = Path('/etc/systemd/system/perpay-legacy-sync.service')
SYNC_TIMER = 'perpay-legacy-sync.timer'
SYNC_SERVICE = 'perpay-legacy-sync.service'

HELPER = r'''
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
const [mode,oldApp,newApp,sourceRoot,targetRoot,recovery]=process.argv.slice(2);
const {captureReleaseContents,compareReleaseContents}=await import(pathToFileURL(join(newApp,'scripts/rehearse-release-restore.ts')).href);
function capture(path){const sql=new DatabaseSync(path,{readOnly:true});try{sql.exec('BEGIN');return captureReleaseContents(sql,{keyMigrationProjection:true});}finally{sql.close();}}
const reportPath=join(recovery,'database-copy.json');
if(mode==='prepare'){
 const oldMaintenance=await import(pathToFileURL(join(oldApp,'dist/database/maintenance.js')).href);
 const maintenance=await import(pathToFileURL(join(newApp,'dist/database/maintenance.js')).href);
 const {AppDatabase}=await import(pathToFileURL(join(newApp,'dist/database/database.js')).href);
 const key=Buffer.from(readFileSync(join(targetRoot,'secrets/master-key'),'utf8').trim(),'hex');
 let db;
 try{
  const baseline=capture(join(sourceRoot,'data/perpay.sqlite3'));
  const backup=await oldMaintenance.createOperationalBackup({dataDirectory:join(sourceRoot,'data'),backupDirectory:join(recovery,'backups')});
  maintenance.restoreOperationalBackup({dataDirectory:join(targetRoot,'data'),backupDirectory:join(recovery,'backups'),backupName:backup.name,expectedSha256:backup.sha256,masterKey:key,confirmReplaceCurrentDatabase:true});
  db=await AppDatabase.open(join(targetRoot,'data/perpay.sqlite3'),{masterKey:key});
  assert.equal(db.integrityCheck().ok,true); db.close();db=undefined;
  assert.deepEqual(compareReleaseContents(baseline,capture(join(targetRoot,'data/perpay.sqlite3'))),[]);
  assert.deepEqual(compareReleaseContents(baseline,capture(join(sourceRoot,'data/perpay.sqlite3'))),[]);
  writeFileSync(reportPath,JSON.stringify({backup,baseline,tables:Object.keys(baseline).length}),{flag:'wx',mode:0o600,flush:true});
  console.log(JSON.stringify({copied:true,comparedTables:Object.keys(baseline).length,backupSha256:backup.sha256}));
 }finally{db?.close();key.fill(0);}
}else if(mode==='verify'){
 const {baseline}=JSON.parse(readFileSync(reportPath,'utf8'));
 const oldDifferences=compareReleaseContents(baseline,capture(join(sourceRoot,'data/perpay.sqlite3')));
 const newDifferences=compareReleaseContents(baseline,capture(join(targetRoot,'data/perpay.sqlite3')));
 assert.deepEqual(oldDifferences,[], 'old release changed');
 assert.deepEqual(newDifferences,[], 'new release changed records');
 console.log(JSON.stringify({oldDatabasePreserved:true,newRecordsUnchanged:true,comparedTables:Object.keys(baseline).length}));
}else throw Error('unknown deployment helper mode');
'''


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def request(path):
    try:
        response = urllib.request.urlopen('http://127.0.0.1:16191' + path, timeout=5)
    except urllib.error.HTTPError as error:
        return error.code, error.read()
    with response:
        return response.status, response.read()


def healthy():
    for _ in range(25):
        try:
            status, body = request('/pay/healthz')
            if status == 200 and json.loads(body).get('status') == 'healthy':
                return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError('candidate health did not recover')


def write_unit(text):
    temporary = UNIT.with_suffix('.service.pending')
    with temporary.open('x') as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.chmod(0o644)
    os.replace(str(temporary), str(UNIT))
    subprocess.check_call(['systemctl', 'daemon-reload'])


def harden_tree(root, uid, gid, private=False):
    for directory, directories, files in os.walk(str(root)):
        os.chown(directory, uid, gid)
        os.chmod(directory, 0o700 if private else 0o755)
        for name in directories + files:
            path = Path(directory) / name
            require(str(path.resolve()).startswith(str(root.resolve()) + '/'), 'release symlink escapes its root')
            if path.is_symlink():
                continue
            os.chown(str(path), uid, gid)
            if path.is_file():
                path.chmod(0o600 if private else (0o755 if path.stat().st_mode & 0o111 else 0o644))


def configure_fa_invoices(unit: str, credential_path: str) -> str:
    """Install the provider while forcing every invoice execution switch closed."""
    require(unit.count('[Service]') == 1 and 'EnvironmentFile=' not in unit, 'unexpected service environment layout')
    values = {'PERPAY_TAX_INVOICE_PROVIDER': 'fa-piao', 'PERPAY_TAX_INVOICE_FAPIAO_CREDENTIAL_FILE': credential_path,
              'PERPAY_TAX_INVOICE_ENABLED': 'false', 'PERPAY_TAX_INVOICE_AUTO_SYNC_ENABLED': 'false', 'PERPAY_EPAY_INVOICE_ENABLED': 'false'}
    kept = []
    for line in unit.splitlines():
        matches = [key for key in values if re.search(r'\b' + key + r'=', line)]
        if matches:
            require(len(matches) == 1 and re.fullmatch(r'\s*Environment="?' + matches[0] + r'=[^\s"]+"?\s*', line) is not None,
                    'ambiguous invoice environment assignment')
            continue
        kept.append(line)
    block = '\n'.join('Environment="' + key + '=' + value + '"' for key, value in values.items())
    return '\n'.join(kept).replace('[Service]', '[Service]\n' + block, 1) + '\n'


def deploy(args):
    for value in [args.previous_app, args.target_app]:
        require(re.fullmatch(r'/opt/perpay-candidate-\d{8}[a-z]/app', value), 'invalid release path')
    for value in [args.source_root, args.target_root]:
        require(re.fullmatch(r'/var/lib/perpay-candidate-\d{8}[a-z]', value), 'invalid data path')
    for value in [args.source_app, args.previous_app, args.source_root]:
        require(str(Path(value).resolve()) == value and Path(value).is_dir(), 'source path is missing or indirect')
    require(re.fullmatch(r'/root/perpay-recovery-\d{8}-rc\d+/deployment-\d{8}[a-z]', args.recovery), 'invalid recovery path')
    target, target_root, recovery = Path(args.target_app), Path(args.target_root), Path(args.recovery)
    require(not target.parent.exists() and not target_root.exists() and not recovery.exists(), 'deployment paths already exist')
    unit = UNIT.read_text()
    required_paths = ['PERPAY_DATA_DIR=' + args.source_root + '/data', 'PERPAY_SECRETS_DIR=' + args.source_root + '/secrets',
                      'PERPAY_BACKUP_DIR=' + args.source_root + '/backups', 'ReadWritePaths=' + args.source_root]
    require(args.previous_app in unit and all(value in unit for value in required_paths), 'service paths differ from expected release')
    sync_unit = SYNC_UNIT.read_text()
    require(sync_unit.count(args.previous_app) == 2 and sync_unit.count(args.source_root) == 2, 'source synchronizer differs from active release')
    require('ReadOnlyPaths=' + args.source_root + '/secrets' in unit, 'master key directory must remain read-only')
    require('PERPAY_EPAY_GATEWAY_MODE=maintenance' in unit and 'PERPAY_EPAY_CALLBACK_DELIVERY=false' in unit, 'deployment requires maintenance and disabled callback delivery')
    require(subprocess.check_output(['systemctl', 'show', SERVICE, '-p', 'DropInPaths']).decode().strip() == 'DropInPaths=', 'unexpected service overrides')
    source_app = Path(args.source_app)
    fa_source = Path(args.fa_piao_credential_source) if getattr(args, 'fa_piao_credential_source', None) else None
    if fa_source:
        require(fa_source.is_file() and not fa_source.is_symlink() and fa_source.stat().st_size <= 8192 and fa_source.stat().st_mode & 0o077 == 0,
                'fa-piao credential source is not private or ordinary')
    require(re.fullmatch(r'1\.0\.0-rc\.\d+', args.expected_version), 'invalid expected version')
    require(json.loads((source_app / 'package.json').read_text())['version'] == args.expected_version, 'wrong candidate version')
    restore_report = json.loads((recovery.parent / 'release-restore.json').read_text())
    require(restore_report['newApp'] == args.source_app and restore_report['oldApp'] == args.previous_app and
            restore_report['oldReleaseRestored'] is True and restore_report['newSchema'] == args.expected_schema, 'restore rehearsal is missing')
    target.mkdir(parents=True, mode=0o755)
    target.parent.chmod(0o755)
    for name in ['dist', 'web-dist', 'static', 'node_modules', 'src', 'scripts']:
        shutil.copytree(str(source_app / name), str(target / name), symlinks=True)
    for name in ['package.json', 'package-lock.json']:
        shutil.copy2(str(source_app / name), str(target / name))
    harden_tree(target, 0, 0)
    recovery.mkdir(mode=0o700)
    (recovery / 'backups').mkdir(mode=0o700)
    (recovery / 'candidate-before.service').write_text(unit)
    (recovery / 'sync-before.service').write_text(sync_unit)
    helper = recovery / 'upgrade-copy.mjs'
    helper.write_text(HELPER)
    target_root.mkdir(mode=0o700)
    for name in ['data', 'backups']:
        (target_root / name).mkdir(mode=0o700)
    shutil.copytree(args.source_root + '/secrets', str(target_root / 'secrets'))
    if fa_source:
        shutil.copyfile(str(fa_source), str(target_root / 'secrets' / 'fa-piao.private.json'))
        (target_root / 'secrets' / 'fa-piao.private.json').chmod(0o600)
    owner = pwd.getpwnam('perpay-candidate')
    subprocess.check_call(['runuser', '-u', owner.pw_name, '--', NODE, '--check', str(target / 'dist/main.js')])
    subprocess.check_call(['runuser', '-u', owner.pw_name, '--', NODE, '-e', "import('./dist/http/app.js')"], cwd=str(target))
    helper_args = [NODE, str(helper), 'prepare', args.previous_app, args.target_app, args.source_root, args.target_root, args.recovery]
    timer_active = subprocess.check_output(['systemctl', 'show', SYNC_TIMER, '-p', 'ActiveState']).decode().strip() == 'ActiveState=active'
    stopped, installed, resume_sync = False, False, False
    try:
        subprocess.check_call(['systemctl', 'stop', SYNC_TIMER])
        subprocess.check_call(['systemctl', 'stop', SYNC_SERVICE])
        subprocess.check_call(['systemctl', 'stop', SERVICE])
        stopped = True
        require(subprocess.check_output(['systemctl', 'show', SERVICE, '-p', 'MainPID']).decode().strip() == 'MainPID=0', 'previous service still has a process')
        subprocess.check_call(helper_args)
        for suffix in ['', '-wal', '-shm', '-journal']:
            path = Path(args.source_root) / 'data' / ('perpay.sqlite3' + suffix)
            if path.exists():
                require(not path.is_symlink(), 'source database artifact is indirect')
                os.chown(str(path), owner.pw_uid, owner.pw_gid)
        harden_tree(target_root, owner.pw_uid, owner.pw_gid, private=True)
        require(UNIT.read_text() == unit, 'service changed concurrently')
        require(SYNC_UNIT.read_text() == sync_unit, 'synchronizer changed concurrently')
        installed = True
        SYNC_UNIT.write_text(sync_unit.replace(args.previous_app, args.target_app).replace(args.source_root, args.target_root))
        candidate_unit = unit.replace(args.previous_app, args.target_app).replace(args.source_root, args.target_root)
        if fa_source:
            candidate_unit = configure_fa_invoices(candidate_unit, args.target_root + '/secrets/fa-piao.private.json')
        write_unit(candidate_unit)
        subprocess.check_call(['systemctl', 'start', SERVICE])
        healthy()
        status, body = request('/pay/epay/readyz')
        readiness = json.loads(body)
        require(status == 503 and readiness['code'] == 'epay_maintenance' and readiness['configurationReady'] is True, 'gateway maintenance/configuration check failed')
        status, html = request('/pay/admin/merchant-workspace')
        require(status == 200 and b'perpay-admin-base' in html, 'merchant workspace unavailable')
        assets = sorted(set(re.findall(r'(?:src|href)="(/pay/admin/[^"?]+)', html.decode())))
        require(assets, 'workspace assets missing')
        for asset in assets:
            code, body = request(asset)
            require(code == 200 and body, 'workspace asset is unavailable')
        require(request('/pay/api/merchant/epay/ledger-adjustments?merchantId=probe')[0] == 401, 'unauthenticated ledger access accepted')
        helper_args[2] = 'verify'
        subprocess.check_call(helper_args)
        report = {'deployed': True, 'version': args.expected_version, 'schema': args.expected_schema, 'codeRoot': args.target_app, 'dataRoot': args.target_root, 'previousCodeRoot': args.previous_app, 'previousDataRoot': args.source_root, 'maintenance': True, 'oldDatabasePreserved': True, 'financialRecordsUnchanged': True, 'checkedAssets': len(assets), 'productionCutover': False, 'completedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        with (recovery / 'deployment.json').open('x') as handle:
            json.dump(report, handle)
        print(json.dumps(report))
        resume_sync = True
    except BaseException:
        if installed:
            subprocess.check_call(['systemctl', 'stop', SERVICE])
            # Never discard records created after startup, even in maintenance.
            helper_args[2] = 'verify'
            subprocess.check_call(helper_args)
            SYNC_UNIT.write_text(sync_unit)
            write_unit(unit)
        if stopped:
            for suffix in ['', '-wal', '-shm', '-journal']:
                path = Path(args.source_root) / 'data' / ('perpay.sqlite3' + suffix)
                if path.exists() and not path.is_symlink():
                    os.chown(str(path), owner.pw_uid, owner.pw_gid)
            subprocess.check_call(['systemctl', 'start', SERVICE])
            healthy()
            resume_sync = True
        raise
    finally:
        if timer_active and resume_sync:
            subprocess.check_call(['systemctl', 'start', SYNC_TIMER])


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ['source-app', 'previous-app', 'source-root', 'target-app', 'target-root', 'recovery']:
        parser.add_argument('--' + flag, required=True)
    parser.add_argument('--expected-version', required=True)
    parser.add_argument('--expected-schema', required=True, type=int)
    parser.add_argument('--fa-piao-credential-source')
    deploy(parser.parse_args())
