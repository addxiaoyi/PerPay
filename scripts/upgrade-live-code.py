"""Publish same-schema fixes with order admission paused and all financial data retained."""
import argparse
import importlib.util
import json
import hashlib
import os
from pathlib import Path
import subprocess
import tarfile
import time

spec = importlib.util.spec_from_file_location('ops', '/root/perpay-recovery-20261106-rc5/switch-production-perpay.py')
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)
MONITOR = Path('/etc/systemd/system/perpay-integrity.service')


def synchronize():
    for attempt in range(3):
        if subprocess.call(['systemctl', 'start', 'perpay-legacy-sync.service']) == 0:
            return
        if attempt < 2:
            time.sleep(3)
    raise RuntimeError('source synchronization did not recover after startup')


def upgrade(args):
    unit = ops.UNIT.read_text()
    mode = 'maintenance' if args.resume_maintenance else 'live'
    ops.require(args.previous in unit and args.data_root in unit and 'PERPAY_EPAY_GATEWAY_MODE=' + mode in unit, 'running release differs')
    ops.wait_health(not args.resume_maintenance)
    monitor = MONITOR.read_text()
    ops.require(args.previous in monitor and args.data_root in monitor, 'monitor configuration differs')
    before = {name: (ops.PROXY / name).read_text() for name in ['epay.conf', 'perpay-candidate-workspace.conf', 'perpay-maintenance-main.conf', 'perpay-cutover-entry.conf']}
    closed = ops.proxy.render(before['epay.conf'], before['perpay-candidate-workspace.conf'], False)
    opened = ops.proxy.render(before['epay.conf'], before['perpay-candidate-workspace.conf'], True) if args.resume_maintenance else before
    recovery = Path(args.recovery_root)
    archive = recovery / (args.release + '.tar.gz')
    ops.require(hashlib.sha256(archive.read_bytes()).hexdigest() == args.sha256, 'release archive digest differs')
    deploy_script = recovery / (args.release + '-deployment.py')
    with tarfile.open(str(archive)) as bundle:
        member = bundle.getmember('scripts/deploy-maintenance-candidate.py')
        ops.require(member.isfile(), 'candidate deployment script is invalid')
        with deploy_script.open('xb') as handle:
            handle.write(bundle.extractfile(member).read())
    completed = False
    try:
        ops.write_proxy(closed)
        subprocess.check_call(['systemctl', 'stop', 'perpay-integrity.timer'])
        subprocess.check_call(['systemctl', 'stop', 'perpay-integrity.service'])
        ops.restart(unit.replace('PERPAY_EPAY_GATEWAY_MODE=live', 'PERPAY_EPAY_GATEWAY_MODE=maintenance').replace('PERPAY_EPAY_CALLBACK_DELIVERY=true', 'PERPAY_EPAY_CALLBACK_DELIVERY=false'))
        ops.wait_health(False)
        subprocess.check_call(['python3', str(deploy_script), '--previous', args.previous, '--target', args.target,
          '--release', args.release, '--sha256', args.sha256, '--data-root', args.data_root, '--recovery-root', args.recovery_root,
          '--alipay-certificate', '/etc/helstera/alipay/app_public_cert.crt', '--main-bridge', '/etc/helstera/lightpay-bridge.secret'])
        MONITOR.write_text(monitor.replace(args.previous, args.target))
        subprocess.check_call(['systemctl', 'daemon-reload'])
        live = ops.UNIT.read_text().replace('PERPAY_EPAY_GATEWAY_MODE=maintenance', 'PERPAY_EPAY_GATEWAY_MODE=live').replace('PERPAY_EPAY_CALLBACK_DELIVERY=false', 'PERPAY_EPAY_CALLBACK_DELIVERY=true')
        ops.restart(live)
        synchronize()
        ready = ops.wait_health(True)
        # A query reserved before the restart keeps its lease for up to one minute.
        for _ in range(32):
            if subprocess.call(['systemctl', 'start', 'perpay-integrity.service']) == 0:
                break
            time.sleep(3)
        else:
            raise RuntimeError('financial and submission monitoring did not recover after startup')
        ops.write_proxy(opened)
        report = {'deployed': True, 'sameDatabaseRetained': args.data_root, 'codeRoot': args.target, 'publicReady': ready['status'] == 'ready', 'testFinancialWrites': 0}
        with (recovery / (args.release + '-live.json')).open('x') as handle:
            json.dump(report, handle)
        completed = True
        print(json.dumps(report))
    finally:
        if not completed:
            ops.write_proxy(closed)
            maintenance = ops.UNIT.read_text().replace('PERPAY_EPAY_GATEWAY_MODE=live', 'PERPAY_EPAY_GATEWAY_MODE=maintenance').replace('PERPAY_EPAY_CALLBACK_DELIVERY=false', 'PERPAY_EPAY_CALLBACK_DELIVERY=true')
            ops.restart(maintenance)
        subprocess.check_call(['systemctl', 'start', 'perpay-integrity.timer'])


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ['previous', 'target', 'release', 'sha256', 'data-root', 'recovery-root']:
        parser.add_argument('--' + option, required=True)
    parser.add_argument('--resume-maintenance', action='store_true')
    upgrade(parser.parse_args())
