"""Cut over only after fresh record reconciliation; rollback preserves the live financial database."""
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shutil
import signal
import subprocess
import time
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location('proxy', Path(__file__).with_name('cutover-proxy.py'))
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)
NODE = '/opt/perpay-candidate-20261104a/runtime/bin/node'
APP = Path('/opt/perpay-candidate-20261106g/app')
DATA = Path('/var/lib/perpay-candidate-20261106e')
RECOVERY = Path('/root/perpay-recovery-20261106-rc5')
CHECKPOINT = RECOVERY / 'cutover-20261106'
PROXY = Path('/www/server/panel/vhost/nginx/extension/star-web.top')
UNIT = Path('/etc/systemd/system/perpay-candidate.service')
FIREWALL = Path('/usr/local/sbin/perpay-candidate-firewall')
NGINX = '/www/server/nginx/sbin/nginx'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def request(path, method='GET', origin='http://127.0.0.1:16191'):
    req = urllib.request.Request(origin + path, method=method, data=b'{}' if method == 'POST' else None,
                                 headers={'content-type': 'application/json', 'cache-control': 'no-cache'})
    try:
        response = urllib.request.urlopen(req, timeout=10)
    except urllib.error.HTTPError as error:
        return error.code, error.read()
    with response:
        return response.status, response.read()


def nginx_master():
    pid = int(Path('/www/server/nginx/logs/nginx.pid').read_text().strip())
    require(b'nginx: master process /www/server/nginx/sbin/nginx' in Path('/proc/' + str(pid) + '/cmdline').read_bytes(), 'nginx master identity changed')
    return pid


def reload_proxy():
    subprocess.check_call([NGINX, '-t'])
    pid = nginx_master()
    children = Path('/proc/' + str(pid) + '/task/' + str(pid) + '/children').read_text().split()
    os.kill(pid, signal.SIGHUP)
    for _ in range(60):
        if not any(Path('/proc/' + child).exists() for child in children):
            return
        time.sleep(0.5)
    raise RuntimeError('nginx previous workers have not drained')


def write_proxy(files):
    for name, content in files.items():
        path = PROXY / name
        temporary = path.with_suffix('.conf.pending')
        with temporary.open('x') as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(0o644)
        os.replace(str(temporary), str(path))
    reload_proxy()


def run_script(name, args, marker):
    env = dict(os.environ)
    env[marker] = '1'
    subprocess.check_call([NODE, '--experimental-strip-types', str(APP / 'scripts' / name)] + args, cwd=str(APP), env=env)


def wait_health(ready):
    for _ in range(30):
        try:
            code, body = request('/pay/epay/readyz')
            health = json.loads(body)
            if (ready and code == 200 and health.get('status') == 'ready') or (not ready and code == 503 and health.get('code') == 'epay_maintenance'):
                return health
        except (OSError, ValueError):
            pass
        time.sleep(0.5)
    raise RuntimeError('gateway did not reach expected readiness')


def restart(content):
    UNIT.write_text(content)
    subprocess.check_call(['systemctl', 'daemon-reload'])
    subprocess.check_call(['systemctl', 'restart', 'perpay-candidate.service'])
    for _ in range(30):
        try:
            if request('/pay/healthz')[0] == 200:
                return
        except (OSError, ValueError):
            pass
        time.sleep(0.5)
    raise RuntimeError('candidate listener is not ready after restart')


