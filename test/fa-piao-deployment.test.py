import importlib.util
from pathlib import Path
import sys
from types import ModuleType
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('fa_deployment', Path(__file__).parents[1] / 'scripts/deploy-release-copy.py')
deployment = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'pwd': ModuleType('pwd')}):
    spec.loader.exec_module(deployment)


class FaPiaoDeploymentTest(unittest.TestCase):
    def test_closes_invoice_flags_and_preserves_payment_service_configuration(self):
        unit = '[Unit]\nDescription=Payment\n[Service]\nEnvironment="PERPAY_EPAY_GATEWAY_MODE=live"\nEnvironment=PERPAY_TAX_INVOICE_ENABLED=true\nEnvironment="PERPAY_EPAY_INVOICE_ENABLED=true"\n[Install]\nWantedBy=multi-user.target\n'
        configured = deployment.configure_fa_invoices(unit, '/var/lib/perpay-candidate-20261122a/secrets/fa-piao.private.json')
        self.assertIn('PERPAY_EPAY_GATEWAY_MODE=live', configured)
        for name in ['PERPAY_TAX_INVOICE_ENABLED', 'PERPAY_EPAY_INVOICE_ENABLED', 'PERPAY_TAX_INVOICE_AUTO_SYNC_ENABLED']:
            self.assertEqual(configured.count(name + '='), 1)
            self.assertIn(name + '=false', configured)
        self.assertIn('PERPAY_TAX_INVOICE_PROVIDER=fa-piao', configured)
        self.assertLess(configured.index('PERPAY_TAX_INVOICE_PROVIDER'), configured.index('[Install]'))

    def test_rejects_environment_files_and_ambiguous_assignments(self):
        for unit in ['[Service]\nEnvironmentFile=/tmp/override\n',
                     '[Service]\nEnvironment="PERPAY_TAX_INVOICE_ENABLED=true PERPAY_EPAY_INVOICE_ENABLED=true"\n']:
            with self.assertRaises(RuntimeError):
                deployment.configure_fa_invoices(unit, '/run/secrets/fa-piao.private.json')


if __name__ == '__main__':
    unittest.main()
