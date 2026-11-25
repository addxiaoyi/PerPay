"""Exercise new reader, previous consumer configuration and reader restoration without changing source rows."""
import json
import os
from pathlib import Path
import subprocess

NODE = '/opt/perpay-candidate-20261104a/runtime/bin/node'
APP = '/opt/perpay-candidate-20261106e/app'
ROOT = '/var/lib/perpay-candidate-20261106e'
SECRET = Path('/etc/helstera/perpay-snapshot.json')
PENDING = Path('/etc/helstera/perpay-snapshot.rotation-rehearsal')
REPORT = Path('/root/perpay-recovery-20261106-rc5/reader-rollback.json')


def sync(expected):
    output = subprocess.check_output([NODE, '--experimental-strip-types', APP + '/scripts/sync-legacy-sources.ts', ROOT, '--running'], cwd=APP, universal_newlines=True)
    report = json.loads(output)
    if report.get('restrictedReader') is not expected or report.get('sourceReadOnly') is not True or report.get('providerRequests') != 0:
        raise RuntimeError('unexpected synchronization verification')
    return {'restrictedReader': expected, 'sourceReadOnly': True, 'providerRequests': 0}


def main():
    os.umask(0o077)
    if REPORT.exists() or PENDING.exists() or not SECRET.is_file() or SECRET.is_symlink():
        raise RuntimeError('reader rehearsal paths differ')
    active = subprocess.check_output(['systemctl', 'is-active', 'perpay-legacy-sync.timer']).strip() == b'active'
    try:
        subprocess.check_call(['systemctl', 'stop', 'perpay-legacy-sync.timer'])
        subprocess.check_call(['systemctl', 'stop', 'perpay-legacy-sync.service'])
        first = sync(True)
        SECRET.rename(PENDING)
        try:
            fallback = sync(False)
        finally:
            PENDING.rename(SECRET)
        restored = sync(True)
        report = {'reader': first, 'fallback': fallback, 'restored': restored, 'oldCredentialUnchanged': True, 'activeConsumer': 'perpay-legacy-sync.service'}
        with REPORT.open('x') as handle:
            json.dump(report, handle)
        print(json.dumps(report))
    finally:
        if PENDING.exists() and not SECRET.exists():
            PENDING.rename(SECRET)
        if active:
            subprocess.check_call(['systemctl', 'start', 'perpay-legacy-sync.timer'])


if __name__ == '__main__':
    main()
