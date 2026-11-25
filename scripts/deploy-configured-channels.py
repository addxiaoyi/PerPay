"""Provision a new maintenance candidate while retaining the old database and unit."""
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import time
import urllib.request

NODE = '/opt/perpay-candidate-20261104a/runtime/bin/node'
APP = '/opt/perpay-candidate-20261104c/app'
OLD_APP = '/opt/perpay-candidate-20261104b/app'
OLD_ROOT = Path('/var/lib/perpay-candidate-20261104c')
NEW_ROOT = Path('/var/lib/perpay-candidate-20261104d')
RECOVERY = Path('/root/perpay-recovery-20261104')
UNIT = Path('/etc/systemd/system/perpay-candidate.service')


def node(script):
    return subprocess.check_output([NODE, '--input-type=module'], input=script.encode(), cwd=APP).decode().strip()


def finance(root):
    script = '''
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
const db=new DatabaseSync(PATH,{readOnly:true});
const tables=['epay_merchant_accounts','epay_merchant_bindings','epay_orders','epay_balance_ledger','epay_callback_jobs','epay_notify_logs','epay_invoices','epay_invoice_applications'];
const report={};
for(const table of tables){
 const rows=db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
 report[table]={count:rows.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};
}
db.close();console.log(JSON.stringify(report));
'''.replace('PATH', json.dumps(str(root / 'data/perpay.sqlite3')))
    return json.loads(node(script))


def seal(root, name):
    script = '''
import {readFileSync,writeFileSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {sealLiveState} from './dist/epay-compat/live-state-envelope.js';
import {writeLiveStateArchive} from './dist/epay-compat/live-state-archive.js';
const plain=readFileSync(SOURCE),recipient=readFileSync('/root/perpay-recovery-20261104/recovery-public.pem','utf8');
try{
 const fingerprint=JSON.parse(readFileSync('/root/perpay-recovery-20261104/recipient.json','utf8')).fingerprint;
 const snapshotId=randomBytes(16).toString('hex');
 const archive=writeLiveStateArchive(DESTINATION,sealLiveState(plain,recipient,snapshotId,fingerprint));
 const manifest={version:1,snapshotId,archiveSha256:archive.sha256,archiveBytes:archive.bytes,sourceSha256:createHash('sha256').update(plain).digest('hex'),sourceBytes:plain.length,capturedAt:new Date().toISOString()};
 writeFileSync(DESTINATION+'.manifest.json',JSON.stringify(manifest),{flag:'wx',mode:0o600,flush:true});
 console.log(JSON.stringify(manifest));
}finally{plain.fill(0);}
'''.replace('SOURCE', json.dumps(str(root / 'data/perpay.sqlite3'))).replace('DESTINATION', json.dumps(str(RECOVERY / name)))
    return json.loads(node(script))


def healthy():
    for _ in range(20):
        try:
            with urllib.request.urlopen('http://127.0.0.1:16191/pay/healthz', timeout=2) as response:
                if response.status == 200:
                    return
        except OSError:
            time.sleep(1)
    raise RuntimeError('candidate did not become healthy')


os.umask(0o077)
previous = UNIT.read_text()
assert OLD_APP in previous and str(OLD_ROOT) in previous
assert 'PERPAY_EPAY_GATEWAY_MODE=maintenance' in previous
assert 'PERPAY_EPAY_CALLBACK_DELIVERY=false' in previous
assert not NEW_ROOT.exists()
backup_unit = RECOVERY / 'candidate-before-channel-provision.service'
with backup_unit.open('x') as handle:
    handle.write(previous)
subprocess.check_call(['systemctl', 'stop', 'perpay-candidate.service'])
try:
    before = finance(OLD_ROOT)
    backup = seal(OLD_ROOT, 'candidate-pre-channels.json')
    shutil.copytree(str(OLD_ROOT), str(NEW_ROOT))
    subprocess.check_call([NODE, '--experimental-strip-types', 'scripts/provision-configured-channels.ts',
                           str(NEW_ROOT / 'data/perpay.sqlite3'), str(NEW_ROOT / 'secrets/master-key'),
                           '/www/wwwroot/starmc-api/data/store.json', 'deployment:configured-channels'], cwd=APP)
    after = finance(NEW_ROOT)
    if before != after:
        raise RuntimeError('channel provisioning changed historical finance')
    provisioned_backup = seal(NEW_ROOT, 'candidate-configured-channels.json')
    account = pwd.getpwnam('perpay-candidate')
    for directory, subdirs, files in os.walk(str(NEW_ROOT)):
        os.chown(directory, account.pw_uid, account.pw_gid)
        for filename in files:
            os.chown(os.path.join(directory, filename), account.pw_uid, account.pw_gid)
    updated = previous.replace(OLD_APP, APP).replace(str(OLD_ROOT), str(NEW_ROOT))
    updated = updated.replace('Environment=PERPAY_EPAY_ALIPAY_CHANNEL_ID=1\n',
                              'Environment=PERPAY_EPAY_ALIPAY_CHANNEL_ID=1\nEnvironment=PERPAY_EPAY_WECHAT_CREDENTIAL_ID=channel-2-platform\nEnvironment=PERPAY_EPAY_WECHAT_SIGNING_KEY_ID=channel-2-signing\n')
    UNIT.write_text(updated)
    subprocess.check_call(['systemctl', 'daemon-reload'])
    subprocess.check_call(['systemctl', 'start', 'perpay-candidate.service'])
    healthy()
    report = {'deployed': True, 'maintenance': True, 'historyUnchanged': before == after,
              'historicalCounts': {table: counts['count'] for table, counts in after.items()},
              'preBackupSha256': backup['archiveSha256'], 'provisionedBackupSha256': provisioned_backup['archiveSha256'],
              'financialTableHashes': after, 'app': APP, 'dataRoot': str(NEW_ROOT)}
    with (RECOVERY / 'configured-channels-deploy.json').open('x') as handle:
        json.dump(report, handle)
    print(json.dumps(report))
except BaseException:
    subprocess.run(['systemctl', 'stop', 'perpay-candidate.service'], check=False)
    UNIT.write_text(previous)
    subprocess.check_call(['systemctl', 'daemon-reload'])
    subprocess.check_call(['systemctl', 'start', 'perpay-candidate.service'])
    healthy()
    print(json.dumps({'deployed': False, 'previousCandidateRestored': True}))
    raise
