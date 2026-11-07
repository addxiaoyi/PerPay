"""Storage guards must reject stale deployment paths before touching production."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deployment', Path(__file__).parents[1] / 'scripts/deploy-maintenance-candidate.py')
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class DeploymentStorageTest(unittest.TestCase):
    def test_explicit_current_storage(self):
        root = '/var/lib/perpay-candidate-20261105a'
        unit = '\n'.join('Environment="PERPAY_' + name + '_DIR=' + root + '/' + folder + '"'
                         for name, folder in [('DATA', 'data'), ('SECRETS', 'secrets'), ('BACKUP', 'backups')])
        database, recovery = deployment.deployment_storage(root, '/root/perpay-recovery-20261105', unit)
        self.assertEqual(database, root + '/data/perpay.sqlite3')
        self.assertEqual(recovery.as_posix(), '/root/perpay-recovery-20261105')
        for stale in [unit.replace('20261105a', '20261104d'), unit + '\n' + unit, unit.replace('/secrets', '/wrong')]:
            with self.assertRaisesRegex(RuntimeError, 'service storage'):
                deployment.deployment_storage(root, '/root/perpay-recovery-20261105', stale)

    def test_invalid_paths(self):
        for root, recovery in [('/var/lib/perpay-candidate-20261105a/../other', '/root/perpay-recovery-20261105'),
                               ('/var/lib/perpay-candidate-20261105a', '/tmp/recovery')]:
            with self.assertRaisesRegex(RuntimeError, 'invalid .* root'):
                deployment.deployment_storage(root, recovery, '')


class ReleaseSwitchTest(unittest.TestCase):
    def run_switch(self, checkpoint_failure=False, probe_failure=False, rollback_failure=False):
        events = []

        def command(args):
            events.append(tuple(args))

        def checkpoint():
            events.append('checkpoint')
            if checkpoint_failure:
                raise RuntimeError('checkpoint failed')
            return {'sha256': 'checkpoint'}

        def verify(baseline):
            self.assertEqual(baseline, {'sha256': 'checkpoint'})
            events.append('verify')
            if probe_failure:
                raise RuntimeError('probe failed')
            return {'verified': True}

        def write_service(path, content):
            events.append(('write', str(path), content))
            if rollback_failure and content == 'old-main':
                raise RuntimeError('rollback failed')

        with patch.object(deployment.subprocess, 'check_call', side_effect=command), \
             patch.object(deployment.subprocess, 'check_output', return_value=b'ActiveState=active\n'), \
             patch.object(deployment.Path, 'read_text', side_effect=['old-main', 'old-sync']), \
             patch.object(deployment, 'write_service', side_effect=write_service), \
             patch.object(deployment, 'healthy', side_effect=lambda: events.append('healthy')):
            try:
                deployment.activate_release('old-main', 'old-sync', 'new-main', 'new-sync', checkpoint, verify)
            except RuntimeError as error:
                events.append(str(error))
        return events

    def test_checkpoint_only_after_all_candidate_writers_stop(self):
        events = self.run_switch()
        checkpoint = events.index('checkpoint')
        for name in ['perpay-legacy-sync.timer', 'perpay-legacy-sync.service', 'perpay-candidate.service']:
            self.assertLess(events.index(('systemctl', 'stop', name)), checkpoint)
        self.assertLess(checkpoint, events.index(('write', str(deployment.UNIT), 'new-main')))
        self.assertLess(events.index('verify'), events.index(('systemctl', 'start', 'perpay-legacy-sync.timer')))

    def test_checkpoint_failure_restarts_previous_candidate_and_sync(self):
        events = self.run_switch(checkpoint_failure=True)
        self.assertNotIn(('write', str(deployment.UNIT), 'new-main'), events)
        self.assertIn(('systemctl', 'start', 'perpay-candidate.service'), events)
        self.assertIn(('systemctl', 'start', 'perpay-legacy-sync.timer'), events)
        self.assertEqual(events[-1], 'checkpoint failed')

    def test_failed_probe_restores_both_units_before_resuming_sync(self):
        events = self.run_switch(probe_failure=True)
        restored = events.index(('write', str(deployment.UNIT), 'old-main'))
        self.assertIn(('write', str(deployment.SYNC_UNIT), 'old-sync'), events)
        self.assertGreater(events.index(('systemctl', 'start', 'perpay-legacy-sync.timer')), restored)
        self.assertEqual(events[-1], 'probe failed')

    def test_incomplete_rollback_keeps_sync_stopped(self):
        events = self.run_switch(probe_failure=True, rollback_failure=True)
        self.assertNotIn(('systemctl', 'start', 'perpay-legacy-sync.timer'), events)
        self.assertEqual(events[-1], 'rollback failed')


if __name__ == '__main__':
    unittest.main()
