"""Prepare and test schema 61 without changing the active service or database."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

NODE = '/opt/perpay-candidate-20261104a/runtime/bin/node'
PREVIOUS = Path('/opt/perpay-candidate-20261106d/app')
CANDIDATE = Path('/opt/perpay-rc5-verify-20261106b')
RECOVERY = Path('/root/perpay-recovery-20261106-rc5')
ARCHIVE = Path('/root/perpay-recovery-20261106-rc4/refunds-20261106f.tar.gz')


def prepare(expected):
    if hashlib.sha256(ARCHIVE.read_bytes()).hexdigest() != expected or CANDIDATE.exists():
        raise RuntimeError('release digest differs or candidate already exists')
    shutil.copytree(str(PREVIOUS), str(CANDIDATE), symlinks=True)
    CANDIDATE.chmod(0o755)
    with tarfile.open(str(ARCHIVE)) as bundle:
        for member in bundle.getmembers():
            target = os.path.realpath(os.path.join(str(CANDIDATE), member.name))
            allowed = member.name.split('/')[0] in ['dist', 'src', 'test', 'web-dist', 'static', 'scripts', 'package.json', 'package-lock.json']
            if not allowed or not target.startswith(str(CANDIDATE) + '/') or not (member.isdir() or member.isfile()):
                raise RuntimeError('unsafe release member')
            member.mode = 0o755 if member.isdir() else 0o644
        bundle.extractall(str(CANDIDATE))
    previous_lock = json.loads((PREVIOUS / 'package-lock.json').read_text())
    candidate_lock = json.loads((CANDIDATE / 'package-lock.json').read_text())
    previous_lock['version'] = candidate_lock['version']
    previous_lock['packages']['']['version'] = candidate_lock['packages']['']['version']
    if previous_lock != candidate_lock or candidate_lock['version'] != '1.0.0-rc.5':
        raise RuntimeError('release dependency graph differs')
    tests = ['epay-refund-provider', 'epay-refund-workflow', 'epay-main-order-routes', 'epay-main-order-access',
             'epay-gateway-readiness', 'epay-gateway-mount', 'epay-confirm-delivery-integration', 'epay-main-current-workspace',
             'epay-main-orders-workspace', 'epay-merchant-workspace', 'epay-isolated-api-query', 'epay-compat-schema',
             'epay-live-balance', 'epay-balance-admin-http', 'epay-merchant-members', 'epay-alipay-query-confirmation',
             'checkpoint-candidate-release', 'release-restore-fingerprint']
    subprocess.check_call([NODE, '--experimental-strip-types', '--test'] + ['test/' + name + '.test.ts' for name in tests], cwd=str(CANDIDATE))
    RECOVERY.mkdir(mode=0o700, exist_ok=True)
    report = {'prepared': True, 'version': '1.0.0-rc.5', 'schema': 61, 'candidate': str(CANDIDATE), 'archiveSha256': expected, 'productionChanged': False}
    with (RECOVERY / 'prepared.json').open('x') as handle:
        json.dump(report, handle)
    print(json.dumps(report))


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sha256', required=True)
    prepare(parser.parse_args().sha256)
