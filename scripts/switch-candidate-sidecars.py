"""Point the legacy source synchronizer at the active candidate release and data root."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

UNIT = Path('/etc/systemd/system/perpay-legacy-sync.service')
TIMER = 'perpay-legacy-sync.timer'
SERVICE = 'perpay-legacy-sync.service'
NODE = '/opt/perpay-candidate-20261104a/runtime/bin/node'


def financial_state(database):
    script = r'''
const {DatabaseSync}=require('node:sqlite');
const {createHash}=require('node:crypto');
const db=new DatabaseSync(process.argv[1],{readOnly:true});
try {
 db.exec('BEGIN');
 const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'epay_*' ORDER BY name").all();
 const state={};
 for(const {name} of tables){
  const query=db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"'); query.setReadBigInts(true);
  const rows=query.all().map(row=>JSON.stringify(row,(_,value)=>typeof value==='bigint'?value.toString():value)).sort();
  state[name]={count:rows.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};
 }
 db.exec('COMMIT'); console.log(JSON.stringify(state));
}finally{db.close();}
'''
    return json.loads(subprocess.check_output([NODE, '-e', script, database], universal_newlines=True))


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def write_unit(text):
    pending = UNIT.with_suffix('.service.pending')
    with pending.open('x') as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    pending.chmod(0o644)
    os.replace(str(pending), str(UNIT))
    subprocess.check_call(['systemctl', 'daemon-reload'])


def show(name):
    return subprocess.check_output(['systemctl', 'show', name, '-p', 'ActiveState', '-p', 'Result', '-p', 'ExecMainStatus', '-p', 'ExecStart', '--no-pager'], universal_newlines=True)


def switch(args):
    old_app = Path(args.old_app)
    new_app = Path(args.new_app)
    old_root = Path(args.old_root)
    new_root = Path(args.new_root)
    recovery = Path(args.recovery)
    require(re.fullmatch(r'/opt/perpay-candidate-\d{8}[a-z]/app', str(old_app)), 'old app path is invalid')
    require(re.fullmatch(r'/opt/perpay-candidate-\d{8}[a-z]/app', str(new_app)), 'new app path is invalid')
    require(re.fullmatch(r'/var/lib/perpay-candidate-\d{8}[a-z]', str(old_root)), 'old data path is invalid')
    require(re.fullmatch(r'/var/lib/perpay-candidate-\d{8}[a-z]', str(new_root)), 'new data path is invalid')
    require(old_app.is_dir() and new_app.is_dir() and old_root.is_dir() and new_root.is_dir(), 'release or data root is missing')
    require(re.fullmatch(r'/root/perpay-recovery-\d{8}-rc4/sidecars(?:-\d+)?', str(recovery)), 'recovery path is invalid')
    require(not recovery.exists(), 'sidecar recovery path already exists')
    before = UNIT.read_text()
    require(before.count(str(old_app)) == 2 and before.count(str(old_root)) == 2, 'sidecar unit differs from the expected old candidate')
    require('perpay-legacy-sync.lock' in before and '--running' in before, 'unexpected source sync unit')
    recovery.mkdir(mode=0o700)
    (recovery / 'legacy-sync-before.service').write_text(before)
    sync_source = old_app / 'scripts' / 'sync-legacy-sources.ts'
    sync_target = new_app / 'scripts' / 'sync-legacy-sources.ts'
    require(sync_source.is_file(), 'legacy synchronization script is missing from old release')
    if not sync_target.exists():
        sync_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(sync_source), str(sync_target))
    require(hashlib.sha256(sync_source.read_bytes()).hexdigest() == hashlib.sha256(sync_target.read_bytes()).hexdigest(), 'legacy synchronization script differs between releases')
    before_financial = financial_state(str(new_root / 'data' / 'perpay.sqlite3'))
    timer_was_active = 'ActiveState=active' in subprocess.check_output(['systemctl', 'show', TIMER, '-p', 'ActiveState'], universal_newlines=True)
    service_was_active = 'ActiveState=active' in subprocess.check_output(['systemctl', 'show', SERVICE, '-p', 'ActiveState'], universal_newlines=True)
    try:
        subprocess.check_call(['systemctl', 'stop', TIMER])
        subprocess.check_call(['systemctl', 'stop', SERVICE])
        after = before.replace(str(old_app), str(new_app)).replace(str(old_root), str(new_root))
        require(after != before and str(new_app) in after and str(new_root) in after, 'sidecar replacement produced no change')
        write_unit(after)
        require(str(new_app) in UNIT.read_text() and str(new_root) in UNIT.read_text(), 'sidecar unit publication failed')
        subprocess.check_call(['systemctl', 'start', SERVICE])
        result = show(SERVICE)
        require('ActiveState=inactive' in result and 'Result=success' in result and 'ExecMainStatus=0' in result, 'source synchronization did not succeed')
        if timer_was_active:
            subprocess.check_call(['systemctl', 'start', TIMER])
        metadata = subprocess.check_output([
            '/opt/perpay-candidate-20261104a/runtime/bin/node', '-e',
            "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1],{readOnly:true}); const row=db.prepare(\"SELECT value FROM system_metadata WHERE key='epay_source_sync'\").get(); console.log(row?.value ?? 'missing'); db.close();",
            str(new_root / 'data/perpay.sqlite3'),
        ], universal_newlines=True).strip()
        parsed = json.loads(metadata)
        require(parsed.get('version') == 1 and parsed.get('ok') is True, 'candidate source sync marker is not healthy')
        after_financial = financial_state(str(new_root / 'data' / 'perpay.sqlite3'))
        require(before_financial == after_financial, 'source synchronization changed protected financial records')
        report = {'switched': True, 'service': SERVICE, 'timerRestored': timer_was_active, 'sourceSyncStatus': parsed, 'oldUnitPreserved': True, 'financialRecordsUnchanged': True, 'financialTables': len(after_financial), 'syncScriptSha256': hashlib.sha256(sync_target.read_bytes()).hexdigest(), 'activeApp': str(new_app), 'activeDataRoot': str(new_root), 'completedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        (recovery / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report))
    except BaseException:
        write_unit(before)
        subprocess.call(['systemctl', 'stop', SERVICE])
        if timer_was_active:
            subprocess.call(['systemctl', 'start', TIMER])
        if service_was_active:
            subprocess.call(['systemctl', 'start', SERVICE])
        raise


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ['old-app', 'new-app', 'old-root', 'new-root', 'recovery']:
        parser.add_argument('--' + flag, required=True)
    switch(parser.parse_args())
