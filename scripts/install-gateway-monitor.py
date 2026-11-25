"""Install a read-only financial consistency probe for the active PerPay release."""
import json
import os
from pathlib import Path
import shutil
import subprocess

APP = Path('/opt/perpay-candidate-20261106g/app')
DATA = '/var/lib/perpay-candidate-20261106e'
RECOVERY = Path('/root/perpay-recovery-20261106-rc5')
UNIT = Path('/etc/systemd/system/perpay-integrity.service')
TIMER = Path('/etc/systemd/system/perpay-integrity.timer')


def main():
    os.umask(0o077)
    if UNIT.exists() or TIMER.exists():
        raise RuntimeError('monitor already exists; review its configuration')
    target = APP / 'scripts/audit-live-gateway.ts'
    if target.exists():
        raise RuntimeError('monitor source already exists')
    shutil.copy2('/opt/perpay-rc5-verify-20261106b/scripts/audit-live-gateway.ts', str(target))
    target.chmod(0o644)
    service = '''[Unit]
Description=Read-only PerPay balance, confirmation, refund and callback audit
After=perpay-candidate.service

[Service]
Type=oneshot
User=perpay-candidate
Group=perpay-candidate
WorkingDirectory=APP
ExecStart=/opt/perpay-candidate-20261104a/runtime/bin/node --experimental-strip-types APP/scripts/audit-live-gateway.ts DATA
NoNewPrivileges=yes
PrivateTmp=yes
PrivateNetwork=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=DATA/data
TimeoutStartSec=20
'''.replace('APP', str(APP)).replace('DATA', DATA)
    timer = '''[Unit]
Description=Audit PerPay financial consistency every minute
[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=5s
Unit=perpay-integrity.service
[Install]
WantedBy=timers.target
'''
    try:
        UNIT.write_text(service)
        TIMER.write_text(timer)
        UNIT.chmod(0o644)
        TIMER.chmod(0o644)
        subprocess.check_call(['systemd-analyze', 'verify', str(UNIT), str(TIMER)])
        subprocess.check_call(['systemctl', 'daemon-reload'])
        subprocess.check_call(['systemctl', 'start', 'perpay-integrity.service'])
        subprocess.check_call(['systemctl', 'enable', '--now', 'perpay-integrity.timer'])
        report = {'installed': True, 'intervalSeconds': 60, 'databaseReadOnly': True, 'networkDisabled': True,
                  'checks': ['balance_ledger', 'payment_proofs', 'refund_postings', 'callback_delay', 'legacy_sync_age']}
        (RECOVERY / 'monitor.json').write_text(json.dumps(report))
        print(json.dumps(report))
    except BaseException:
        subprocess.call(['systemctl', 'disable', '--now', 'perpay-integrity.timer'])
        for path in [UNIT, TIMER]:
            if path.exists():
                path.rename(RECOVERY / (path.name + '.failed'))
        subprocess.check_call(['systemctl', 'daemon-reload'])
        raise


if __name__ == '__main__':
    main()
