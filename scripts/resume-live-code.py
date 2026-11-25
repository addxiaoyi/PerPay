"""Resume a verified code release after a transient startup sync failure; retain the active financial database."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time

spec = importlib.util.spec_from_file_location('upgrade', Path(__file__).with_name('upgrade-live-code.py'))
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)
ops = upgrade.ops


def main(args):
    os.umask(0o077)
    root = Path(args.recovery_root)
    deploy = json.loads((root / (args.release + '-deploy.json')).read_text())
    ops.require(deploy.get('deployed') is True and deploy.get('restoreVerified') is True and deploy.get('financialTablesUnchanged') is True, 'release evidence is incomplete')
    ops.require(deploy.get('codeRoot') == args.target and deploy.get('dataRoot') == args.data_root, 'release identity differs')
    report_file = root / (args.release + '-live.json')
    ops.require(not report_file.exists(), 'release already resumed')
    unit = ops.UNIT.read_text()
    ops.require(args.target in unit and args.data_root in unit and 'PERPAY_EPAY_GATEWAY_MODE=maintenance' in unit, 'active maintenance release differs')
    ops.wait_health(False)
    previous = {name: (ops.PROXY / name).read_text() for name in ['epay.conf', 'perpay-candidate-workspace.conf', 'perpay-maintenance-main.conf', 'perpay-cutover-entry.conf']}
    opened = ops.proxy.render(previous['epay.conf'], previous['perpay-candidate-workspace.conf'], True)
    try:
        ops.restart(unit.replace('PERPAY_EPAY_GATEWAY_MODE=maintenance', 'PERPAY_EPAY_GATEWAY_MODE=live').replace('PERPAY_EPAY_CALLBACK_DELIVERY=false', 'PERPAY_EPAY_CALLBACK_DELIVERY=true'))
        upgrade.synchronize()
        ready = ops.wait_health(True)
        for attempt in range(12):
            if subprocess.call(['systemctl', 'start', 'perpay-integrity.service']) == 0:
                break
            time.sleep(3)
        else:
            raise RuntimeError('integrity monitor did not recover')
        ops.write_proxy(opened)
        status, raw = ops.request('/pay/epay/readyz', origin='https://star-web.top')
        ops.require(status == 200 and json.loads(raw)['status'] == 'ready', 'public gateway did not become ready')
        report = {'deployed': True, 'sameDatabaseRetained': args.data_root, 'codeRoot': args.target, 'publicReady': ready['status'] == 'ready', 'resumedAfterSyncFailure': True, 'testFinancialWrites': 0}
        with report_file.open('x') as handle:
            json.dump(report, handle)
        print(json.dumps(report))
    except BaseException:
        ops.write_proxy(previous)
        ops.restart(unit.replace('PERPAY_EPAY_CALLBACK_DELIVERY=false', 'PERPAY_EPAY_CALLBACK_DELIVERY=true'))
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ['target', 'release', 'data-root', 'recovery-root']:
        parser.add_argument('--' + option, required=True)
    main(parser.parse_args())
