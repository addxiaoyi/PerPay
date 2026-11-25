"""Install reviewed persistence and identity changes without restoring older data."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request
import urllib.error

ROOT = Path('/www/wwwroot/starmc-api')
RECOVERY = Path('/root/perpay-recovery-20261104')
NODE24 = '/opt/perpay-shadow-20261103/runtime/bin/node'
FILES = [
    ('src/persist.js', 'persist.js', '93d415433c16f674a3e972a0e7ebb19c313a2253ff51afa9871861a01d818afb', 'd05e8d5fef8cc6099e6ee567832e9ce1f3e6e7dc689746e932bf49de3a51e30d'),
    ('src/modules/payment/routes.js', 'payment-routes-identity.js', 'a2f62ed81e0679369c41b64cf4c4d76125bdb665b2e65d9335eef765cb1b8dac', 'b1e3a3ea13f64035935d4022404ea8934df02c9c0ed225615cf9bd86fd583e42'),
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_queues(payment):
    for name in ['callbacks', 'syncJobs', 'orderMirrors']:
        if any(row.get('status') not in ['succeeded', 'dead_letter'] for row in payment.get(name, [])):
            raise RuntimeError('payment background work has not drained')
    if any(row.get('status') in ['pending_sync', 'pending_payment', 'refund_processing'] for row in payment['orders']):
        raise RuntimeError('main payment orders have not drained')


def replace_file(source, target):
    temporary = target.with_name(target.name + '.perpay-recovery-new')
    with temporary.open('xb') as handle:
        handle.write(source.read_bytes())
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(str(temporary), 0o644)
    os.replace(str(temporary), str(target))


def health():
    with urllib.request.urlopen('http://127.0.0.1:8787/health', timeout=3) as response:
        return json.loads(response.read())


def restart():
    subprocess.check_call(['pm2', 'restart', 'starmc-api', '--kill-timeout', '15000'], stdout=subprocess.DEVNULL)
    for _ in range(20):
        try:
            observed = health()
            if observed.get('ok') and 'saveConflict' in observed.get('persist', {}):
                return observed
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError('new main service did not become healthy')


def main():
    for relative, candidate, prior, current in FILES:
        if digest(ROOT / relative) != prior or digest(RECOVERY / candidate) != current:
            raise RuntimeError('release source hash mismatch')
        subprocess.check_call(['/usr/bin/node', '--check', str(RECOVERY / candidate)], stdout=subprocess.DEVNULL)
    before = json.loads((ROOT / 'data/store.json').read_text())
    check_queues(before['payment'])
    recipient = json.loads((RECOVERY / 'recipient.json').read_text())
    subprocess.check_call([NODE24, str(RECOVERY / 'seal-store-file.mjs'), str(ROOT / 'data/store.json'), str(RECOVERY / 'recovery-public.pem'), recipient['fingerprint'], str(RECOVERY / 'before-identity-deploy.json')])
    backup = RECOVERY / 'main-code-before-identity'
    backup.mkdir(mode=0o700)
    prior_mode = (ROOT / 'data').stat().st_mode & 0o777
    (backup / 'manifest.json').write_text(json.dumps({'files': FILES, 'dataMode': prior_mode}))
    for relative, _, _, _ in FILES:
        destination = backup / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(ROOT / relative), str(destination))
    try:
        os.chmod(str(ROOT / 'data'), 0o755)
        for relative, candidate, _, _ in FILES:
            replace_file(RECOVERY / candidate, ROOT / relative)
        observed = restart()
        after = json.loads((ROOT / 'data/store.json').read_text())
        for name in ['merchants', 'ledger', 'orders', 'callbacks', 'syncJobs', 'settlements', 'refunds']:
            if before['payment'].get(name) != after['payment'].get(name):
                raise RuntimeError('payment records changed across deployment: ' + name)
        if len(after['users']) < len(before['users']) or observed['persist'].get('saveConflict'):
            raise RuntimeError('persisted state validation failed')
        try:
            urllib.request.urlopen('http://127.0.0.1:8787/api/merchant/access?merchantId=probe', timeout=3)
            raise RuntimeError('unauthenticated identity request accepted')
        except urllib.error.HTTPError as error:
            if error.code != 401:
                raise RuntimeError('identity route is unavailable')
        subprocess.check_call([NODE24, str(RECOVERY / 'seal-store-file.mjs'), str(ROOT / 'data/store.json'), str(RECOVERY / 'recovery-public.pem'), recipient['fingerprint'], str(RECOVERY / 'after-identity-deploy.json')])
        print(json.dumps({'deployed': True, 'identityUnauthorizedStatus': 401, 'paymentRecordsUnchanged': True, 'persist': observed['persist']}))
    except Exception:
        for relative, _, _, _ in FILES:
            replace_file(backup / relative, ROOT / relative)
        os.chmod(str(ROOT / 'data'), prior_mode)
        subprocess.check_call(['pm2', 'restart', 'starmc-api', '--kill-timeout', '15000'], stdout=subprocess.DEVNULL)
        raise


main()
