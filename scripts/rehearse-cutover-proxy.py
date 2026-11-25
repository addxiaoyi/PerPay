"""Exercise the exact cutover renderer with private upstreams and a separate Nginx master."""
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location('proxy', Path(__file__).with_name('cutover-proxy.py'))
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)
NGINX = '/www/server/nginx/sbin/nginx'
CONFIG = Path('/www/server/panel/vhost/nginx/extension/star-web.top')


class Upstream(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        count = int(self.headers.get('content-length', '0'))
        self.rfile.read(count)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'owner': self.server.owner, 'path': self.path}).encode())
    do_GET = do_POST
    def log_message(self, *args):
        pass


def main():
    directory = Path(tempfile.mkdtemp(prefix='perpay-ingress-', dir='/dev/shm'))
    directory.chmod(0o755)
    servers, master = [], None
    try:
        for owner in ['candidate', 'legacy', 'main']:
            server = http.server.HTTPServer(('127.0.0.1', 0), Upstream)
            server.owner = owner
            worker = threading.Thread(target=server.serve_forever)
            worker.daemon = True
            worker.start()
            servers.append(server)
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
        listener.close()
        baseline = (CONFIG / 'epay.conf').read_text()
        workspace = (CONFIG / 'perpay-candidate-workspace.conf').read_text()
        native = (CONFIG / 'perpay-native-endpoints.conf').read_text()
        # Preserve LightPay's observed location while replacing only its private test upstream.
        baseline = proxy.replace_exact(baseline, '/pay/notify.php', proxy.proxy('= /pay/notify.php', 'http://127.0.0.1:3023'))
        config = directory / 'nginx.conf'
        pid = directory / 'nginx.pid'
        def install(opened):
            sections = list(proxy.render(baseline, workspace, opened).values()) + [native, proxy.proxy('/api/', 'http://127.0.0.1:8787')]
            content = '\n'.join(sections).replace('include fastcgi_params;', '')
            for old, server in zip([16191, 3023, 8787], servers):
                content = content.replace('127.0.0.1:' + str(old), '127.0.0.1:' + str(server.server_port))
            config.write_text('pid ' + str(pid) + '; daemon off; error_log ' + str(directory / 'error.log') + '; events { worker_connections 64; }\nhttp { lua_package_path "/www/server/free_waf/?.lua;;"; access_log off; server { listen 127.0.0.1:' + str(port) + ';\n' + content + '\n} }')
            subprocess.check_call([NGINX, '-t', '-p', str(directory) + '/', '-c', str(config)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        def probe(path):
            request = urllib.request.Request('http://127.0.0.1:' + str(port) + path, data=b'probe', method='POST')
            try:
                response = urllib.request.urlopen(request, timeout=3)
            except urllib.error.HTTPError as error:
                return error.code, None
            with response:
                return response.status, json.loads(response.read())
        install(False)
        master = subprocess.Popen([NGINX, '-p', str(directory) + '/', '-c', str(config)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        checks = 0
        for phase, opened in [('maintenance', False), ('live', True), ('rollback', False)]:
            if phase != 'maintenance':
                children_path = Path('/proc/' + str(master.pid) + '/task/' + str(master.pid) + '/children')
                old_workers = children_path.read_text().split()
                install(opened)
                os.kill(int(pid.read_text()), signal.SIGHUP)
                for _ in range(50):
                    if not any(Path('/proc/' + child).exists() for child in old_workers):
                        break
                    time.sleep(0.1)
                else:
                    raise RuntimeError('previous isolated workers did not drain')
            expected = 200 if opened else 503
            ready = False
            for _ in range(30):
                try:
                    if probe('/pay/submit.php')[0] == expected:
                        ready = True
                        break
                except (OSError, ValueError):
                    if master.poll() is not None:
                        raise RuntimeError('isolated nginx exited')
                time.sleep(0.1)
            if not ready:
                raise RuntimeError('isolated ingress did not reach phase ' + phase)
            for path in proxy.ORDER_PATHS + ['/api/merchant/orders']:
                status, body = probe(path)
                if status != expected or (opened and body.get('owner') != 'candidate'):
                    raise RuntimeError('admission routing differs: ' + json.dumps({'phase': phase, 'path': path, 'expected': expected, 'status': status, 'owner': body.get('owner') if body else None}))
                checks += 1
            for path in proxy.LEGACY_CALLBACKS:
                status, body = probe(path)
                if status != 200 or body.get('owner') != 'legacy':
                    raise RuntimeError('legacy callback owner changed')
                checks += 1
            status, body = probe('/api/payment/wechat/notify')
            if status != 200 or body.get('owner') != 'main':
                raise RuntimeError('main WeChat callback owner changed')
            checks += 1
            for path in ['/pay/epay/alipay/notify', '/pay/epay/wechat/notify']:
                status, body = probe(path)
                if status != 200 or body.get('owner') != 'candidate':
                    raise RuntimeError('native callback owner changed')
                checks += 1
        report = {'maintenance': True, 'live': True, 'rollback': True, 'legacyCallbackOwnersPreserved': True,
                  'nativeCallbackOwnersPreserved': True, 'syntheticChecks': checks, 'productionChanged': False}
        target = Path('/root/perpay-recovery-20261106-rc5/ingress-final-rehearsal.json')
        with target.open('x') as handle:
            json.dump(report, handle)
        print(json.dumps(report))
    finally:
        if master and master.poll() is None:
            master.terminate()
            master.wait(timeout=10)
        for server in servers:
            server.shutdown()
            server.server_close()
        shutil.rmtree(str(directory))


if __name__ == '__main__':
    os.umask(0o077)
    main()
