"""Keep new merchant creation on the persistent enrollment route while preserving main identity reads."""
import importlib.util
import json
import os
from pathlib import Path

spec = importlib.util.spec_from_file_location('ops', '/root/perpay-recovery-20261106-rc5/switch-production-perpay.py')
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


def main():
    os.umask(0o077)
    target = ops.PROXY / 'perpay-merchant-enrollment.conf'
    recovery = Path('/root/perpay-recovery-20261106-rc8')
    ops.require(not target.exists(), 'legacy enrollment guard already exists')
    content = ''
    for path in ['/api/admin/merchants', '/pay/api/admin/merchants']:
        content += '''location = PATH {
    if ($request_method = POST) { return 409 '{"ok":false,"code":"merchant_creation_moved","error":"请在支付工作台的新增商户页面提交申请。"}'; }
    proxy_pass http://127.0.0.1:8787/api/admin/merchants;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Cookie $http_cookie;
    proxy_set_header Connection "";
    add_header Cache-Control "no-store" always;
}
'''.replace('PATH', path)
    try:
        target.write_text(content)
        target.chmod(0o644)
        ops.reload_proxy()
        for path in ['/api/admin/merchants', '/pay/api/admin/merchants']:
            status, body = ops.request(path, 'POST', 'https://star-web.top')
            ops.require(status == 409 and json.loads(body).get('code') == 'merchant_creation_moved', 'legacy creation guard did not apply')
        ops.require(ops.request('/pay/epay/readyz', origin='https://star-web.top')[0] == 200, 'gateway health changed')
        report = {'legacyCreationClosed': True, 'identityReadsRetained': True, 'nativeEnrollmentEnabled': True, 'createdMerchants': 0}
        (recovery / 'enrollment-ingress.json').write_text(json.dumps(report))
        print(json.dumps(report))
    except BaseException:
        if target.exists():
            target.rename(recovery / 'failed-enrollment-ingress.conf')
        ops.reload_proxy()
        raise


if __name__ == '__main__':
    main()
