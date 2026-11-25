"""Prepare an immutable release directory and validate its finance modules on the production runtime."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

NODE = '/opt/perpay-candidate-20261104a/runtime/bin/node'
TESTS = ['epay-key-rotation', 'epay-merchant-secret', 'epay-merchant-key-console', 'epay-settlement-workflow',
         'epay-merchant-enrollment',
         'epay-alipay-web', 'epay-main-native-order',
         'epay-api-actions', 'epay-outbox', 'epay-callback-processor',
         'epay-refund-workflow', 'epay-refund-provider', 'epay-main-delta-store', 'epay-main-order-routes',
         'epay-live-balance', 'epay-balance-admin-http', 'epay-main-merchant-console', 'epay-merchant-members',
         'epay-gateway-readiness', 'epay-confirm-delivery-integration', 'epay-source-sync-route',
         'epay-exact-wechat-order', 'epay-isolated-checkout-status', 'epay-compat-schema', 'checkpoint-candidate-release',
         'release-restore-fingerprint']


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def prepare(args):
    previous, target, archive, recovery = [Path(value) for value in [args.previous, args.target, args.archive, args.recovery]]
    require(re.fullmatch(r'/opt/perpay-candidate-\d{8}[a-z]/app', str(previous)), 'invalid previous release')
    require(re.fullmatch(r'/opt/perpay-rc\d+-verify-\d{8}[a-z]?', str(target)), 'invalid validation directory')
    require(re.fullmatch(r'/root/perpay-recovery-\d{8}-rc\d+', str(recovery)), 'invalid recovery directory')
    require(archive.parent == recovery and re.fullmatch(r'[a-z0-9-]+\.tar\.gz', archive.name), 'invalid archive path')
    require(hashlib.sha256(archive.read_bytes()).hexdigest() == args.sha256 and not target.exists(), 'candidate archive differs or target exists')
    shutil.copytree(str(previous), str(target), symlinks=True)
    target.chmod(0o755)
    with tarfile.open(str(archive)) as bundle:
        for member in bundle.getmembers():
            path = os.path.realpath(os.path.join(str(target), member.name))
            require(path.startswith(str(target) + '/') and (member.isdir() or member.isfile()) and member.name.split('/')[0] in
                    ['dist', 'src', 'test', 'scripts', 'web-dist', 'static', 'package.json', 'package-lock.json'], 'unsafe archive member')
            member.mode = 0o755 if member.isdir() else 0o644
        bundle.extractall(str(target))
    old_lock, new_lock = [json.loads((root / 'package-lock.json').read_text()) for root in [previous, target]]
    old_lock['version'] = new_lock['version']
    old_lock['packages']['']['version'] = new_lock['packages']['']['version']
    require(old_lock == new_lock and new_lock['version'] == args.version, 'dependencies or version differ')
    subprocess.check_call([NODE, '--experimental-strip-types', '--test'] + ['test/' + name + '.test.ts' for name in TESTS], cwd=str(target))
    report = {'prepared': True, 'version': args.version, 'archiveSha256': args.sha256, 'target': str(target), 'productionChanged': False}
    with (recovery / 'prepared.json').open('x') as handle:
        json.dump(report, handle)
    print(json.dumps(report))


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ['previous', 'target', 'archive', 'sha256', 'recovery', 'version']:
        parser.add_argument('--' + option, required=True)
    prepare(parser.parse_args())
