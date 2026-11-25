import importlib.util
from contextlib import redirect_stderr
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
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

    def test_explicit_node_reads_strict_proof_without_old_python_sqlite_or_writes(self):
        node = os.environ.get('PERPAY_TEST_NODE') or shutil.which('node')
        self.assertTrue(node, 'a Node runtime is required for the STRICT compatibility regression')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            database = root / 'data/perpay.sqlite3'
            fixture = r'''
import { DatabaseSync } from 'node:sqlite';
const database = new DatabaseSync(process.argv[1]);
database.exec(`CREATE TABLE app_lease(id TEXT PRIMARY KEY) STRICT;
  CREATE TABLE system_metadata(key TEXT PRIMARY KEY,value TEXT) STRICT;
  CREATE TABLE epay_main_sync_runs(sequence INTEGER PRIMARY KEY,captured_at INTEGER) STRICT;
  CREATE TABLE epay_legacy_sync_runs(sequence INTEGER PRIMARY KEY,captured_at INTEGER) STRICT;
  INSERT INTO epay_main_sync_runs VALUES(1,1000);
  INSERT INTO epay_legacy_sync_runs VALUES(2,1000);`);
database.prepare("INSERT INTO system_metadata VALUES('epay_source_sync',?)").run(process.argv[2]);
database.close();
'''
            subprocess.run([node, '--input-type=module', '-e', fixture, str(database), json.dumps(self.status)],
                           check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
            before = hashlib.sha256(database.read_bytes()).digest()
            with patch.object(observer.sqlite3, 'connect', side_effect=sqlite3.OperationalError('near STRICT')) as old_driver:
                self.assertTrue(observer.read_source_status(str(root), 2000, node)['ready'])
                self.assertFalse(observer.read_source_status(str(root), 91001, node)['ready'])
                old_driver.assert_not_called()
            self.assertEqual(hashlib.sha256(database.read_bytes()).digest(), before)
            # A deliberate fixture-only write proves the actual Node connection enforces readOnly.
            marker = "database.exec('BEGIN');"
            self.assertEqual(observer.NODE_SOURCE_QUERY.count(marker), 1)
            writing = observer.NODE_SOURCE_QUERY.replace(marker, marker + "database.exec('DELETE FROM system_metadata');")
            with patch.object(observer, 'NODE_SOURCE_QUERY', writing), self.assertRaisesRegex(ValueError, '^source_read_unavailable$'):
                observer.node_source_status(database, 2000, node)
            self.assertEqual(hashlib.sha256(database.read_bytes()).digest(), before)

    def test_node_transport_failure_is_bounded_and_does_not_echo_private_output(self):
        private = 'customer-and-credential-material'
        for code, output in [(1, private), (0, private), (0, 'x' * (observer.MAX_NODE_OUTPUT_BYTES + 1)),
                             (0, '{}\n' + private)]:
            reply = subprocess.CompletedProcess([], code, stdout=output, stderr=private)
            with patch.object(observer.subprocess, 'run', return_value=reply) as run:
                with self.assertRaises(ValueError) as caught:
                    observer.node_source_status(Path('/fixture/perpay.sqlite3'), 2000, '/opt/node/bin/node')
                self.assertNotIn(private, str(caught.exception))
                self.assertEqual(run.call_args[1]['timeout'], observer.NODE_QUERY_TIMEOUT_SECONDS)
                self.assertFalse(run.call_args[1]['check'])
        with patch.object(observer.subprocess, 'run', side_effect=subprocess.TimeoutExpired('node', 5)):
            with self.assertRaises(subprocess.TimeoutExpired):
                observer.node_source_status(Path('/fixture/perpay.sqlite3'), 2000, '/opt/node/bin/node')

    def test_node_rows_use_the_existing_digest_time_and_cursor_validation(self):
        reply = {'status': [json.dumps(self.status)], 'runs': {
            'epay_main_sync_runs': [1, 1000], 'epay_legacy_sync_runs': [2, 1000]}}
        def read():
            completed = subprocess.CompletedProcess([], 0, stdout=json.dumps(reply), stderr='')
            with patch.object(observer.subprocess, 'run', return_value=completed):
                return observer.node_source_status(Path('/fixture/perpay.sqlite3'), 2000, '/opt/node/bin/node')
        self.assertEqual(read(), self.read())
        for row in [[99, 1000], [1, True], [1], None]:
            reply['runs']['epay_main_sync_runs'] = row
            self.assertFalse(read()['ready'])
        reply['runs']['epay_main_sync_runs'] = [1, 1000]
        reply['status'] = [json.dumps(dict(self.status, sourceSha256='invalid'))]
        self.assertFalse(read()['ready'])
        reply['private'] = 'customer-material'
        with self.assertRaisesRegex(ValueError, '^source_read_unavailable$'):
            read()

    def test_python_path_keeps_read_only_uri_and_closes_its_connection(self):
        with tempfile.TemporaryDirectory() as directory:
            connection = MagicMock()
            with patch.object(observer.sqlite3, 'connect', return_value=connection) as connect:
                with patch.object(observer, 'source_status', return_value={'ready': True}):
                    self.assertTrue(observer.read_source_status(directory, 2000)['ready'])
            self.assertTrue(connect.call_args[0][0].endswith('/data/perpay.sqlite3?mode=ro'))
            self.assertEqual(connect.call_args[1], {'uri': True, 'timeout': 1})
            connection.close.assert_called_once_with()

    def test_freshness_is_measured_after_a_delayed_node_query(self):
        reply = {'status': [json.dumps(self.status)], 'runs': {
            'epay_main_sync_runs': [1, 1000], 'epay_legacy_sync_runs': [2, 1000]}}
        clock = {'now': 90.999}
        def delayed_query(*_args, **_kwargs):
            clock['now'] = 91.001
            return subprocess.CompletedProcess([], 0, stdout=json.dumps(reply), stderr='')
        with patch.object(observer.time, 'time', side_effect=lambda: clock['now']):
            with patch.object(observer.subprocess, 'run', side_effect=delayed_query):
                sample = observer.read_source_status('/fixture', node='/opt/node/bin/node')
        self.assertFalse(sample['ready'])
        self.assertEqual(sample['sourceAgeMs'], 90001)

    def test_node_option_rejects_relative_or_missing_executables_before_observing(self):
        for node in ['node', str(Path(tempfile.gettempdir()) / 'missing-perpay-observer-node')]:
            with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
                observer.main(['--data-root', '/var/lib/perpay-candidate-fixture', '--node', node])
            self.assertEqual(caught.exception.code, 2)

    def test_oversized_metadata_cannot_escape_through_the_proof_result(self):
        self.status['private'] = 'x' * observer.MAX_STATUS_BYTES
        self.assertEqual(self.read(), {'ready': False, 'reason': 'source_status_invalid'})


if __name__ == '__main__':
    unittest.main()
