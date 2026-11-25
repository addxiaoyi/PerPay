import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import MagicMock, Mock, patch


if sys.platform == 'win32':
    sys.modules.setdefault('pwd', types.ModuleType('pwd'))
    sys.modules.setdefault('grp', types.ModuleType('grp'))
path = Path(__file__).resolve().parents[1] / 'scripts/install-payment-automation.py'
spec = importlib.util.spec_from_file_location('payment_automation_install', path)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallationTests(unittest.TestCase):
    def units(self):
        return installer.render_units('/opt/perpay/app', '/var/lib/perpay-data', '/opt/node/bin/node',
            '/var/lib/perpay-data/secrets/invoice.json', '/var/lib/perpay-alerts/notify.private.json')

    def test_keeps_financial_monitor_network_isolated(self):
        units = self.units()
        audit = units['perpay-integrity.service.d/30-automation.conf']
        self.assertNotIn('PrivateNetwork=false', audit)
        self.assertIn('--delivery-state /var/lib/perpay-alerts/delivery.json', audit)
        self.assertIn('--invoice-readiness /var/lib/perpay-alerts/invoice-readiness.json', audit)

    def test_sender_ends_before_delivery_lease_can_be_reclaimed(self):
        service = self.units()['perpay-payment-delivery.service']
        self.assertIn('TimeoutStartSec=100', service)
        self.assertIn('User=perpay-candidate', service)
        self.assertIn('ProtectSystem=strict', service)
        self.assertNotIn('PrivateNetwork=yes', service)

    def test_invoice_diagnostic_cannot_enable_issuance(self):
        service = self.units()['perpay-invoice-readiness.service']
        self.assertIn('PERPAY_TAX_INVOICE_ENABLED=false', service)
        self.assertIn('PERPAY_TAX_INVOICE_AUTO_SYNC_ENABLED=false', service)
        self.assertIn('--remote --output', service)
        self.assertIn('SuccessExitStatus=2', service)
        self.assertIn('OnUnitInactiveSec=30min', self.units()['perpay-invoice-readiness.timer'])

    def test_does_not_install_backup_jobs(self):
        self.assertEqual(len(self.units()), 5)
        self.assertFalse(any('backup' in name for name in self.units()))

    def test_rejects_systemd_injection_and_ambiguous_paths(self):
        for value in ['/opt/app\nUser=root', '/opt/../root/app', 'relative/path', '/opt/app with space']:
            with self.assertRaises(ValueError):
                installer.unit_path(value)

    def test_rollback_supports_legacy_unlink_and_restores_remaining_files(self):
        removed = Mock()
        missing = Mock()
        missing.unlink.side_effect = FileNotFoundError()
        existing = Mock()
        with patch.object(installer, 'atomic_file') as write:
            installer.restore_files({removed: None, missing: None, existing: b'original unit'})
        removed.unlink.assert_called_once_with()
        missing.unlink.assert_called_once_with()
        write.assert_called_once_with(existing, b'original unit')

    def test_rollback_does_not_hide_storage_errors(self):
        denied = Mock()
        denied.unlink.side_effect = PermissionError('cannot restore unit')
        with self.assertRaises(PermissionError):
            installer.restore_files({denied: None})

    def systemd(self, present=True, enabled=True, active=True):
        timers = {name: {'present': present, 'enabled': enabled, 'active': active} for name in
                  ['perpay-payment-delivery.timer', 'perpay-invoice-readiness.timer']}

        def run(command, **options):
            action = command[1]
            if action == 'daemon-reload':
                return Mock(returncode=0)
            timer = command[2] if action == 'show' else command[-1]
            state = timers[timer]
            if action == 'show':
                load = 'loaded' if state['present'] else 'not-found'
                unit = ('enabled' if state['enabled'] else 'disabled') if state['present'] else ''
                status = 'active' if state['active'] else 'inactive'
                return Mock(returncode=0, stdout='LoadState={}\nUnitFileState={}\nActiveState={}\n'.format(load, unit, status))
            if action in ['enable', 'disable']:
                state['enabled'] = action == 'enable'
                if '--now' in command:
                    state['active'] = state['enabled']
            elif action in ['start', 'stop']:
                state['active'] = action == 'start'
            else:
                self.fail('unexpected systemd action: ' + action)
            return Mock(returncode=0)

        return timers, run

    def test_upgrade_failure_restores_enabled_and_active_timers_after_files(self):
        timers, run = self.systemd()
        restored = Mock()
        with patch.object(installer.subprocess, 'run', side_effect=run):
            before = installer.read_timer_states(timers)
            for state in timers.values():
                state.update(enabled=False, active=False)
            with patch.object(installer, 'restore_files', restored):
                installer.rollback_install({}, before)
        restored.assert_called_once_with({})
        self.assertEqual(timers, before)

    def test_failed_install_preserves_disabled_inactive_timers(self):
        timers, run = self.systemd(enabled=False, active=False)
        with patch.object(installer.subprocess, 'run', side_effect=run), patch.object(installer, 'restore_files'):
            before = installer.read_timer_states(timers)
            for state in timers.values():
                state.update(enabled=True, active=True)
            installer.rollback_install({}, before)
        self.assertEqual(timers, before)

    def test_first_install_failure_removes_new_files_and_leaves_no_enabled_timer(self):
        timers, run = self.systemd(present=False, enabled=False, active=False)
        saved = {}
        with patch.object(installer.subprocess, 'run', side_effect=run):
            before = installer.read_timer_states(timers)
            for timer, state in timers.items():
                state.update(present=True, enabled=True, active=True)
                path = Mock()
                path.unlink.side_effect = lambda state=state: state.update(present=False)
                saved[path] = None
            installer.rollback_install(saved, before)
        self.assertEqual(timers, before)
        for path in saved:
            path.unlink.assert_called_once_with()

    def test_timer_state_read_failure_precedes_any_installation_changes(self):
        path = MagicMock()
        path.is_file.return_value = True
        path.__truediv__.return_value.is_file.return_value = True
        argv = ['install-payment-automation.py', '--app-root', '/opt/perpay/app', '--data-root', '/var/lib/perpay-data',
                '--node', '/opt/node/bin/node', '--credential-file', '/var/lib/perpay-data/secrets/invoice.json',
                '--smtp-config', '/var/lib/perpay-alerts/notify.private.json', '--apply']
        unavailable = Mock(returncode=1, stdout='')
        with patch.object(sys, 'argv', argv), patch.object(installer, 'Path', return_value=path), \
                patch.object(installer.os, 'geteuid', return_value=0, create=True), \
                patch.object(installer.subprocess, 'run', return_value=unavailable), \
                patch.object(installer, 'atomic_file') as copy, patch.object(installer.os, 'chown', create=True) as chown:
            with self.assertRaisesRegex(RuntimeError, 'timer_state_unavailable'):
                installer.main()
        path.mkdir.assert_not_called()
        copy.assert_not_called()
        chown.assert_not_called()

    def test_install_rollback_does_not_swallow_storage_errors_or_restart_timers(self):
        timers, run = self.systemd()
        with patch.object(installer.subprocess, 'run', side_effect=run) as command:
            before = installer.read_timer_states(timers)
            with patch.object(installer, 'restore_files', side_effect=PermissionError('cannot restore unit')):
                with self.assertRaises(PermissionError):
                    installer.rollback_install({}, before)
        self.assertFalse(any(call[0][0][1] in ['start', 'enable'] for call in command.call_args_list))

    def test_install_target_rejects_hard_links_before_writing(self):
        with tempfile.TemporaryDirectory() as folder:
            original = Path(folder) / 'original'
            original.write_bytes(b'protected')
            alias = Path(folder) / 'installed.py'
            os.link(str(original), str(alias))
            with self.assertRaisesRegex(RuntimeError, 'unsafe_install_target'):
                installer.atomic_file(alias, b'replacement')
            self.assertEqual(original.read_bytes(), b'protected')

    def test_failed_atomic_publication_keeps_original_bytes_and_removes_staging(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'installed.py'
            target.write_bytes(b'original')
            with patch.object(installer.os, 'replace', side_effect=PermissionError('denied')):
                with self.assertRaises(PermissionError):
                    installer.atomic_file(target, b'new script')
            self.assertEqual(target.read_bytes(), b'original')
            self.assertEqual([path.name for path in Path(folder).iterdir()], ['installed.py'])

    def test_symlink_target_or_parent_is_not_followed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            protected = root / 'protected'
            protected.mkdir()
            original = protected / 'original'
            original.write_bytes(b'protected')
            linked = root / 'linked'
            alias = root / 'installed.py'
            try:
                linked.symlink_to(protected, target_is_directory=True)
                alias.symlink_to(original)
            except OSError as error:
                if os.name == 'nt' and getattr(error, 'winerror', None) == 1314:
                    self.skipTest('Windows account cannot create symbolic links')
                raise
            for target in [alias, linked / 'installed.py']:
                with self.assertRaisesRegex(RuntimeError, 'unsafe_install_(?:target|parent)'):
                    installer.atomic_file(target, b'replacement')
            self.assertEqual(original.read_bytes(), b'protected')

    def test_rollback_does_not_restore_files_while_a_timer_is_still_active(self):
        timers, run = self.systemd()
        def cannot_disable(command, **options):
            if command[1] == 'disable':
                return Mock(returncode=1)
            return run(command, **options)
        with patch.object(installer.subprocess, 'run', side_effect=cannot_disable), \
                patch.object(installer, 'restore_files') as restore:
            with self.assertRaisesRegex(RuntimeError, 'timer_stop_failed'):
                installer.rollback_install({}, timers)
        restore.assert_not_called()


if __name__ == '__main__':
    unittest.main()
