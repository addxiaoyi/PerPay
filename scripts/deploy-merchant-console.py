"""Deploy the read-only main-account console with rollback of code and ingress."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import tarfile
import time
import urllib.request

NODE = '/opt/perpay-candidate-20261104a/runtime/bin/node'
OLD = '/opt/perpay-candidate-20261104c/app'
TARGET = '/opt/perpay-candidate-20261104e/app'
RECOVERY = Path('/root/perpay-recovery-20261104')
UNIT = Path('/etc/systemd/system/perpay-candidate.service')
PROXY = Path('/www/server/panel/vhost/nginx/extension/star-web.top/perpay-candidate-workspace.conf')
NGINX = '/www/server/nginx/sbin/nginx'
ARCHIVE = RECOVERY / 'merchant-console-20261104b.tar.gz'


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


os.umask(0o077)
assert hashlib.sha256(ARCHIVE.read_bytes()).hexdigest() == '9ce96e47f88932c5f2101c759571a6610133c0605e75b5c0bc64f7c72388d626'
assert not Path(TARGET).exists()
unit = UNIT.read_text()
proxy = PROXY.read_text()
assert OLD in unit and 'PERPAY_EPAY_GATEWAY_MODE=maintenance' in unit
assert 'PERPAY_EPAY_CALLBACK_DELIVERY=false' in unit
assert 'merchant-workspace' not in proxy
shutil.copytree(OLD, TARGET, symlinks=True)
Path(TARGET).parent.chmod(0o755)
with tarfile.open(str(ARCHIVE)) as tar:
    for member in tar.getmembers():
        path = os.path.realpath(os.path.join(TARGET, member.name))
        assert path.startswith(TARGET + '/') and not member.issym() and not member.islnk()
    tar.extractall(TARGET)
subprocess.check_call([NODE, '--experimental-strip-types', '--test', 'test/epay-main-merchant-console.test.ts', 'test/epay-workspace-mount.test.ts', 'test/epay-merchant-workspace.test.ts'], cwd=TARGET)
subprocess.check_call(['runuser', '-u', pwd.getpwuid(991).pw_name, '--', NODE, '--check', TARGET + '/dist/main.js'])
for name, text in [('candidate-before-console-retry.service', unit), ('candidate-before-console-retry.conf', proxy)]:
    with (RECOVERY / name).open('x') as handle:
        handle.write(text)
locations = []
for path in ['= /pay/admin/merchant-workspace', '^~ /pay/admin/assets/', '= /pay/admin/theme.js']:
    locations.append('''
location PATH {
    limit_except GET { deny all; }
    proxy_pass http://127.0.0.1:16191;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Connection "";
    proxy_cache off;
}
'''.replace('PATH', path))
try:
    UNIT.write_text(unit.replace(OLD, TARGET))
    subprocess.check_call(['systemctl', 'daemon-reload'])
    subprocess.check_call(['systemctl', 'restart', 'perpay-candidate.service'])
    healthy()
    html = request('/pay/admin/merchant-workspace')
    assert 'perpay-admin-base' in html and '/pay/admin/assets/' in html
    assets = sorted(set(re.findall(r'(?:src|href)="(/pay/admin/[^"?]+)', html)))
    for asset in assets:
        assert request(asset)
    PROXY.write_text(proxy + ''.join(locations))
    subprocess.check_call([NGINX, '-t'])
    subprocess.check_call(['systemctl', 'reload', 'nginx'])
    report = {'deployed': True, 'maintenance': True, 'candidatePage': '/pay/admin/merchant-workspace', 'checkedAssets': len(assets), 'codeRoot': TARGET, 'schemaVersion': 55, 'productionCutover': False}
    with (RECOVERY / 'merchant-console-deploy.json').open('x') as handle:
        json.dump(report, handle)
    print(json.dumps(report))
except BaseException:
    PROXY.write_text(proxy)
    subprocess.check_call([NGINX, '-t'])
    subprocess.check_call(['systemctl', 'reload', 'nginx'])
    UNIT.write_text(unit)
    subprocess.check_call(['systemctl', 'daemon-reload'])
    subprocess.check_call(['systemctl', 'restart', 'perpay-candidate.service'])
    healthy()
    print(json.dumps({'deployed': False, 'previousCandidateRestored': True}))
    raise
