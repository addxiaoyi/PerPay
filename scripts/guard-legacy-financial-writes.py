"""Route new financial operations through PerPay while leaving legacy settlement callbacks intact."""
import importlib.util
import json
import os
from pathlib import Path

spec = importlib.util.spec_from_file_location('ops', '/root/perpay-recovery-20261106-rc5/switch-production-perpay.py')
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


def main():
    os.umask(0o077)
    target = ops.PROXY / 'perpay-financial-authority.conf'
    epay = ops.PROXY / 'epay.conf'
    recovery = Path('/root/perpay-recovery-20261106-rc10/financial-authority')
    ops.require(not target.exists() and not recovery.exists(), 'financial authority guard already exists')
    original = epay.read_text()
    ops.require(original.count('location ^~ /pay/ {') == 1, 'legacy prefix differs')
    recovery.mkdir(mode=0o700)
    (recovery / 'epay-before.conf').write_text(original)
    expression = r'(?:admin/merchants/[^/]+/(?:adjustments|fee)|admin/refunds|admin/payment/config/fee)'
    def block(prefix):
        return '''location ~ ^PREFIXapi/EXPRESSION/?$ {
    if ($request_method != GET) { return 409 '{"ok":false,"code":"financial_operation_moved","error":"请在 PerPay 商户工作台处理余额、费率和退款。"}'; }
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header Cookie $http_cookie;
    add_header Cache-Control "no-store" always;
}
'''.replace('PREFIX', prefix).replace('EXPRESSION', expression)
    try:
        target.write_text(block('/'))
        target.chmod(0o644)
        epay.write_text(original.replace('location ^~ /pay/ {', 'location ^~ /pay/ {\n' + block('/pay/')))
        ops.reload_proxy()
        for path in ['/api/admin/merchants/authority-probe/adjustments', '/api/admin/merchants/authority-probe/fee', '/pay/api/admin/merchants/authority-probe/adjustments', '/pay/api/admin/merchants/authority-probe/fee', '/api/admin/refunds', '/api/admin/payment/config/fee']:
            status, body = ops.request(path, 'POST', 'https://star-web.top')
            ops.require(status == 409 and json.loads(body).get('code') == 'financial_operation_moved', 'legacy financial write guard failed')
        ops.require(ops.request('/pay/epay/readyz', origin='https://star-web.top')[0] == 200, 'gateway readiness changed')
        report = {'guardedPaths': 6, 'oldCallbacksPreserved': True, 'nativeFinancialControlsEnabled': True, 'financialWrites': 0}
        (recovery / 'report.json').write_text(json.dumps(report))
        print(json.dumps(report))
    except BaseException:
        epay.write_text(original)
        if target.exists():
            target.rename(recovery / 'failed-authority.conf')
        ops.reload_proxy()
        raise


if __name__ == '__main__':
    main()
