"""Render explicit PerPay routes while retaining historical callbacks and checkout owners."""
import re

ORDER_PATHS = ['/pay/submit.php', '/pay/mapi.php', '/pay/epay/submit.php', '/pay/epay/mapi.php', '/pay/api/merchant/orders', '/pay/epay/main/orders']
WORKSPACE_PATHS = ['/pay/', '/pay/merchant', '/pay/admin', '/pay/admin/', '/pay/admin/merchants', '/pay/admin/orders']
LEGACY_CALLBACKS = ['/pay/api/pay/alipay/notify', '/pay/api/pay/wechat/notify', '/pay/notify.php']


def proxy(location, target, admission=False, open_orders=False):
    closed = '    return 503 \'{"ok":false,"code":"payment_maintenance"}\';\n' if admission and not open_orders else ''
    return ('location ' + location + ' {\n' + closed +
            '    client_max_body_size 1m;\n'
            '    proxy_pass ' + target + ';\n'
            '    proxy_http_version 1.1;\n'
            '    proxy_set_header Host $host;\n'
            '    proxy_set_header X-Forwarded-Proto $scheme;\n'
            '    proxy_set_header X-Forwarded-For $remote_addr;\n'
            '    proxy_set_header Connection "";\n'
            '    proxy_next_upstream off;\n'
            '    proxy_read_timeout 20s;\n'
            '    proxy_cache off;\n'
            '    add_header Cache-Control "no-store" always;\n}\n')


def replace_exact(source, path, replacement):
    # Maintenance JSON contains braces inside quotes; they are not Nginx blocks.
    directives = r'''(?:[^{}'\"]|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")*'''
    pattern = r'location = ' + re.escape(path) + r' \{' + directives + r'\}'
    changed, count = re.subn(pattern, lambda _: replacement.rstrip(), source)
    if count != 1:
        raise RuntimeError('expected payment location differs: ' + path)
    return changed


def render(epay, workspace, open_orders, separate_portals=False):
    separate_portals = separate_portals or '# PerPay separated portals' in workspace
    previous_callbacks = []
    for path in ['/pay/notify.php']:
        match = re.search(r'location = ' + re.escape(path) + r' \{[^{}]*\}', epay)
        if not match:
            raise RuntimeError('legacy callback location is missing')
        previous_callbacks.append(match.group(0))
    for path in ['/pay/submit.php', '/pay/mapi.php', '/pay/api.php']:
        epay = replace_exact(epay, path, proxy('= ' + path, 'http://127.0.0.1:16191', path != '/pay/api.php', open_orders))
    entry = '/pay/merchant/' if separate_portals else '/pay/admin/merchant-workspace'
    epay = replace_exact(epay, '/pay', 'location = /pay { return 302 ' + entry + '$is_args$args; }')
    if separate_portals:
        additional = 'location = /pay/ { return 302 /pay/merchant/$is_args$args; }\n'
        additional += ''.join(proxy('= ' + path, 'http://127.0.0.1:16191') for path in WORKSPACE_PATHS[1:])
        if '# PerPay separated portals' not in workspace:
            workspace += '\n# PerPay separated portals\n' + proxy('^~ /pay/admin/', 'http://127.0.0.1:16191') + proxy('^~ /pay/merchant/', 'http://127.0.0.1:16191')
    else:
        additional = ''.join('location = ' + path + ' { return 302 /pay/admin/merchant-workspace$is_args$args; }\n' for path in WORKSPACE_PATHS)
    additional += ''.join(proxy('= ' + path, 'http://127.0.0.1:16191', True, open_orders) for path in ORDER_PATHS[2:])
    additional += proxy('= /pay/epay/api.php', 'http://127.0.0.1:16191')
    additional += proxy('= /pay/epay/checkout-status', 'http://127.0.0.1:16191')
    additional += proxy('= /pay/checkout-status', 'http://127.0.0.1:16191/pay/epay/checkout-status')
    additional += proxy('^~ /pay/epay/main/checkout/', 'http://127.0.0.1:16191')
    additional += proxy('^~ /pay/epay/main/payment/', 'http://127.0.0.1:16191')
    additional += 'location = /pay/api/test-pay { return 503; }\n'
    additional += 'location = /pay/test-pay { return 302 ' + ('/pay/merchant/collect' if separate_portals else '/pay/admin/merchant-workspace') + '; }\n'
    additional += 'location = /api/internal/payment/merchant-auth { return 404; }\n'
    for kind in ['checkout', 'order', 'receipt']:
        additional += proxy('^~ /pay/api/payment/' + kind + '/', 'http://127.0.0.1:16191')
    # Authenticated reads keep reaching their owner even while new order admission is paused.
    main = proxy('= /api/merchant/orders', 'http://127.0.0.1:16191/pay/api/merchant/orders')
    if not open_orders:
        main = main.replace('    client_max_body_size', '    if ($request_method = POST) { return 503; }\n    client_max_body_size', 1)
    for kind in ['checkout', 'order', 'receipt']:
        main += proxy('^~ /api/payment/' + kind + '/', 'http://127.0.0.1:16191/pay/api/payment/' + kind + '/')
    main += 'location ~* ^/api/internal/payment/epay-order/?$ { return 503; }\n'
    workspace = workspace.replace('    limit_except GET { deny all; }\n', '    limit_except GET POST { deny all; }\n', 1)
    if not all(callback in epay for callback in previous_callbacks):
        raise RuntimeError('legacy callback was changed')
    return {'epay.conf': epay, 'perpay-candidate-workspace.conf': workspace,
            'perpay-maintenance-main.conf': main, 'perpay-cutover-entry.conf': additional}
