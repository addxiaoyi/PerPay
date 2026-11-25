"""Disable only new invoice requests at both public ingress paths; retain historical reads."""
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path('/www/server/panel/vhost/nginx/extension/star-web.top')
EPAY = ROOT / 'epay.conf'
INVOICE = ROOT / 'perpay-invoice-maintenance.conf'
RECOVERY = Path('/root/perpay-recovery-20261106-rc4/invoice-disabled')
NGINX = '/www/server/nginx/sbin/nginx'
BODY = '{"ok":false,"code":"invoice_maintenance","error":"暂未开放新的开票申请，历史发票仍可查看。"}'


def deny_block(location):
    return ('location ' + location + ' {\n'
            '    default_type application/json;\n'
            '    charset utf-8;\n'
            '    add_header Cache-Control "no-store" always;\n'
            '    return 503 \'' + BODY + '\';\n}\n')


def master():
    pid = int(Path('/www/server/nginx/logs/nginx.pid').read_text().strip())
    command = Path('/proc/' + str(pid) + '/cmdline').read_bytes()
    if b'nginx: master process /www/server/nginx/sbin/nginx' not in command:
        raise RuntimeError('nginx master identity differs')
    return pid


def request(path, method='POST'):
    req = urllib.request.Request('https://star-web.top' + path, method=method,
                                 data=b'{}' if method == 'POST' else None,
                                 headers={'content-type': 'application/json', 'cache-control': 'no-cache'})
    try:
        response = urllib.request.urlopen(req, timeout=10)
    except urllib.error.HTTPError as error:
        return error.code, error.read()
    with response:
        return response.status, response.read()


def main():
    os.umask(0o077)
    original = EPAY.read_text()
    if INVOICE.exists() or RECOVERY.exists() or original.count('location ^~ /pay/ {') != 1:
        raise RuntimeError('invoice routing already exists or payment ingress differs')
    RECOVERY.mkdir(mode=0o700)
    (RECOVERY / 'epay-before.conf').write_text(original)
    pid = master()
    nested = deny_block('~ ^/pay/api/merchant/orders/[^/]+/invoice/?$')
    changed = original.replace('location ^~ /pay/ {', 'location ^~ /pay/ {\n' + nested)
    ingress = deny_block('= /pay/invoice.php') + deny_block('~ ^/api/(?:payment/invoice/[^/]+|merchant/orders/[^/]+/invoice)/?$')
    try:
        EPAY.write_text(changed)
        INVOICE.write_text(ingress)
        INVOICE.chmod(0o644)
        subprocess.check_call([NGINX, '-t'])
        os.kill(pid, signal.SIGHUP)
        for _ in range(10):
            status, body = request('/pay/invoice.php')
            if status == 503 and json.loads(body).get('code') == 'invoice_maintenance':
                break
            time.sleep(0.5)
        for path in ['/pay/invoice.php', '/pay/api/merchant/orders/invoice-route-probe/invoice', '/api/merchant/orders/invoice-route-probe/invoice', '/api/payment/invoice/invoice-route-probe']:
            status, body = request(path)
            if status != 503 or json.loads(body).get('code') != 'invoice_maintenance':
                raise RuntimeError('new invoice ingress was not disabled')
        if request('/pay/healthz', 'GET')[0] != 200 or master() != pid:
            raise RuntimeError('candidate health or nginx master changed')
        report = {'newInvoicesDisabled': True, 'checkedPaths': 4, 'existingInvoicesPreserved': True,
                  'gracefulReload': True, 'nginxMasterUnchanged': True, 'providerRequests': 0}
        (RECOVERY / 'report.json').write_text(json.dumps(report))
        print(json.dumps(report))
    except BaseException:
        EPAY.write_text(original)
        if INVOICE.exists():
            INVOICE.rename(RECOVERY / 'failed-invoice.conf')
        subprocess.check_call([NGINX, '-t'])
        os.kill(master(), signal.SIGHUP)
        raise


if __name__ == '__main__':
    main()