def main():
    os.umask(0o077)
    unit = UNIT.read_text()
    require(str(APP) in unit and str(DATA) in unit and 'PERPAY_EPAY_GATEWAY_MODE=maintenance' in unit and
            'PERPAY_EPAY_CALLBACK_DELIVERY=false' in unit and 'PERPAY_EPAY_INVOICE_ENABLED=false' in unit, 'candidate configuration differs')
    require(not CHECKPOINT.exists() and not (PROXY / 'perpay-cutover-entry.conf').exists(), 'cutover has already been attempted')
    for file, fields in [('reader-rollback.json', ['oldCredentialUnchanged']), ('main-bridge.json', ['bridgeVerified']),
                         ('ingress-final-rehearsal.json', ['maintenance', 'live', 'rollback', 'legacyCallbackOwnersPreserved', 'nativeCallbackOwnersPreserved']),
                         ('financial-rollback.json', ['newFinancialRecordsPreserved', 'productionFinancialRecordsUnchanged'])]:
        report = json.loads((RECOVERY / file).read_text())
        require(all(report.get(field) is True for field in fields), 'cutover evidence missing: ' + file)
    before_proxy = {name: (PROXY / name).read_text() for name in ['epay.conf', 'perpay-candidate-workspace.conf', 'perpay-maintenance-main.conf']}
    closed = proxy.render(before_proxy['epay.conf'], before_proxy['perpay-candidate-workspace.conf'], False)
    opened = proxy.render(before_proxy['epay.conf'], before_proxy['perpay-candidate-workspace.conf'], True)
    CHECKPOINT.mkdir(mode=0o700)
    for name, content in before_proxy.items():
        (CHECKPOINT / name).write_text(content)
    (CHECKPOINT / 'candidate-before.service').write_text(unit)
    shutil.copy2(str(FIREWALL), str(CHECKPOINT / 'firewall-before.sh'))
    shutil.copytree(str(DATA / 'secrets'), str(CHECKPOINT / 'secrets'))
    shutil.copy2('/etc/helstera/payment/master.key', str(CHECKPOINT / 'main-payment-master.key'))
    owner = pwd.getpwnam('perpay-candidate')
    timer = subprocess.check_output(['systemctl', 'is-active', 'perpay-legacy-sync.timer']).strip() == b'active'
    started_live = False
    try:
        write_proxy(closed)
        for path in proxy.ORDER_PATHS:
            require(request(path, 'POST', 'https://star-web.top')[0] == 503, 'new order ingress did not close')
        # Read-only provider queries run under the real service UID before any admission changes.
        shutil.copy2(str(APP / 'scripts/candidate-live-firewall.sh'), str(FIREWALL))
        FIREWALL.chmod(0o755)
        subprocess.check_call([str(FIREWALL)])
        channels = DATA / 'backups/channel-cutover-20261106.json'
        subprocess.check_call(['runuser', '-u', 'perpay-candidate', '--', 'env', 'EPAY_READONLY_AUDIT=1', NODE,
            '--experimental-strip-types', str(APP / 'scripts/verify-live-channels-readonly.ts'), str(DATA),
            str(DATA / 'secrets/alipay-account.crt'), str(channels)], cwd=str(APP))
        subprocess.check_call(['systemctl', 'stop', 'perpay-legacy-sync.timer'])
        subprocess.check_call(['systemctl', 'stop', 'perpay-legacy-sync.service'])
        subprocess.check_call([NODE, '--experimental-strip-types', str(APP / 'scripts/sync-legacy-sources.ts'), str(DATA), '--running'], cwd=str(APP))
        reconciliation = CHECKPOINT / 'final-reconciliation.json'
        run_script('reconcile-maintenance-candidate.ts', [str(DATA), str(reconciliation)], 'EPAY_READONLY_AUDIT')
        subprocess.check_call(['systemctl', 'stop', 'perpay-candidate.service'])
        run_script('checkpoint-candidate-release.ts', [str(APP), str(APP), str(DATA), str(CHECKPOINT)], 'EPAY_ISOLATED_TEST')
        run_script('record-cutover.ts', [str(DATA), str(reconciliation), str(RECOVERY / 'financial-rollback.json'), str(channels), str(CHECKPOINT / 'manifest.json')], 'PERPAY_RECORD_CUTOVER')
        for path in (DATA / 'data').iterdir():
            if path.name.startswith('perpay.sqlite3') and not path.is_symlink():
                os.chown(str(path), owner.pw_uid, owner.pw_gid)
        live_unit = unit.replace('PERPAY_EPAY_GATEWAY_MODE=maintenance', 'PERPAY_EPAY_GATEWAY_MODE=live').replace('PERPAY_EPAY_CALLBACK_DELIVERY=false', 'PERPAY_EPAY_CALLBACK_DELIVERY=true')
        started_live = True
        restart(live_unit)
        subprocess.check_call(['systemctl', 'start', 'perpay-legacy-sync.service'])
        if timer:
            subprocess.check_call(['systemctl', 'start', 'perpay-legacy-sync.timer'])
        state = wait_health(True)
        write_proxy(opened)
        for path in ['/pay/submit.php', '/pay/mapi.php', '/pay/epay/mapi.php']:
            status, body = request(path, 'POST', 'https://star-web.top')
            require(status == 400 and json.loads(body).get('code') == -1, 'invalid order probe was not rejected by PerPay')
        status, body = request('/pay/epay/readyz', origin='https://star-web.top')
        require(status == 200 and json.loads(body).get('status') == 'ready', 'public payment entry is not ready')
        report = {'productionCutover': True, 'version': '1.0.0-rc.5', 'schema': 61, 'codeRoot': str(APP), 'dataRoot': str(DATA),
                  'readiness': state, 'invoiceEnabled': False, 'legacyCallbacksPreserved': True,
                  'testPaymentsCreated': 0, 'testRefundsCreated': 0, 'completedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        (CHECKPOINT / 'cutover.json').write_text(json.dumps(report))
        print(json.dumps(report))
    except BaseException:
        write_proxy(closed)
        # Keep callbacks, the upgraded database and all post-cutover writes. Never restore an old backup here.
        recovery_unit = unit.replace('PERPAY_EPAY_CALLBACK_DELIVERY=false', 'PERPAY_EPAY_CALLBACK_DELIVERY=true') if started_live else unit
        for path in (DATA / 'data').iterdir():
            if path.name.startswith('perpay.sqlite3') and not path.is_symlink():
                os.chown(str(path), owner.pw_uid, owner.pw_gid)
        restart(recovery_unit)
        wait_health(False)
        print(json.dumps({'productionCutover': False, 'newOrdersClosed': True, 'allFinancialDataPreserved': True, 'callbacksRetained': started_live}))
        raise
    finally:
        if timer:
            subprocess.check_call(['systemctl', 'start', 'perpay-legacy-sync.timer'])


if __name__ == '__main__':
    main()
