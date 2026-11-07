"""Replace candidate code while retaining maintenance, data and rollback files."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import time
import urllib.error
import urllib.request

NODE = '/opt/perpay-candidate-20261104a/runtime/bin/node'
UNIT = Path('/etc/systemd/system/perpay-candidate.service')
SYNC_UNIT = Path('/etc/systemd/system/perpay-legacy-sync.service')
SYNC_TIMER = 'perpay-legacy-sync.timer'
SYNC_SERVICE = 'perpay-legacy-sync.service'
SERVICE = 'perpay-candidate.service'
TESTS = ['epay-merchant-ledger-audit', 'epay-merchant-workspace', 'epay-main-merchant-console',
         'epay-merchant-key-console', 'epay-live-balance', 'epay-balance-admin-http',
         'epay-merchant-members',
         'epay-workspace-mount', 'epay-combined-balance', 'epay-legacy-balance-audit',
         'epay-imported-timestamp-repair', 'epay-mysql-config',
         'epay-gateway-readiness', 'epay-gateway-mount', 'epay-configured-channels',
         'epay-confirmation-audit', 'epay-confirm-delivery-integration',
         'epay-isolated-gateway-runtime', 'epay-alipay-query-account',
         'epay-alipay-query-confirmation', 'epay-alipay-precreate', 'epay-isolated-alipay-client']
TESTS += ['checkpoint-candidate-release', 'release-restore-fingerprint', 'epay-main-order-routes', 'epay-main-order-access',
          'epay-refund-workflow', 'epay-refund-provider', 'epay-main-delta-store']
TESTS += ['epay-wechat-native-client', 'epay-alipay-web', 'epay-api-actions', 'epay-key-rotation', 'epay-settlement-workflow', 'epay-merchant-enrollment']
TESTS += ['epay-merchant-profile', 'epay-merchant-management', 'epay-history-migration']
TESTS += ['epay-wechat-close', 'epay-wechat-observation', 'epay-wechat-readonly-order-query']
TESTS += ['epay-portal', 'base-path-http']
TESTS += ['epay-portal-permissions', 'epay-wechat-credential-admin']
TESTS += ['display-settings', 'created-dates-export', 'site-orders']


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def request(path):
    with urllib.request.urlopen('http://127.0.0.1:16191' + path, timeout=5) as response:
        return response.read()


def healthy():
    for _ in range(20):
        try:
            if json.loads(request('/pay/healthz'))['status'] == 'healthy':
                return
        except (OSError, ValueError, KeyError):
            time.sleep(1)
    raise RuntimeError('candidate health check did not pass')


def deployment_storage(data_root, recovery_root, unit):
    require(re.fullmatch(r'/var/lib/perpay-candidate-\d{8}[a-z]', data_root), 'invalid data root')
    require(re.fullmatch(r'/root/perpay-recovery-\d{8}(?:-rc\d+)?', recovery_root), 'invalid recovery root')
    for folder, variable in [('data', 'PERPAY_DATA_DIR'), ('secrets', 'PERPAY_SECRETS_DIR'), ('backups', 'PERPAY_BACKUP_DIR')]:
        expected = variable + '=' + data_root + '/' + folder
        require(len(re.findall(r'(?<![A-Z_])' + re.escape(expected) + r'(?=[\s\"]|$)', unit)) == 1,
                'service storage does not match explicit data root')
    return data_root + '/data/perpay.sqlite3', Path(recovery_root)


def financial_state(database):
    script = '''
const {DatabaseSync}=require('node:sqlite');
const {createHash}=require('node:crypto');
const db=new DatabaseSync(process.argv[1],{readOnly:true});
try {
 db.exec('BEGIN');
 const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'epay_*' ORDER BY name").all();
 const summary={};
 for(const {name} of tables){
  if(!/^epay_[a-z0-9_]+$/.test(name)) throw Error('invalid protected table name');
  const query=db.prepare('SELECT * FROM '+name); query.setReadBigInts(true);
  const rows=query.all().map(row=>JSON.stringify(row,(_,v)=>typeof v==='bigint'?v.toString():v)).sort();
  summary[name]={count:rows.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};
 }
 db.exec('COMMIT'); console.log(JSON.stringify(summary));
}finally{db.close();}
'''
    return json.loads(subprocess.check_output([NODE, '-e', script, database]))


def write_service(path, content):
    temporary = path.with_suffix('.service.pending')
    with temporary.open('x') as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.chmod(0o644)
    os.replace(str(temporary), str(path))


def activate_release(unit, sync_unit, candidate_unit, candidate_sync, checkpoint, verify):
    timer_was_active = subprocess.check_output(['systemctl', 'show', SYNC_TIMER, '-p', 'ActiveState']).decode().strip() == 'ActiveState=active'
    stopped, installed, resume_sync = False, False, False
    try:
        subprocess.check_call(['systemctl', 'stop', SYNC_TIMER])
        subprocess.check_call(['systemctl', 'stop', SYNC_SERVICE])
        require(UNIT.read_text() == unit and SYNC_UNIT.read_text() == sync_unit, 'service changed concurrently')
        subprocess.check_call(['systemctl', 'stop', SERVICE])
        stopped = True
        baseline = checkpoint()
        installed = True
        write_service(SYNC_UNIT, candidate_sync)
        write_service(UNIT, candidate_unit)
        subprocess.check_call(['systemctl', 'daemon-reload'])
        subprocess.check_call(['systemctl', 'start', SERVICE])
        healthy()
        report = verify(baseline)
        resume_sync = True
        return report
    except BaseException:
        if installed:
            subprocess.check_call(['systemctl', 'stop', SERVICE])
            write_service(SYNC_UNIT, sync_unit)
            write_service(UNIT, unit)
            subprocess.check_call(['systemctl', 'daemon-reload'])
        if stopped:
            # Same-schema rollback keeps every database write, including late records.
            subprocess.check_call(['systemctl', 'start', SERVICE])
            healthy()
            resume_sync = True
        raise
    finally:
        if timer_was_active and resume_sync:
            subprocess.check_call(['systemctl', 'start', SYNC_TIMER])


def deploy(args):
    old, target = str(Path(args.previous)), str(Path(args.target))
    for root in [old, target]:
        require(re.fullmatch(r'/opt/perpay-candidate-\d{8}[a-z]/app', root), 'invalid candidate root')
    require(old != target and not Path(target).exists(), 'target must be a new release directory')
    require(re.fullmatch(r'[a-z0-9-]+', args.release), 'invalid release name')
    unit = UNIT.read_text()
    sync_unit = SYNC_UNIT.read_text()
    require(sync_unit.count(old) == 2 and args.data_root in sync_unit, 'source synchronizer differs from active release')
    database, recovery = deployment_storage(args.data_root, args.recovery_root, unit)
    require(Path(database).is_file() and recovery.is_dir(), 'deployment storage is missing')
    archive = recovery / (args.release + '.tar.gz')
    require(re.fullmatch(r'[a-f0-9]{64}', args.sha256), 'invalid release digest')
    require(hashlib.sha256(archive.read_bytes()).hexdigest() == args.sha256, 'release digest mismatch')
    require(old in unit and 'PERPAY_EPAY_GATEWAY_MODE=maintenance' in unit and
            'PERPAY_EPAY_CALLBACK_DELIVERY=false' in unit, 'candidate must remain in maintenance')
    backup = recovery / ('candidate-before-' + args.release + '.service')
    report_path = recovery / (args.release + '-deploy.json')
    checkpoint_root = recovery / (args.release + '-checkpoint')
    require(not backup.exists() and not report_path.exists() and not checkpoint_root.exists(), 'release evidence already exists')
    require(subprocess.check_output(['systemctl', 'show', SERVICE, '-p', 'DropInPaths']).decode().strip() == 'DropInPaths=', 'unexpected service overrides')
    shutil.copytree(old, target, symlinks=True)
    Path(target).parent.chmod(0o755)
    with tarfile.open(str(archive)) as bundle:
        for member in bundle.getmembers():
            path = os.path.realpath(os.path.join(target, member.name))
            require(path.startswith(target + '/') and (member.isdir() or member.isfile()), 'unsafe release member')
            require(any(member.name == prefix or member.name.startswith(prefix + '/')
                        for prefix in ['dist', 'src', 'test', 'web-dist', 'static', 'scripts', 'package.json', 'package-lock.json']), 'unexpected release member')
            member.mode = 0o755 if member.isdir() else 0o644
        bundle.extractall(target)
    subprocess.check_call([NODE, '--experimental-strip-types', '--test'] +
                          ['test/' + name + '.test.ts' for name in TESTS], cwd=target)
    subprocess.check_call(['runuser', '-u', 'perpay-candidate', '--', NODE, '--check', target + '/dist/main.js'])
    subprocess.check_call(['runuser', '-u', 'perpay-candidate', '--', NODE, '-e', "import('./dist/http/app.js')"], cwd=target)
    version_script = "const {DATABASE_COMPATIBILITY}=await import(process.argv[1]); console.log(JSON.stringify(DATABASE_COMPATIBILITY));"
    old_schema = json.loads(subprocess.check_output([NODE, '--input-type=module', '-e', version_script, old + '/dist/version.js']))
    new_schema = json.loads(subprocess.check_output([NODE, '--input-type=module', '-e', version_script, target + '/dist/version.js']))
    require(old_schema == new_schema, 'code-only deployment cannot change database compatibility')
    require(Path(old + '/package-lock.json').read_bytes() == Path(target + '/package-lock.json').read_bytes(), 'code-only deployment cannot change dependencies')
    candidate_unit = unit.replace(old, target)
    invoice_setting = 'Environment=PERPAY_EPAY_INVOICE_ENABLED=false'
    require('PERPAY_EPAY_INVOICE_ENABLED=' not in candidate_unit or invoice_setting in candidate_unit, 'invoice switch is unexpected')
    if invoice_setting not in candidate_unit:
        candidate_unit = candidate_unit.replace('[Service]\n', '[Service]\n' + invoice_setting + '\n')
    if args.main_bridge:
        require(args.main_bridge == '/etc/helstera/lightpay-bridge.secret', 'unexpected main bridge source')
        bridge_source = Path(args.main_bridge)
        require(bridge_source.is_file() and not bridge_source.is_symlink(), 'main bridge source is not an ordinary file')
        bridge_bytes = bridge_source.read_bytes()
        require(32 <= len(bridge_bytes.strip()) <= 4096 and not re.search(rb'[\x00-\x20\x7f]', bridge_bytes.strip()), 'main bridge secret is invalid')
        bridge_target = Path(args.data_root) / 'secrets' / 'main-bridge.secret'
        require(not bridge_target.is_symlink(), 'main bridge destination is indirect')
        if bridge_target.exists():
            require(bridge_target.read_bytes() == bridge_bytes, 'main bridge secret differs')
        else:
            with bridge_target.open('xb') as handle:
                handle.write(bridge_bytes)
                handle.flush()
                os.fsync(handle.fileno())
        owner = bridge_target.parent.stat()
        os.chown(str(bridge_target), owner.st_uid, owner.st_gid)
        bridge_target.chmod(0o600)
        bridge_setting = 'Environment=PERPAY_EPAY_MAIN_BRIDGE_SECRET_FILE=' + str(bridge_target)
        require('PERPAY_EPAY_MAIN_BRIDGE_SECRET_FILE=' not in candidate_unit or bridge_setting in candidate_unit, 'main bridge service path differs')
        if bridge_setting not in candidate_unit:
            candidate_unit = candidate_unit.replace('[Service]\n', '[Service]\n' + bridge_setting + '\n')
    if args.alipay_certificate:
        require(args.alipay_certificate == '/etc/helstera/alipay/app_public_cert.crt', 'unexpected Alipay certificate source')
        cert_path = Path(args.data_root) / 'secrets' / 'alipay-account.crt'
        require(not cert_path.is_symlink(), 'certificate target cannot be a symlink')
        source_bytes = Path(args.alipay_certificate).read_bytes()
        if cert_path.exists():
            require(cert_path.read_bytes() == source_bytes, 'stored Alipay certificate differs')
        else:
            with cert_path.open('xb') as handle:
                handle.write(source_bytes)
                handle.flush()
                os.fsync(handle.fileno())
            owner = (Path(args.data_root) / 'secrets').stat()
            os.chown(str(cert_path), owner.st_uid, owner.st_gid)
            cert_path.chmod(0o600)
        setting = 'Environment=PERPAY_EPAY_ALIPAY_CERTIFICATE_FILE=' + str(cert_path)
        require('PERPAY_EPAY_ALIPAY_CERTIFICATE_FILE=' not in candidate_unit or setting in candidate_unit, 'certificate service path differs')
        if setting not in candidate_unit:
            candidate_unit = candidate_unit.replace('Environment=PERPAY_EPAY_ALIPAY_CHANNEL_ID=1\n', 'Environment=PERPAY_EPAY_ALIPAY_CHANNEL_ID=1\n' + setting + '\n')
        require(setting in candidate_unit, 'Alipay certificate setting was not inserted')
    with backup.open('x') as handle:
        handle.write(unit)
    with (recovery / ('sync-before-' + args.release + '.service')).open('x') as handle:
        handle.write(sync_unit)
    def checkpoint():
        checkpoint_root.mkdir(mode=0o700)
        shutil.copytree(args.data_root + '/secrets', str(checkpoint_root / 'secrets'))
        shutil.copy2(str(backup), str(checkpoint_root / 'candidate.service'))
        shutil.copy2(str(recovery / ('sync-before-' + args.release + '.service')), str(checkpoint_root / 'sync.service'))
        baseline = financial_state(database)
        try:
            subprocess.check_call([NODE, '--experimental-strip-types', target + '/scripts/checkpoint-candidate-release.ts',
                                   old, target, args.data_root, str(checkpoint_root)])
        finally:
            owner = (Path(args.data_root) / 'data').stat()
            # Root's read-only backup may create SQLite shared-memory sidecars.
            for suffix in ['', '-wal', '-shm', '-journal']:
                artifact = Path(database + suffix)
                if artifact.exists():
                    require(not artifact.is_symlink(), 'database artifact is indirect')
                    os.chown(str(artifact), owner.st_uid, owner.st_gid)
        require(baseline == financial_state(database), 'candidate changed while writers were stopped')
        return baseline

    def verify(before):
        html = request('/pay/admin/merchant-workspace').decode()
        require('perpay-admin-base' in html, 'console HTML is unavailable')
        assets = sorted(set(re.findall(r'(?:src|href)="(/pay/admin/[^"?]+)', html)))
        require(len(assets) > 0, 'console assets are missing')
        for asset in assets:
            require(request(asset), 'empty asset: ' + asset)
        try:
            request('/pay/epay/readyz')
            raise RuntimeError('gateway unexpectedly admitted orders')
        except urllib.error.HTTPError as error:
            state = json.loads(error.read())
            require(error.code == 503 and state.get('code') == 'epay_maintenance' and state.get('configurationReady') is True, 'gateway maintenance check failed')
        try:
            request('/pay/api/merchant/epay/ledger-adjustments?merchantId=probe')
            raise RuntimeError('unauthenticated audit request was accepted')
        except urllib.error.HTTPError as error:
            require(error.code == 401, 'unexpected audit authorization status')
        after = financial_state(database)
        require(before == after, 'protected financial records changed')
        report = {'deployed': True, 'codeRoot': target, 'dataRoot': args.data_root, 'archiveSha256': args.sha256,
                  'maintenance': True, 'financialTablesUnchanged': True,
                  'protectedTables': len(after), 'checkedAssets': len(assets),
                  'productionCutover': False, 'alipayCertificateConfigured': bool(args.alipay_certificate),
                  'databaseCompatibility': new_schema, 'syncCodeRoot': target, 'protectedState': after,
                  'checkpoint': str(checkpoint_root), 'restoreVerified': True,
                  'mainBridgeConfigured': bool(args.main_bridge), 'invoiceEnabled': False,
                  'completedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        with report_path.open('x') as handle:
            json.dump(report, handle)
        return report

    report = activate_release(unit, sync_unit, candidate_unit, sync_unit.replace(old, target), checkpoint, verify)
    print(json.dumps({key: value for key, value in report.items() if key != 'protectedState'}))


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ['previous', 'target', 'release', 'sha256', 'data-root', 'recovery-root']:
        parser.add_argument('--' + flag, required=True)
    parser.add_argument('--alipay-certificate')
    parser.add_argument('--main-bridge')
    deploy(parser.parse_args())
