"""Validate the settlement candidate on Node 24 without touching live financial data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

NODE = '/opt/perpay-candidate-20261104a/runtime/bin/node'
OLD = Path('/opt/perpay-candidate-20261106g/app')
TARGET = Path('/opt/perpay-rc6-verify-20261106')
RECOVERY = Path('/root/perpay-recovery-20261106-rc6')
ARCHIVE = Path('/root/perpay-recovery-20261106-rc5/settlements-20261106h.tar.gz')


def prepare(expected):
    if hashlib.sha256(ARCHIVE.read_bytes()).hexdigest() != expected or TARGET.exists():
        raise RuntimeError('candidate archive differs or target already exists')
    shutil.copytree(str(OLD), str(TARGET), symlinks=True)
    TARGET.chmod(0o755)
    with tarfile.open(str(ARCHIVE)) as bundle:
        for member in bundle.getmembers():
            path = os.path.realpath(os.path.join(str(TARGET), member.name))
            if not path.startswith(str(TARGET) + '/') or not (member.isdir() or member.isfile()) or member.name.split('/')[0] not in ['dist', 'src', 'test', 'scripts', 'web-dist', 'static', 'package.json', 'package-lock.json']:
                raise RuntimeError('unsafe candidate archive member')
            member.mode = 0o755 if member.isdir() else 0o644
        bundle.extractall(str(TARGET))
    previous = json.loads((OLD / 'package-lock.json').read_text())
    current = json.loads((TARGET / 'package-lock.json').read_text())
    previous['version'] = current['version']
    previous['packages']['']['version'] = current['packages']['']['version']
    if previous != current or current['version'] != '1.0.0-rc.6':
        raise RuntimeError('candidate dependencies or version differ')
    tests = ['epay-settlement-workflow', 'epay-refund-workflow', 'epay-refund-provider', 'epay-main-delta-store', 'epay-main-order-routes',
             'epay-live-balance', 'epay-balance-admin-http', 'epay-main-merchant-console', 'epay-merchant-members', 'epay-gateway-readiness',
             'epay-confirm-delivery-integration', 'epay-source-sync-route', 'epay-main-settlement-audit', 'epay-compat-schema', 'checkpoint-candidate-release']
    subprocess.check_call([NODE, '--experimental-strip-types', '--test'] + ['test/' + name + '.test.ts' for name in tests], cwd=str(TARGET))
    RECOVERY.mkdir(mode=0o700, exist_ok=True)
    report = {'prepared': True, 'schema': 62, 'version': current['version'], 'archiveSha256': expected, 'productionChanged': False}
    with (RECOVERY / 'prepared.json').open('x') as handle:
        json.dump(report, handle)
    print(json.dumps(report))


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sha256', required=True)
    prepare(parser.parse_args().sha256)
