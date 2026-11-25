"""Upgrade the maintenance candidate and verify protected financial tables."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request

NODE = '/opt/perpay-candidate-20261104a/runtime/bin/node'
OLD = '/opt/perpay-candidate-20261104e/app'
TARGET = '/opt/perpay-candidate-20261104f/app'
DATABASE = '/var/lib/perpay-candidate-20261104d/data/perpay.sqlite3'
RECOVERY = Path('/root/perpay-recovery-20261104')
UNIT = Path('/etc/systemd/system/perpay-candidate.service')
ARCHIVE = RECOVERY / 'combined-balance-20261104.tar.gz'


def request(path):
    with urllib.request.urlopen('http://127.0.0.1:16191' + path, timeout=5) as response:
        return response.read().decode()


def healthy():
    for _ in range(20):
        try:
            if json.loads(request('/pay/healthz'))['status'] == 'healthy':
                return
        except OSError:
            time.sleep(1)
    raise RuntimeError('candidate did not become healthy')


def protected_state():
    script = '''
const {DatabaseSync}=require('node:sqlite');
const {createHash}=require('node:crypto');
const db=new DatabaseSync(process.argv[1],{readOnly:true});
try {
 db.exec('BEGIN');
 const tables=['epay_merchant_accounts','epay_merchant_bindings','epay_orders','epay_balance_ledger','epay_callback_jobs','epay_callback_attempts','epay_notify_logs','epay_invoices','epay_invoice_applications','epay_main_order_sources','epay_main_ledger_sources'];
 const summary={};
 for(const table of tables){const rows=db.prepare('SELECT * FROM '+table).all().map(row=>JSON.stringify(row)).sort();summary[table]={count:rows.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};}
 db.exec('COMMIT');
 console.log(JSON.stringify(summary));
}finally{db.close();}
'''
    return json.loads(subprocess.check_output([NODE, '-e', script, DATABASE]).decode())


os.umask(0o077)
digest = sys.argv[1] if len(sys.argv) == 2 else ''
assert len(digest) == 64 and hashlib.sha256(ARCHIVE.read_bytes()).hexdigest() == digest
assert not Path(TARGET).exists()
unit = UNIT.read_text()
assert OLD in unit and 'PERPAY_EPAY_GATEWAY_MODE=maintenance' in unit
assert 'PERPAY_EPAY_CALLBACK_DELIVERY=false' in unit
before = protected_state()
shutil.copytree(OLD, TARGET, symlinks=True)
Path(TARGET).parent.chmod(0o755)
with tarfile.open(str(ARCHIVE)) as archive:
    for member in archive.getmembers():
        path = os.path.realpath(os.path.join(TARGET, member.name))
        assert path.startswith(TARGET + '/') and not member.issym() and not member.islnk()
    archive.extractall(TARGET)
subprocess.check_call([NODE, '--experimental-strip-types', '--test', 'test/epay-combined-balance.test.ts', 'test/epay-legacy-balance-audit.test.ts', 'test/epay-main-merchant-console.test.ts', 'test/epay-workspace-mount.test.ts'], cwd=TARGET)
subprocess.check_call(['runuser', '-u', pwd.getpwuid(991).pw_name, '--', NODE, '--check', TARGET + '/dist/main.js'])
with (RECOVERY / 'candidate-before-combined-balance.service').open('x') as handle:
    handle.write(unit)
try:
    UNIT.write_text(unit.replace(OLD, TARGET))
    subprocess.check_call(['systemctl', 'daemon-reload'])
    subprocess.check_call(['systemctl', 'restart', 'perpay-candidate.service'])
    healthy()
    assert 'perpay-admin-base' in request('/pay/admin/merchant-workspace')
    after = protected_state()
    assert before == after, 'protected financial state changed'
    report = {'deployed': True, 'codeRoot': TARGET, 'archiveSha256': digest, 'protectedState': after, 'financialTablesUnchanged': True, 'productionCutover': False}
    with (RECOVERY / 'combined-balance-deploy.json').open('x') as handle:
        json.dump(report, handle)
    print(json.dumps({'deployed': True, 'codeRoot': TARGET, 'financialTablesUnchanged': True, 'protectedTables': len(after), 'productionCutover': False}))
except BaseException:
    UNIT.write_text(unit)
    subprocess.check_call(['systemctl', 'daemon-reload'])
    subprocess.check_call(['systemctl', 'restart', 'perpay-candidate.service'])
    healthy()
    print(json.dumps({'deployed': False, 'previousCandidateRestored': True, 'financialTablesUnchanged': protected_state() == before}))
    raise
