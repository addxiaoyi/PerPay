"""Activate distinct merchant/admin frontends without changing payment callback owners."""
import importlib.util
import json
import os
from pathlib import Path

spec = importlib.util.spec_from_file_location('ops', '/root/perpay-recovery-20261106-rc5/switch-production-perpay.py')
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


def main():
    os.umask(0o077)
    recovery = Path('/root/perpay-recovery-20261106-rc10/separated-portals')
    ops.require(not recovery.exists(), 'portal routing checkpoint already exists')
    ops.require(ops.request('/pay/epay/readyz')[0] == 200, 'gateway is not ready')
    for mode in ['admin', 'merchant']:
        status, body = ops.request('/pay/' + mode + '/')
        ops.require(status == 200 and ('name="perpay-portal" content="' + mode + '"').encode() in body, 'candidate portal is unavailable')
    names = ['epay.conf', 'perpay-candidate-workspace.conf', 'perpay-maintenance-main.conf', 'perpay-cutover-entry.conf']
    previous = {name: (ops.PROXY / name).read_text() for name in names}
    changed = ops.proxy.render(previous['epay.conf'], previous['perpay-candidate-workspace.conf'], True, True)
    recovery.mkdir(mode=0o700)
    for name, content in previous.items():
        (recovery / name).write_text(content)
    try:
        ops.write_proxy(changed)
        checks = []
        for mode, paths in [('admin', ['', 'merchants', 'orders', 'system']), ('merchant', ['', 'orders', 'collect', 'profile'])]:
            for page in paths:
                path = '/pay/' + mode + '/' + page
                status, body = ops.request(path, origin='https://star-web.top')
                ops.require(status == 200 and ('name="perpay-portal" content="' + mode + '"').encode() in body, 'public portal document differs')
                checks.append(path)
        ops.require(ops.request('/pay/epay/readyz', origin='https://star-web.top')[0] == 200, 'gateway readiness changed')
        report = {'separatePortals': True, 'documentsVerified': checks, 'financialWrites': 0, 'legacyCallbackRoutingPreserved': True}
        (recovery / 'report.json').write_text(json.dumps(report))
        print(json.dumps(report))
    except BaseException:
        ops.write_proxy(previous)
        raise


if __name__ == '__main__':
    main()
