"""Stop new order admission while preserving PerPay data and both generations of callbacks."""
import importlib.util
import json
import os
import re
from pathlib import Path
import subprocess
import time

spec = importlib.util.spec_from_file_location('switch', Path(__file__).with_name('switch-production-perpay.py'))
switch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(switch)


def rollback():
    os.umask(0o077)
    unit = switch.UNIT.read_text()
    code = re.search(r'^WorkingDirectory=(/opt/perpay-candidate-\d{8}[a-z]/app)$', unit, re.M)
    storage = re.search(r'PERPAY_DATA_DIR=(/var/lib/perpay-candidate-\d{8}[a-z])/data(?:[\s\"]|$)', unit)
    switch.require(code is not None and storage is not None, 'active release paths are invalid; review before rollback')
    switch.APP = Path(code.group(1))
    switch.DATA = Path(storage.group(1))
    original = {name: (switch.PROXY / name).read_text() for name in ['epay.conf', 'perpay-candidate-workspace.conf', 'perpay-maintenance-main.conf']}
    closed = switch.proxy.render(original['epay.conf'], original['perpay-candidate-workspace.conf'], False)
    directory = switch.RECOVERY / ('admission-rollback-' + time.strftime('%Y%m%d-%H%M%S', time.gmtime()))
    directory.mkdir(mode=0o700)
    (directory / 'candidate-before.service').write_text(unit)
    for name in closed:
        (directory / name).write_text((switch.PROXY / name).read_text())
    switch.write_proxy(closed)
    maintenance = unit.replace('PERPAY_EPAY_GATEWAY_MODE=live', 'PERPAY_EPAY_GATEWAY_MODE=maintenance')
    maintenance = maintenance.replace('PERPAY_EPAY_CALLBACK_DELIVERY=false', 'PERPAY_EPAY_CALLBACK_DELIVERY=true')
    switch.restart(maintenance)
    switch.wait_health(False)
    subprocess.check_call(['systemctl', 'start', 'perpay-legacy-sync.service'])
    report = {'newOrdersClosed': True, 'sameDatabaseRetained': str(switch.DATA), 'nativeCallbacksRunning': True,
              'legacyCallbackRoutesRetained': True, 'oldDatabaseRestored': False, 'completedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    (directory / 'report.json').write_text(json.dumps(report))
    print(json.dumps(report))


if __name__ == '__main__':
    rollback()
