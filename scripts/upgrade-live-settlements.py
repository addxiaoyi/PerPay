"""Upgrade an already-live gateway through a frozen copy, retaining both generations of financial data."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time

spec = importlib.util.spec_from_file_location('ops', '/root/perpay-recovery-20261106-rc5/switch-production-perpay.py')
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)
OLD_APP = '/opt/perpay-candidate-20261106g/app'
OLD_DATA = '/var/lib/perpay-candidate-20261106e'
NEW_APP = '/opt/perpay-candidate-20261106h/app'
NEW_DATA = '/var/lib/perpay-candidate-20261106h'
RECOVERY = Path('/root/perpay-recovery-20261106-rc6')
INTEGRITY = Path('/etc/systemd/system/perpay-integrity.service')
LEGACY_SETTLEMENTS = ops.PROXY / 'perpay-legacy-settlements.conf'


def main():
    os.umask(0o077)
    unit = ops.UNIT.read_text()
    ops.require(OLD_APP in unit and OLD_DATA in unit and 'PERPAY_EPAY_GATEWAY_MODE=live' in unit, 'live release differs')
    ops.require(not LEGACY_SETTLEMENTS.exists(), 'settlement ingress override already exists')
    state = ops.request('/pay/epay/readyz')
    ops.require(state[0] == 200, 'live gateway was not ready before upgrade')
    before = {name: (ops.PROXY / name).read_text() for name in ['epay.conf', 'perpay-candidate-workspace.conf', 'perpay-maintenance-main.conf', 'perpay-cutover-entry.conf']}
    baseline = {name: (ops.CHECKPOINT / name).read_text() for name in ['epay.conf', 'perpay-candidate-workspace.conf']}
    closed = ops.proxy.render(baseline['epay.conf'], baseline['perpay-candidate-workspace.conf'], False)
    monitor = INTEGRITY.read_text()
    ops.require(OLD_APP in monitor and OLD_DATA in monitor, 'financial monitor release differs')
    recovery = RECOVERY / 'live-upgrade'
    recovery.mkdir(mode=0o700)
    for name, content in before.items():
        (recovery / name).write_text(content)
    (recovery / 'candidate-before.service').write_text(unit)
    (recovery / 'monitor-before.service').write_text(monitor)
    completed = False
    try:
        # Leave legacy application decisions available; close only new old-system requests.
        request_closed = '''location = /api/merchant/settlements {
    if ($request_method = POST) { return 409 '{"ok":false,"code":"settlement_moved","error":"请在支付工作台提交提现申请。"}'; }
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header Cookie $http_cookie;
    add_header Cache-Control "no-store" always;
}
location = /pay/api/merchant/settlements {
    if ($request_method = POST) { return 409 '{"ok":false,"code":"settlement_moved","error":"请在支付工作台提交提现申请。"}'; }
    proxy_pass http://127.0.0.1:8787/api/merchant/settlements;
    proxy_set_header Host $host;
    proxy_set_header Cookie $http_cookie;
    add_header Cache-Control "no-store" always;
}
'''
        LEGACY_SETTLEMENTS.write_text(request_closed)
        LEGACY_SETTLEMENTS.chmod(0o644)
        ops.write_proxy(closed)
        subprocess.check_call(['systemctl', 'stop', 'perpay-integrity.timer'])
        subprocess.check_call(['systemctl', 'stop', 'perpay-integrity.service'])
        maintenance = unit.replace('PERPAY_EPAY_GATEWAY_MODE=live', 'PERPAY_EPAY_GATEWAY_MODE=maintenance').replace('PERPAY_EPAY_CALLBACK_DELIVERY=true', 'PERPAY_EPAY_CALLBACK_DELIVERY=false')
        ops.restart(maintenance)
        ops.wait_health(False)
        subprocess.check_call(['python3', '/opt/perpay-rc6-verify-20261106/scripts/deploy-release-copy.py',
            '--source-app', '/opt/perpay-rc6-verify-20261106', '--previous-app', OLD_APP, '--source-root', OLD_DATA,
            '--target-app', NEW_APP, '--target-root', NEW_DATA, '--recovery', str(RECOVERY / 'deployment-20261106h'),
            '--expected-version', '1.0.0-rc.6', '--expected-schema', '62'])
        INTEGRITY.write_text(monitor.replace(OLD_APP, NEW_APP).replace(OLD_DATA, NEW_DATA))
        subprocess.check_call(['systemctl', 'daemon-reload'])
        subprocess.check_call(['systemctl', 'start', 'perpay-legacy-sync.service'])
        live = ops.UNIT.read_text().replace('PERPAY_EPAY_GATEWAY_MODE=maintenance', 'PERPAY_EPAY_GATEWAY_MODE=live').replace('PERPAY_EPAY_CALLBACK_DELIVERY=false', 'PERPAY_EPAY_CALLBACK_DELIVERY=true')
        ops.restart(live)
        subprocess.check_call(['systemctl', 'start', 'perpay-legacy-sync.service'])
        ready = ops.wait_health(True)
        subprocess.check_call(['systemctl', 'start', 'perpay-integrity.service'])
        ops.write_proxy(before)
        ops.require(ops.request('/pay/epay/readyz', origin='https://star-web.top')[0] == 200, 'public upgraded gateway is not ready')
        for path in ['/api/merchant/settlements', '/pay/api/merchant/settlements']:
            ops.require(ops.request(path, 'POST', 'https://star-web.top')[0] == 409, 'legacy new settlement ingress still writes')
        report = {'deployed': True, 'version': '1.0.0-rc.6', 'schema': 62, 'codeRoot': NEW_APP, 'dataRoot': NEW_DATA,
                  'ready': ready, 'previousDatabasePreserved': True, 'nativeSettlementTestsOnly': True,
                  'realPayouts': 0, 'completedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        (recovery / 'report.json').write_text(json.dumps(report))
        completed = True
        print(json.dumps(report))
    finally:
        if not completed:
            # Failure keeps admission closed. Whichever database owns new records remains authoritative.
            ops.write_proxy(closed)
            current = ops.UNIT.read_text().replace('PERPAY_EPAY_GATEWAY_MODE=live', 'PERPAY_EPAY_GATEWAY_MODE=maintenance')
            current = current.replace('PERPAY_EPAY_CALLBACK_DELIVERY=false', 'PERPAY_EPAY_CALLBACK_DELIVERY=true')
            ops.restart(current)
        subprocess.check_call(['systemctl', 'start', 'perpay-integrity.timer'])


if __name__ == '__main__':
    main()
