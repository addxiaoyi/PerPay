"""Install only PerPay readiness and native callbacks; preserve old order ingress."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request

TARGET = Path('/www/server/panel/vhost/nginx/extension/star-web.top/perpay-native-endpoints.conf')
NGINX = '/www/server/nginx/sbin/nginx'
RECOVERY = Path('/root/perpay-recovery-20261105/native-endpoints-v3')
ENDPOINTS = ['/pay/epay/readyz', '/pay/epay/alipay/notify', '/pay/epay/wechat/notify']


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def nginx_master():
    # This host uses a generated SysV unit without systemd MainPID tracking.
    masters = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            if (entry / 'comm').read_text().strip() != 'nginx':
                continue
            command = (entry / 'cmdline').read_bytes().replace(b'\x00', b' ').decode()
            if command.startswith('nginx: master process ' + NGINX + ' -c /www/server/nginx/conf/nginx.conf') and os.readlink(str(entry / 'exe')) == NGINX:
                started = (entry / 'stat').read_text().rsplit(') ', 1)[1].split()[19]
                masters.append((entry.name, started))
        except FileNotFoundError:
            continue
    require(len(masters) == 1, 'expected one verified nginx master for production config')
    return masters[0]


def request(path, method='GET'):
    headers = {'Content-Type': 'application/json'} if method == 'POST' else {}
    payload = b'{}' if method == 'POST' else None
    try:
        response = urllib.request.urlopen(urllib.request.Request('https://star-web.top' + path, data=payload, method=method, headers=headers), timeout=10)
    except urllib.error.HTTPError as response:
        return response.code, response.read()
    with response:
        return response.status, response.read()


def run(args):
    archive = Path(args.source)
    content = archive.read_bytes()
    require(re.fullmatch('[a-f0-9]{64}', args.sha256) and hashlib.sha256(content).hexdigest() == args.sha256, 'endpoint artifact digest mismatch')
    locations = re.findall(r'^location = ([^ ]+) ', content.decode(), re.M)
    require(locations == ENDPOINTS and content.count(b'proxy_pass http://127.0.0.1:16191;') == 3, 'unexpected endpoint routing')
    require(not TARGET.exists() and not RECOVERY.exists(), 'endpoint release already exists')
    RECOVERY.mkdir(mode=0o700)
    shutil.copy2('/www/server/panel/vhost/nginx/star-web.top.conf', str(RECOVERY / 'star-web-before.conf'))
    shutil.copy2('/etc/systemd/system/perpay-candidate.service', str(RECOVERY / 'candidate-before.service'))
    master_before = nginx_master()
    installed = False
    try:
        with TARGET.open('xb') as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        installed = True
        TARGET.chmod(0o644)
        subprocess.check_call([NGINX, '-t'])
        subprocess.check_call(['systemctl', 'reload', 'nginx'])
        master_after = nginx_master()
        require(master_before == master_after, 'nginx master changed during reload')
        require(Path('/www/server/nginx/logs/nginx.pid').read_text().strip() == master_after[0], 'nginx PID file was not repaired by safe reload')
        # A successful reload signal precedes worker replacement; old workers may
        # still answer the first request using the previous location table.
        readiness_seen = False
        for attempt in range(20):
            status, body = request(ENDPOINTS[0])
            try:
                health = json.loads(body)
            except ValueError:
                health = {}
            if status == 503 and health.get('code') == 'epay_maintenance' and health.get('configurationReady') is True:
                readiness_seen = True
                break
            time.sleep(0.25)
        require(readiness_seen, 'native readiness did not converge after reload (HTTP ' + str(status) + ')')
        for endpoint in ENDPOINTS[1:]:
            status, body = request(endpoint, 'POST')
            require(status == 400, 'unsigned notification was not rejected')
        ingress = {}
        for endpoint in ['/pay', '/pay/submit.php', '/pay/mapi.php']:
            status, _ = request(endpoint)
            require(status == 503, 'legacy new-order ingress unexpectedly opened')
            ingress[endpoint] = status
        report = {'installed': True, 'sha256': args.sha256, 'gracefulReload': True, 'maintenance': True, 'unsignedCallbacksRejected': True, 'newOrderIngress': ingress, 'productionCutover': False}
        with (RECOVERY / 'report.json').open('x') as handle:
            json.dump(report, handle)
        print(json.dumps(report))
    except BaseException:
        if installed:
            require(hashlib.sha256(TARGET.read_bytes()).hexdigest() == args.sha256, 'endpoint configuration changed concurrently; preserve for review')
            TARGET.unlink()
            subprocess.check_call([NGINX, '-t'])
            subprocess.check_call(['systemctl', 'reload', 'nginx'])
        raise


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--sha256', required=True)
    run(parser.parse_args())
