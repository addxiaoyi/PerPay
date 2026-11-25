"""Upgrade through a preserved data copy and resume existing admission only after finance checks."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import time

spec = importlib.util.spec_from_file_location('ops', '/root/perpay-recovery-20261106-rc5/switch-production-perpay.py')
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)
MONITOR = Path('/etc/systemd/system/perpay-integrity.service')


def upgrade(args):
    for path in [args.previous_app, args.target_app]:
        ops.require(re.fullmatch(r'/opt/perpay-candidate-\d{8}[a-z]/app', path), 'invalid app root')
    for path in [args.previous_data, args.target_data]:
        ops.require(re.fullmatch(r'/var/lib/perpay-candidate-\d{8}[a-z]', path), 'invalid data root')
    ops.require(re.fullmatch(r'/root/perpay-recovery-\d{8}-rc\d+', args.recovery), 'invalid recovery path')
    ops.require(re.fullmatch(r'/opt/perpay-rc\d+-verify-\d{8}[a-z]?', args.candidate), 'invalid prepared candidate')
    recovery = Path(args.recovery)
    unit = ops.UNIT.read_text()
    ops.require(args.previous_app in unit and args.previous_data in unit and 'PERPAY_EPAY_GATEWAY_MODE=live' in unit, 'live release differs')
    ops.require(ops.request('/pay/epay/readyz')[0] == 200, 'gateway is not ready before upgrade')
    report_dir = recovery / 'live-upgrade'
    report_dir.mkdir(mode=0o700)
    before = {name: (ops.PROXY / name).read_text() for name in ['epay.conf', 'perpay-candidate-workspace.conf', 'perpay-maintenance-main.conf', 'perpay-cutover-entry.conf']}
    closed = ops.proxy.render(before['epay.conf'], before['perpay-candidate-workspace.conf'], False)
    monitor = MONITOR.read_text()
    ops.require(args.previous_app in monitor and args.previous_data in monitor, 'monitor source differs')
    (report_dir / 'candidate-before.service').write_text(unit)
    (report_dir / 'monitor-before.service').write_text(monitor)
    for name, content in before.items():
        (report_dir / name).write_text(content)
    completed = False
    try:
        ops.write_proxy(closed)
        subprocess.check_call(['systemctl', 'stop', 'perpay-integrity.timer'])
        subprocess.check_call(['systemctl', 'stop', 'perpay-integrity.service'])
        maintenance = unit.replace('PERPAY_EPAY_GATEWAY_MODE=live', 'PERPAY_EPAY_GATEWAY_MODE=maintenance').replace('PERPAY_EPAY_CALLBACK_DELIVERY=true', 'PERPAY_EPAY_CALLBACK_DELIVERY=false')
        ops.restart(maintenance)
        ops.wait_health(False)
        subprocess.check_call(['python3', str(Path(args.candidate) / 'scripts/deploy-release-copy.py'),
            '--source-app', args.candidate, '--previous-app', args.previous_app, '--source-root', args.previous_data,
            '--target-app', args.target_app, '--target-root', args.target_data, '--recovery', str(recovery / ('deployment-' + Path(args.target_data).name[len('perpay-candidate-'): ])),
            '--expected-version', args.version, '--expected-schema', str(args.schema)]
            + (['--fa-piao-credential-source', args.fa_piao_credential_source] if getattr(args, 'fa_piao_credential_source', None) else []))
        MONITOR.write_text(monitor.replace(args.previous_app, args.target_app).replace(args.previous_data, args.target_data))
        subprocess.check_call(['systemctl', 'daemon-reload'])
        subprocess.check_call(['systemctl', 'start', 'perpay-legacy-sync.service'])
        live = ops.UNIT.read_text().replace('PERPAY_EPAY_GATEWAY_MODE=maintenance', 'PERPAY_EPAY_GATEWAY_MODE=live').replace('PERPAY_EPAY_CALLBACK_DELIVERY=false', 'PERPAY_EPAY_CALLBACK_DELIVERY=true')
        ops.restart(live)
        subprocess.check_call(['systemctl', 'start', 'perpay-legacy-sync.service'])
        ready = ops.wait_health(True)
        subprocess.check_call(['systemctl', 'start', 'perpay-integrity.service'])
        web_return = ops.PROXY / 'perpay-alipay-web-return.conf'
        if args.schema >= 65 and not web_return.exists():
            web_return.write_text(ops.proxy.proxy('= /pay/epay/alipay/return', 'http://127.0.0.1:16191'))
            web_return.chmod(0o644)
        ops.write_proxy(before)
        ops.require(ops.request('/pay/epay/readyz', origin='https://star-web.top')[0] == 200, 'public gateway did not resume')
        report = {'deployed': True, 'version': args.version, 'schema': args.schema, 'codeRoot': args.target_app, 'dataRoot': args.target_data,
                  'ready': ready, 'previousDatabasePreserved': True, 'testFinancialWrites': 0, 'completedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        (report_dir / 'report.json').write_text(json.dumps(report))
        completed = True
        print(json.dumps(report))
    finally:
        if not completed:
            ops.write_proxy(closed)
            current = ops.UNIT.read_text().replace('PERPAY_EPAY_GATEWAY_MODE=live', 'PERPAY_EPAY_GATEWAY_MODE=maintenance').replace('PERPAY_EPAY_CALLBACK_DELIVERY=false', 'PERPAY_EPAY_CALLBACK_DELIVERY=true')
            ops.restart(current)
        subprocess.check_call(['systemctl', 'start', 'perpay-integrity.timer'])


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ['previous-app', 'previous-data', 'candidate', 'target-app', 'target-data', 'recovery', 'version']:
        parser.add_argument('--' + option, required=True)
    parser.add_argument('--schema', type=int, required=True)
    parser.add_argument('--fa-piao-credential-source')
    upgrade(parser.parse_args())
