"""Resume a recorded cutover after listener readiness; never re-import or restore financial data."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time

spec = importlib.util.spec_from_file_location('switch', Path(__file__).with_name('switch-production-perpay.py'))
switch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(switch)


def main():
    os.umask(0o077)
    report_file = switch.CHECKPOINT / 'cutover.json'
    if report_file.exists():
        raise RuntimeError('cutover success is already recorded')
    unit = switch.UNIT.read_text()
    switch.require(str(switch.APP) in unit and 'PERPAY_EPAY_GATEWAY_MODE=maintenance' in unit and 'PERPAY_EPAY_CALLBACK_DELIVERY=true' in unit, 'recorded cutover recovery state differs')
    state = switch.wait_health(False)
    switch.require(state.get('cutoverRecorded') is True and state.get('acceptingMerchants') == 4 and state.get('balancesReady') is True, 'recorded financial admission state differs')
    original = {name: (switch.CHECKPOINT / name).read_text() for name in ['epay.conf', 'perpay-candidate-workspace.conf', 'perpay-maintenance-main.conf']}
    closed = switch.proxy.render(original['epay.conf'], original['perpay-candidate-workspace.conf'], False)
    opened = switch.proxy.render(original['epay.conf'], original['perpay-candidate-workspace.conf'], True)
    for name, expected in closed.items():
        switch.require((switch.PROXY / name).read_text() == expected, 'maintenance routing changed')
    try:
        switch.run_script('reconcile-maintenance-candidate.ts', [str(switch.DATA), str(switch.CHECKPOINT / 'resume-reconciliation.json')], 'EPAY_READONLY_AUDIT')
        live = unit.replace('PERPAY_EPAY_GATEWAY_MODE=maintenance', 'PERPAY_EPAY_GATEWAY_MODE=live')
        switch.restart(live)
        subprocess.check_call(['systemctl', 'start', 'perpay-legacy-sync.service'])
        state = switch.wait_health(True)
        switch.write_proxy(opened)
        for path in ['/pay/submit.php', '/pay/mapi.php', '/pay/epay/mapi.php']:
            status, body = switch.request(path, 'POST', 'https://star-web.top')
            switch.require(status == 400 and json.loads(body).get('code') == -1, 'invalid order was not rejected by candidate')
        status, body = switch.request('/pay/epay/readyz', origin='https://star-web.top')
        switch.require(status == 200 and json.loads(body).get('status') == 'ready', 'public gateway not ready')
        report = {'productionCutover': True, 'version': '1.0.0-rc.5', 'schema': 61, 'codeRoot': str(switch.APP), 'dataRoot': str(switch.DATA),
                  'readiness': state, 'invoiceEnabled': False, 'legacyCallbacksPreserved': True, 'testPaymentsCreated': 0,
                  'testRefundsCreated': 0, 'completedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        with report_file.open('x') as handle:
            json.dump(report, handle)
        print(json.dumps(report))
    except BaseException:
        switch.write_proxy(closed)
        switch.restart(unit)
        switch.wait_health(False)
        raise


if __name__ == '__main__':
    main()
