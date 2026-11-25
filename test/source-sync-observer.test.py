import importlib.util
import json
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('source_observer', Path(__file__).parents[1] / 'scripts/observe-source-sync.py')
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class SourceSyncObserverTest(unittest.TestCase):
    def setUp(self):
        self.connection = sqlite3.connect(':memory:')
        self.addCleanup(self.connection.close)
        self.connection.executescript('CREATE TABLE system_metadata(key TEXT,value TEXT); '
                                      'CREATE TABLE epay_main_sync_runs(sequence INTEGER,captured_at INTEGER); '
                                      'CREATE TABLE epay_legacy_sync_runs(sequence INTEGER,captured_at INTEGER); '
                                      'INSERT INTO epay_main_sync_runs VALUES(1,1000); '
                                      'INSERT INTO epay_legacy_sync_runs VALUES(2,1000);')
        self.status = {'version': 1, 'ok': True, 'capturedAt': '1970-01-01T00:00:01.000Z', 'appliedAt': 1010,
                       'sourceSha256': 'a'*64, 'mainSequence': 1, 'legacySequence': 2}

    def read(self, now=2000):
        self.connection.execute("DELETE FROM system_metadata")
        self.connection.execute("INSERT INTO system_metadata VALUES('epay_source_sync',?)", [json.dumps(self.status)])
        return observer.source_status(self.connection, now)

    def test_fresh_valid_proof_is_ready_and_clock_skew_or_expiration_is_not(self):
        self.assertTrue(self.read()['ready'])
        self.assertTrue(self.read(91000)['ready'])
        self.assertFalse(self.read(91001)['ready'])
        self.assertFalse(self.read(999)['ready'])

    def test_failed_sync_missing_digest_or_cursor_drift_never_passes(self):
        for field, invalid in [('version', True), ('ok', False), ('sourceSha256', 'secret'), ('mainSequence', 99), ('appliedAt', 999999), ('appliedAt', True)]:
            previous = self.status[field]
            self.status[field] = invalid
            self.assertFalse(self.read()['ready'])
            self.status[field] = previous

    def test_unsafe_log_text_is_not_echoed_and_phase_maxima_are_aggregated(self):
        events = [json.dumps({'ok': True, 'phaseMilliseconds': {'main_snapshot': 4}}),
                  json.dumps({'error': 'legacy_source_sync_retry', 'reason': 'request_timeout', 'failedStep': 'main_snapshot',
                              'phaseMilliseconds': {'main_snapshot': 5000, 'secret=password': 123}}),
                  json.dumps({'error': 'legacy_source_sync_failed', 'reason': 'password=secret'}), 'not json']
        report = observer.journal_summary(events)
        self.assertEqual(report['successful'], 1)
        self.assertEqual(report['retries'], 1)
        self.assertEqual(report['failed'], 1)
        self.assertEqual(report['maximumPhaseMs'], {'main_snapshot': 5000})
        self.assertNotIn('password', json.dumps(report))

    def test_missing_metadata_and_malformed_payload_do_not_pass(self):
        self.assertFalse(observer.source_status(self.connection, 2000)['ready'])
        for value in ['not-json', '[]', '{"capturedAt":false}', 'null']:
            self.connection.execute("DELETE FROM system_metadata")
            self.connection.execute("INSERT INTO system_metadata VALUES('epay_source_sync',?)", [value])
            self.assertFalse(observer.source_status(self.connection, 2000)['ready'])

    def test_http_200_requires_the_exact_ready_json_status(self):
        opener = MagicMock()
        response = opener.open.return_value.__enter__.return_value
        response.status = 200
        with patch.object(observer.urllib.request, 'build_opener', return_value=opener):
            for raw, expected in [(b'{"status":"ready"}', True), (b'{"status":"degraded"}', False),
                                  (b'<html>login</html>', False), (b'[]', False), (b'x'*65537, False)]:
                response.read.return_value = raw
                self.assertEqual(observer.probe('http://127.0.0.1:16191', '/pay/epay/readyz')['ok'], expected)


if __name__ == '__main__':
    unittest.main()
