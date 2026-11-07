import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('proxy', Path(__file__).parents[1] / 'scripts/cutover-proxy.py')
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class CutoverProxyTest(unittest.TestCase):
    def test_payment_admission_and_callback_ownership(self):
        legacy = '\n'.join('location = ' + path + ' { proxy_pass http://127.0.0.1:3023; }' for path in ['/pay', '/pay/submit.php', '/pay/mapi.php', '/pay/api.php'])
        callback = 'location = /pay/notify.php { fastcgi_pass unix:/tmp/php-cgi-82.sock; }'
        legacy += '\n' + callback + '\nlocation ^~ /pay/ { proxy_pass http://127.0.0.1:3023; }'
        workspace = 'location ^~ /pay/api/merchant/epay/ {\n    limit_except GET { deny all; }\n}'
        for opened in [False, True]:
            rendered = proxy.render(legacy, workspace, opened)
            self.assertIn(callback, rendered['epay.conf'])
            self.assertIn('location ^~ /pay/ { proxy_pass http://127.0.0.1:3023; }', rendered['epay.conf'])
            self.assertEqual('payment_maintenance' in rendered['perpay-cutover-entry.conf'], not opened)
            self.assertIn('GET POST', rendered['perpay-candidate-workspace.conf'])
            self.assertIn('/pay/admin/merchant-workspace$is_args$args', rendered['epay.conf'])
            self.assertNotIn('/api/pay/wechat/notify', rendered['perpay-cutover-entry.conf'])

    def test_missing_or_duplicate_location_is_not_silently_replaced(self):
        for source in ['location = /elsewhere { return 404; }', 'location = /pay { return 404; }\nlocation = /pay { return 404; }']:
            with self.assertRaises(RuntimeError):
                proxy.replace_exact(source, '/pay', 'replacement')

    def test_reopening_maintenance_retains_guard_locations(self):
        legacy = '\n'.join('location = ' + path + ' { proxy_pass http://127.0.0.1:3023; }' for path in ['/pay', '/pay/submit.php', '/pay/mapi.php', '/pay/api.php'])
        legacy += '\nlocation = /pay/notify.php { fastcgi_pass unix:/tmp/php-cgi-82.sock; }'
        legacy += '\nlocation = /pay/api/balance { return 403; }'
        closed = proxy.render(legacy, '', False)
        opened = proxy.render(closed['epay.conf'], closed['perpay-candidate-workspace.conf'], True)
        self.assertNotIn('payment_maintenance', opened['epay.conf'])
        self.assertIn('location = /pay/api/balance { return 403; }', opened['epay.conf'])
        self.assertIn('fastcgi_pass unix:/tmp/php-cgi-82.sock', opened['epay.conf'])

    def test_separate_portals_survive_maintenance_and_reopening(self):
        legacy = '\n'.join('location = ' + path + ' { proxy_pass http://127.0.0.1:3023; }' for path in ['/pay', '/pay/submit.php', '/pay/mapi.php', '/pay/api.php'])
        legacy += '\nlocation = /pay/notify.php { fastcgi_pass unix:/tmp/php-cgi-82.sock; }'
        opened = proxy.render(legacy, '', True, True)
        closed = proxy.render(opened['epay.conf'], opened['perpay-candidate-workspace.conf'], False)
        resumed = proxy.render(closed['epay.conf'], closed['perpay-candidate-workspace.conf'], True)
        self.assertEqual(opened, resumed)
        self.assertIn('location ^~ /pay/merchant/', resumed['perpay-candidate-workspace.conf'])
        self.assertIn('location ^~ /pay/admin/', resumed['perpay-candidate-workspace.conf'])
        self.assertNotIn('return 302 /pay/admin/merchant-workspace', resumed['perpay-cutover-entry.conf'])


if __name__ == '__main__':
    unittest.main()
