"""Payment findings survive network failures, process death and duplicate observations."""
import contextlib
from datetime import datetime, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import payment_alert_delivery as delivery

spec = importlib.util.spec_from_file_location('payment_monitor', ROOT / 'scripts/perpay-payment-alerts.py')
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


def levels(**changes):
    return dict({check: False for check in delivery.CHECKS}, **changes)


def report(**changes):
    audit = {'paymentRecovery': {'overdue': 0, 'stalled': 0, 'invalid': 0},
             'callbacks': {'failed': 0, 'delayed': 0, 'awaitingMerchant': 0},
             'sourceSyncAgeMs': 1, 'sourceSyncReady': True, 'financialHealthy': True,
             'inconsistentPayments': 0, 'refunds': {'inconsistent': 0},
             'settlements': {'inconsistent': 0}, 'ledgerProofErrors': 0,
             'submissions': {'unresolved': 0, 'missingPaymentDetails': 0}}
    return dict(audit, **changes)


class AlertDeliveryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.queue = self.root / 'delivery.json'
        self.config = {'webhookUrl': 'https://alerts.example.test/private-token', 'headers': {},
                       'timeoutSeconds': 5, 'heartbeatIntervalSeconds': 300, 'auditFreshnessSeconds': 180}

    def test_observation_deduplicates_and_preserves_recovery_order(self):
        self.assertEqual(delivery.observe(self.queue, levels(source_sync=True), 1000), 1)
        identity = delivery.load_queue(self.queue)['pending'][0]['id']
        self.assertEqual(delivery.observe(self.queue, levels(source_sync=True), 1001), 1)
        self.assertEqual(delivery.observe(self.queue, levels(), 1002), 2)
        sent = []
        summary = delivery.deliver(self.queue, self.config, 1003,
                                   lambda url, payload, headers, timeout: sent.append(payload))
        self.assertEqual(summary['sent'], 2)
        self.assertEqual([(item['check'], item['state']) for item in sent],
                         [('source_sync', 'opened'), ('source_sync', 'resolved')])
        self.assertEqual(sent[0]['id'], identity)
        self.assertEqual(delivery.load_queue(self.queue)['pending'], [])

    def test_failed_delivery_is_persistent_and_retry_uses_same_identity(self):
        delivery.observe(self.queue, levels(callback_delivery=True), 1000)
        sent = []

        def unavailable(url, payload, headers, timeout):
            sent.append(payload)
            raise OSError('secret URL and token must not be returned')

        summary = delivery.deliver(self.queue, self.config, 1000, unavailable)
        self.assertFalse(summary['ok'])
        self.assertNotIn('secret', json.dumps(summary))
        saved = delivery.load_queue(self.queue)['pending'][0]
        self.assertEqual((saved['attempts'], saved['nextAttemptAt']), (1, 1030))
        delivery.deliver(self.queue, self.config, 1029, unavailable)
        self.assertEqual(len(sent), 1)
        delivery.deliver(self.queue, self.config, 1030,
                         lambda url, payload, headers, timeout: sent.append(payload))
        self.assertEqual(sent[0], sent[1])
        self.assertEqual(delivery.load_queue(self.queue)['pending'], [])

    def test_pending_open_is_not_overtaken_by_resolved_event(self):
        delivery.observe(self.queue, levels(financial_integrity=True), 1000)
        delivery.observe(self.queue, levels(), 1001)
        delivery.deliver(self.queue, self.config, 1001,
                         lambda *args: (_ for _ in ()).throw(OSError('unavailable')))
        saved = delivery.load_queue(self.queue)
        self.assertEqual([event['state'] for event in saved['pending']], ['opened', 'resolved'])
        self.assertEqual(saved['pending'][1]['attempts'], 0)

    def test_claim_survives_process_restart_and_expires_with_fencing(self):
        delivery.observe(self.queue, levels(source_sync=True), 1000)
        old = delivery.claim(self.queue, 1000)
        self.assertIsNone(delivery.claim(self.queue, 1000 + delivery.LEASE_SECONDS - 1))
        current = delivery.claim(self.queue, 1000 + delivery.LEASE_SECONDS)
        self.assertEqual(old['id'], current['id'])
        self.assertNotEqual(old['leaseToken'], current['leaseToken'])
        with self.assertRaisesRegex(delivery.DeliveryError, 'lease_lost'):
            delivery.finish(self.queue, old, 1000 + delivery.LEASE_SECONDS, True)
        delivery.finish(self.queue, current, 1001 + delivery.LEASE_SECONDS, True)
        self.assertEqual(delivery.load_queue(self.queue)['pending'], [])

    def test_queue_full_keeps_old_state_for_next_observation(self):
        delivery.observe(self.queue, levels(source_sync=True), 1000)
        before = self.queue.read_bytes()
        with patch.object(delivery, 'MAX_PENDING', 1):
            with self.assertRaisesRegex(delivery.DeliveryError, 'queue_full'):
                delivery.observe(self.queue, levels(), 1001)
        self.assertEqual(self.queue.read_bytes(), before)

    def test_corrupt_queue_fails_without_overwriting_evidence(self):
        self.queue.write_text('{broken', encoding='utf-8')
        self.queue.chmod(0o600)
        with self.assertRaisesRegex(delivery.DeliveryError, 'queue_invalid'):
            delivery.observe(self.queue, levels(), 1000)
        self.assertEqual(self.queue.read_text(), '{broken')

    def test_missing_observation_and_retry_backoff_are_not_reported_healthy(self):
        summary = delivery.deliver(self.queue, self.config, 1000, lambda *args: None)
        self.assertEqual(summary['error'], 'audit_observation_stale')
        delivery.observe(self.queue, levels(source_sync=True), 1000)
        delivery.deliver(self.queue, self.config, 1000,
                         lambda *args: (_ for _ in ()).throw(OSError('failed')))
        summary = delivery.deliver(self.queue, self.config, 1001, lambda *args: None)
        self.assertFalse(summary['ok'])
        self.assertEqual(summary['error'], 'notification_retry_pending')

    def test_unknown_alert_observation_is_rejected(self):
        with self.assertRaisesRegex(delivery.DeliveryError, 'invalid_alert_observation'):
            delivery.observe(self.queue, dict(levels(), unexpected=True), 1000)

    def test_only_fresh_completed_audits_send_heartbeat(self):
        configured = dict(self.config, heartbeatUrl='https://heartbeat.example.test/token')
        delivery.observe(self.queue, levels(), 1000)
        sent = []
        transport = lambda url, payload, headers, timeout: sent.append((url, payload))
        self.assertTrue(delivery.deliver(self.queue, configured, 1000, transport)['heartbeatSent'])
        self.assertFalse(delivery.deliver(self.queue, configured, 1001, transport)['heartbeatSent'])
        self.assertFalse(delivery.deliver(self.queue, configured, 1300, transport)['heartbeatSent'])
        delivery.observe(self.queue, levels(audit_unavailable=True), 1301)
        self.assertFalse(delivery.deliver(self.queue, configured, 1301, transport)['heartbeatSent'])
        delivery.observe(self.queue, levels(), 1302)
        self.assertTrue(delivery.deliver(self.queue, configured, 1302, transport)['heartbeatSent'])

    def test_stopped_audit_sends_one_mail_and_only_a_healthy_audit_recovers_it(self):
        configured = dict(self.config, heartbeatUrl='https://heartbeat.example.test/token',
                          smtp=delivery.read_smtp({'host': '127.0.0.1', 'port': 25,
                              'security': 'local', 'auth': False, 'from': 'sender@example.test',
                              'to': ['recipient@example.test']}))
        configured.pop('webhookUrl')
        heartbeats = []
        transport = lambda url, payload, headers, timeout: heartbeats.append(payload)
        delivery.observe(self.queue, levels(), 1000)
        with patch.object(delivery.smtplib, 'SMTP') as factory:
            smtp = factory.return_value.__enter__.return_value
            smtp.send_message.return_value = {}
            self.assertTrue(delivery.deliver(self.queue, configured, 1000, transport)['heartbeatSent'])
            stopped = delivery.deliver(self.queue, configured, 1181, transport)
            self.assertEqual((stopped['sent'], stopped['error']), (1, 'audit_observation_stale'))
            self.assertFalse(stopped['heartbeatSent'])
            self.assertFalse(stopped['auditFresh'])
            self.assertEqual(delivery.deliver(self.queue, configured, 1500, transport)['sent'], 0)
            saved = delivery.load_queue(self.queue)
            self.assertTrue(saved['levels']['audit_unavailable'])
            self.assertEqual((saved['observedAt'], saved['heartbeatAt']), (1000, 1000))
            self.assertEqual(smtp.send_message.call_count, 1)
            self.assertEqual(len(heartbeats), 1)

            delivery.observe(self.queue, levels(audit_unavailable=True), 1501)
            failed = delivery.deliver(self.queue, configured, 1501, transport)
            self.assertEqual(failed['sent'], 0)
            self.assertFalse(failed['heartbeatSent'])
            delivery.observe(self.queue, levels(), 1502)
            recovered = delivery.deliver(self.queue, configured, 1502, transport)
            self.assertTrue(recovered['ok'])
            self.assertTrue(recovered['heartbeatSent'])
            self.assertEqual(recovered['sent'], 1)
            self.assertEqual(delivery.deliver(self.queue, configured, 1503, transport)['sent'], 0)
            messages = [call[0][0] for call in smtp.send_message.call_args_list]
            self.assertEqual([message['Subject'] for message in messages],
                             ['[StarPAY] ALERT: Payment monitor', '[StarPAY] RECOVERED: Payment monitor'])
            self.assertNotEqual(messages[0]['Message-ID'], messages[1]['Message-ID'])
            self.assertEqual(len(heartbeats), 2)

    def test_stopped_audit_mail_retries_with_one_identity_without_refreshing_the_audit(self):
        configured = dict(self.config, smtp={'transport': 'injected'})
        configured.pop('webhookUrl')
        delivery.observe(self.queue, levels(), 1000)
        sent = []

        def unavailable(account, payload, timeout):
            sent.append(payload)
            raise OSError('mail unavailable')

        failed = delivery.deliver(self.queue, configured, 1181, mail_transport=unavailable)
        self.assertEqual((failed['sent'], failed['pending']), (0, 1))
        saved = delivery.load_queue(self.queue)
        self.assertEqual(saved['observedAt'], 1000)
        self.assertEqual(saved['pending'][0]['attempts'], 1)
        self.assertEqual(saved['pending'][0]['nextAttemptAt'], 1211)
        delivery.deliver(self.queue, configured, 1182, mail_transport=unavailable)
        self.assertEqual(len(sent), 1)
        retried = delivery.deliver(self.queue, configured, 1211,
                                  mail_transport=lambda account, payload, timeout: sent.append(payload))
        self.assertEqual((retried['sent'], retried['pending']), (1, 0))
        self.assertEqual(sent[0], sent[1])
        self.assertEqual(delivery.load_queue(self.queue)['observedAt'], 1000)

    def test_stopped_audit_preserves_other_levels_and_invoice_reason_codes(self):
        current = levels(source_sync=True, invoice_readiness=True)
        details = {'invoice_readiness': ['AUTHORIZATION_EXPIRED']}
        delivery.observe(self.queue, current, 1000, details)
        delivery.deliver(self.queue, self.config, 1000, lambda *args: None)
        delivery.deliver(self.queue, self.config, 1181, lambda *args: None)
        saved = delivery.load_queue(self.queue)
        self.assertEqual(saved['levels'], dict(current, audit_unavailable=True))
        self.assertEqual(saved['details'], details)
        delivery.observe(self.queue, current, 1182, details)
        self.assertEqual([(event['check'], event['state']) for event in delivery.load_queue(self.queue)['pending']],
                         [('audit_unavailable', 'resolved')])

    def test_stopped_audit_drains_a_full_queue_before_adding_its_alert(self):
        delivery.observe(self.queue, levels(source_sync=True), 1000)
        sent = []
        transport = lambda url, payload, headers, timeout: sent.append(payload)
        with patch.object(delivery, 'MAX_PENDING', 1), patch.object(delivery, 'MAX_SENDS', 1):
            deferred = delivery.deliver(self.queue, self.config, 1181, transport)
            self.assertEqual((deferred['sent'], deferred['pending']), (1, 1))
            self.assertEqual(delivery.load_queue(self.queue)['observedAt'], 1000)
            delivery.deliver(self.queue, self.config, 1182, transport)
        self.assertEqual([(event['check'], event['state']) for event in sent],
                         [('source_sync', 'opened'), ('audit_unavailable', 'opened')])
        self.assertEqual(delivery.load_queue(self.queue)['pending'], [])

    def test_stopped_audit_cannot_overwrite_a_corrupt_queue(self):
        self.queue.write_text('{broken', encoding='utf-8')
        self.queue.chmod(0o600)
        with self.assertRaisesRegex(delivery.DeliveryError, 'queue_invalid'):
            delivery.deliver(self.queue, self.config, 1181, lambda *args: self.fail('corrupt queue sent mail'))
        self.assertEqual(self.queue.read_text(), '{broken')

    def test_failed_heartbeat_remains_due(self):
        configured = dict(self.config, heartbeatUrl='https://heartbeat.example.test/token')
        delivery.observe(self.queue, levels(), 1000)
        failed = delivery.deliver(self.queue, configured, 1000,
                                  lambda *args: (_ for _ in ()).throw(OSError('failed')))
        self.assertEqual(failed['error'], 'heartbeat_delivery_failed')
        self.assertEqual(delivery.load_queue(self.queue)['heartbeatAt'], 0)
        self.assertTrue(delivery.deliver(self.queue, configured, 1001, lambda *args: None)['heartbeatSent'])

    def test_future_observations_do_not_emit_heartbeat(self):
        delivery.observe(self.queue, levels(), 1100)
        configured = dict(self.config, heartbeatUrl='https://heartbeat.example.test/token')
        self.assertFalse(delivery.deliver(self.queue, configured, 1000, lambda *args: None)['heartbeatSent'])

    def test_config_rejects_http_credentials_fragments_and_header_injection(self):
        path = self.root / 'notify.private.json'
        valid = {'schemaVersion': 1, 'webhookUrl': 'https://alerts.example.test/token',
                 'headers': {'Authorization': 'Bearer private-secret'}}
        invalid = [{'webhookUrl': 'http://alerts.example.test/token'},
                   {'webhookUrl': 'https://user:secret@alerts.example.test/token'},
                   {'webhookUrl': 'https://alerts.example.test/token#fragment'},
                   {'webhookUrl': 'https://alerts.example.test/token\r\nInjected: yes'},
                   {'headers': {'Authorization': 'secret\r\nInjected: yes'}},
                   {'headers': {'Content-Length': '1'}},
                   {'headers': {'X-Key': 'a', 'x-key': 'b'}},
                   {'timeoutSeconds': 11}, {'timeoutSeconds': True}, {'unknown': 'field'}]
        for change in invalid:
            path.write_text(json.dumps(dict(valid, **change)), encoding='utf-8')
            path.chmod(0o600)
            with self.subTest(change=change), self.assertRaises(delivery.DeliveryError):
                delivery.read_config(path)
        path.write_text(json.dumps(valid), encoding='utf-8')
        self.assertEqual(delivery.read_config(path)['headers']['Authorization'], 'Bearer private-secret')

    def test_unconfigured_cli_is_blocked_and_retains_pending_alert(self):
        delivery.observe(self.queue, levels(source_sync=True), 1000)
        before = self.queue.read_bytes()
        execution = subprocess.run([sys.executable, str(ROOT / 'scripts/payment_alert_delivery.py'),
                                    '--queue', str(self.queue)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   universal_newlines=True, check=False)
        self.assertEqual(execution.returncode, 2)
        self.assertEqual(json.loads(execution.stdout)['error'], 'notification_unconfigured')
        self.assertEqual(self.queue.read_bytes(), before)

    def test_redirect_handler_never_follows_redirect(self):
        self.assertIsNone(delivery.NoRedirect().redirect_request(None, None, 302, 'found', {},
                                                                 'http://elsewhere.example.test'))

    def test_transport_sends_stable_id_and_sanitizes_http_failure(self):
        class Response:
            status = 302
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False

        with patch.object(delivery.urllib.request, 'build_opener') as factory:
            factory.return_value.open.return_value = Response()
            with self.assertRaisesRegex(delivery.DeliveryError, '^notification_http_failure$'):
                delivery.post('https://alerts.example.test/secret', {'id': 'stable', 'event': 'test'}, {}, 5)
            request = factory.return_value.open.call_args[0][0]
            self.assertEqual(request.get_header('Idempotency-key'), 'stable')
            self.assertEqual(factory.return_value.open.call_args[1]['timeout'], 5)

    def smtp_config(self, security='ssl'):
        password = self.root / 'smtp-password.private'
        password.write_text('private-mail-password\n', encoding='utf-8')
        password.chmod(0o600)
        return {'host': 'smtp.example.test', 'port': 465 if security == 'ssl' else 587,
                'security': security, 'username': 'sender@example.test',
                'passwordFile': str(password), 'from': 'sender@example.test',
                'to': ['recipient@example.test']}

    def test_smtp_credentials_are_private_referenced_and_never_queued(self):
        configured = self.smtp_config()
        path = self.root / 'notify.private.json'
        path.write_text(json.dumps({'schemaVersion': 1, 'smtp': configured}), encoding='utf-8')
        path.chmod(0o600)
        config = delivery.read_config(path)
        self.assertEqual(config['smtp']['password'], 'private-mail-password')
        delivery.observe(self.queue, levels(source_sync=True), 1000)
        sent = []
        delivery.deliver(self.queue, config, 1000,
                         mail_transport=lambda account, payload, timeout: sent.append(payload))
        self.assertEqual(sent[0]['state'], 'opened')
        self.assertNotIn('password', self.queue.read_text())
        self.assertNotIn('recipient', self.queue.read_text())

    def test_smtp_ssl_authenticates_and_uses_stable_message_id(self):
        config = delivery.read_smtp(self.smtp_config())
        payload = {'id': 'a' * 64, 'check': 'source_sync', 'state': 'opened', 'occurredAt': 1000}
        with patch.object(delivery.smtplib, 'SMTP_SSL') as factory:
            smtp = factory.return_value.__enter__.return_value
            smtp.send_message.return_value = {}
            delivery.send_mail(config, payload, 5)
            factory.assert_called_once()
            self.assertEqual(factory.call_args[1]['timeout'], 5)
            self.assertTrue(factory.call_args[1]['context'].check_hostname)
            smtp.login.assert_called_once_with('sender@example.test', 'private-mail-password')
            message = smtp.send_message.call_args[0][0]
            self.assertEqual(message['Message-ID'], '<' + 'a' * 64 + '@starpay-alert.local>')
            self.assertIn('ALERT', message['Subject'])
            self.assertNotIn('private-mail-password', message.as_string())

    def test_starttls_happens_before_login_and_failure_never_sends_password(self):
        config = delivery.read_smtp(self.smtp_config('starttls'))
        payload = {'id': 'a' * 64, 'check': 'source_sync', 'state': 'resolved', 'occurredAt': 1000}
        with patch.object(delivery.smtplib, 'SMTP') as factory:
            smtp = factory.return_value.__enter__.return_value
            smtp.send_message.return_value = {}
            delivery.send_mail(config, payload, 5)
            names = [call[0] for call in smtp.method_calls]
            self.assertLess(names.index('starttls'), names.index('login'))
            self.assertIn('RECOVERED', smtp.send_message.call_args[0][0]['Subject'])
        with patch.object(delivery.smtplib, 'SMTP') as factory:
            smtp = factory.return_value.__enter__.return_value
            smtp.starttls.side_effect = delivery.smtplib.SMTPNotSupportedError('not supported')
            with self.assertRaisesRegex(delivery.DeliveryError, '^smtp_delivery_failed$'):
                delivery.send_mail(config, payload, 5)
            smtp.login.assert_not_called()

    def test_smtp_failure_retains_the_notification_without_leaking_error(self):
        configured = dict(self.config, smtp=delivery.read_smtp(self.smtp_config()))
        configured.pop('webhookUrl')
        delivery.observe(self.queue, levels(financial_integrity=True), 1000)
        with patch.object(delivery.smtplib, 'SMTP_SSL', side_effect=delivery.smtplib.SMTPAuthenticationError(535, b'private-password')):
            summary = delivery.deliver(self.queue, configured, 1000, mail_transport=delivery.send_mail)
        self.assertFalse(summary['ok'])
        self.assertEqual(summary['pending'], 1)
        self.assertNotIn('private-password', json.dumps(summary))

    def test_smtp_plaintext_and_malformed_recipients_are_rejected(self):
        original = self.smtp_config()
        for changes in [{'security': 'plain'}, {'to': ['recipient@example.test\r\nBcc: other@example.test']},
                        {'from': 'Display Name <sender@example.test>'}, {'to': []}, {'passwordFile': 'relative'}]:
            with self.subTest(changes=changes), self.assertRaises(delivery.DeliveryError):
                delivery.read_smtp(dict(original, **changes))

    def test_unauthenticated_relay_is_limited_to_literal_loopback(self):
        original = {'host': '127.0.0.1', 'port': 25, 'security': 'local', 'auth': False,
                    'from': 'sender@example.test', 'to': ['recipient@example.test']}
        for host in ['127.0.0.1', '::1']:
            configured = delivery.read_smtp(dict(original, host=host))
            self.assertFalse(configured['auth'])
            payload = {'id': 'a' * 64, 'check': 'source_sync', 'state': 'opened', 'occurredAt': 1000}
            with patch.object(delivery.smtplib, 'SMTP') as factory:
                smtp = factory.return_value.__enter__.return_value
                smtp.send_message.return_value = {}
                delivery.send_mail(configured, payload, 5)
                smtp.login.assert_not_called()
                smtp.starttls.assert_not_called()
        for changes in [{'host': 'relay.example.test'}, {'host': '192.168.1.10'},
                        {'host': '8.8.8.8'}, {'security': 'starttls'}, {'auth': True},
                        {'passwordFile': '/private/secret'}, {'serverName': 'mail.example.test'}]:
            with self.subTest(changes=changes), self.assertRaises(delivery.DeliveryError):
                delivery.read_smtp(dict(original, **changes))

    def test_custom_tls_name_keeps_certificate_verification_enabled(self):
        configured = delivery.read_smtp(dict(self.smtp_config(), host='192.0.2.10', serverName='mail.example.test'))
        payload = {'id': 'a' * 64, 'check': 'source_sync', 'state': 'opened', 'occurredAt': 1000}
        with patch.object(delivery, 'NamedTlsSMTP_SSL') as factory:
            smtp = factory.return_value.__enter__.return_value
            smtp.send_message.return_value = {}
            delivery.send_mail(configured, payload, 5)
            self.assertEqual(factory.call_args[0][:3], ('mail.example.test', '192.0.2.10', 465))
            self.assertTrue(factory.call_args[1]['context'].check_hostname)
        connection = object.__new__(delivery.NamedTlsSMTP_SSL)
        connection.tls_server_name = 'mail.example.test'
        with patch.object(delivery.smtplib.SMTP, '_get_socket') as socket, patch.object(delivery.ssl.SSLContext, 'wrap_socket') as wrap:
            connection.context = delivery.ssl.create_default_context()
            connection._get_socket('192.0.2.10', 465, 5)
            self.assertEqual(wrap.call_args[1]['server_hostname'], 'mail.example.test')
            wrap.side_effect = delivery.ssl.SSLError('invalid certificate')
            with self.assertRaises(delivery.ssl.SSLError):
                connection._get_socket('192.0.2.10', 465, 5)
            socket.return_value.close.assert_called_once()

    @unittest.skipIf(os.name == 'nt', 'POSIX private permissions')
    def test_public_config_or_queue_is_refused(self):
        path = self.root / 'notify.private.json'
        path.write_text('{"schemaVersion":1,"webhookUrl":"https://alerts.example.test"}')
        path.chmod(0o644)
        with self.assertRaisesRegex(delivery.DeliveryError, 'unsafe_private_file'):
            delivery.read_config(path)
        delivery.observe(self.queue, levels(), 1000)
        self.queue.chmod(0o644)
        with self.assertRaisesRegex(delivery.DeliveryError, 'unsafe_private_file'):
            delivery.load_queue(self.queue)

    def test_journal_failure_preserves_durable_notification_for_retry(self):
        state = self.root / 'monitor.json'
        current = levels(source_sync=True)
        with patch.object(monitor.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'systemd-cat')):
            with self.assertRaises(subprocess.CalledProcessError):
                monitor.record_observation(state, {}, current, self.queue)
        self.assertFalse(state.exists())
        identity = delivery.load_queue(self.queue)['pending'][0]['id']
        with patch.object(monitor.subprocess, 'run'):
            monitor.record_observation(state, {}, current, self.queue)
        self.assertEqual(len(delivery.load_queue(self.queue)['pending']), 1)
        self.assertEqual(delivery.load_queue(self.queue)['pending'][0]['id'], identity)
        self.assertEqual(json.loads(state.read_text()), current)

    def test_journal_only_mode_still_records_alerts_and_reports_blocker(self):
        state = self.root / 'monitor.json'
        error_output = io.StringIO()
        with patch.object(monitor.subprocess, 'run') as journal, contextlib.redirect_stderr(error_output):
            monitor.record_observation(state, {}, levels(source_sync=True))
        self.assertTrue(state.exists())
        self.assertEqual(journal.call_count, 1)
        self.assertEqual(json.loads(error_output.getvalue())['error'], 'delivery_queue_unconfigured')

    def test_aged_orders_remain_visible_without_marking_financial_integrity_broken(self):
        findings = monitor.active_alerts(report(submissions={'unresolved': 62, 'missingPaymentDetails': 0}))
        self.assertTrue(findings['aged_submissions'])
        self.assertFalse(findings['financial_integrity'])

    def invoice_report(self, **changes):
        readiness = {'schemaVersion': 1, 'checkedAt': datetime.fromtimestamp(1000, timezone.utc).isoformat(),
                     'healthy': True, 'canActivate': False, 'remoteVerification': 'PASSED', 'blockers': []}
        return dict(readiness, **changes)

    def test_invoice_closed_execution_flag_does_not_alone_open_an_alert(self):
        path = self.root / 'invoice.json'
        path.write_text(json.dumps(self.invoice_report()), encoding='utf-8')
        path.chmod(0o600)
        self.assertEqual(monitor.invoice_alert(path, 1000), (False, []))
        path.write_text(json.dumps(self.invoice_report(healthy=False, blockers=['AUTHORIZATION_EXPIRED'])), encoding='utf-8')
        self.assertEqual(monitor.invoice_alert(path, 1000), (True, ['AUTHORIZATION_EXPIRED']))

    def test_invoice_missing_stale_bad_or_future_report_is_visible(self):
        path = self.root / 'invoice.json'
        self.assertEqual(monitor.invoice_alert(path, 1000), (True, ['INVOICE_READINESS_MISSING']))
        path.write_text(json.dumps(self.invoice_report()), encoding='utf-8')
        path.chmod(0o600)
        self.assertEqual(monitor.invoice_alert(path, 1000 + monitor.INVOICE_MAX_AGE_SECONDS + 1),
                         (True, ['INVOICE_READINESS_STALE']))
        self.assertEqual(monitor.invoice_alert(path, 939), (True, ['INVOICE_READINESS_CLOCK_SKEW']))
        for change in [{'checkedAt': 'not a date'}, {'healthy': 'true'}, {'schemaVersion': True},
                       {'remoteVerification': 'MAYBE'}, {'blockers': ['customer@example.test']},
                       {'blockers': ['SMS_REQUIRED\nprivate information']}]:
            path.write_text(json.dumps(self.invoice_report(**change)), encoding='utf-8')
            with self.subTest(change=change):
                self.assertEqual(monitor.invoice_alert(path, 1000), (True, ['INVOICE_READINESS_INVALID']))

    def test_invoice_timestamps_work_without_python37_fromisoformat(self):
        path = self.root / 'invoice.json'
        legacy_datetime = SimpleNamespace(strptime=datetime.strptime)
        for stamp in ['1970-01-01T00:16:40Z', '1970-01-01T00:16:40.000Z',
                      '1970-01-01T00:16:40+00:00', '1970-01-01T08:16:40+08:00']:
            path.write_text(json.dumps(self.invoice_report(checkedAt=stamp)), encoding='utf-8')
            path.chmod(0o600)
            with self.subTest(stamp=stamp), patch.object(monitor, 'datetime', legacy_datetime):
                self.assertEqual(monitor.invoice_alert(path, 1000), (False, []))

    def test_invoice_reason_changes_queue_a_new_alert_without_personal_information(self):
        active = levels(invoice_readiness=True)
        delivery.observe(self.queue, active, 1000, {'invoice_readiness': ['AUTHORIZATION_EXPIRED']})
        delivery.observe(self.queue, active, 1001, {'invoice_readiness': ['AUTHORIZATION_EXPIRED']})
        self.assertEqual(len(delivery.load_queue(self.queue)['pending']), 1)
        delivery.observe(self.queue, active, 1002, {'invoice_readiness': ['SMS_AUTH_REQUIRED']})
        delivery.observe(self.queue, levels(), 1003, {'invoice_readiness': []})
        sent = []
        delivery.deliver(self.queue, self.config, 1003,
                         lambda url, payload, headers, timeout: sent.append(payload))
        self.assertEqual([message['codes'] for message in sent],
                         [['AUTHORIZATION_EXPIRED'], ['SMS_AUTH_REQUIRED'], []])
        self.assertEqual([message['state'] for message in sent], ['opened', 'opened', 'resolved'])
        with self.assertRaisesRegex(delivery.DeliveryError, 'invalid_alert_details'):
            delivery.observe(self.queue, active, 1004, {'invoice_readiness': ['private@example.test']})

    def run_monitor(self, audit, exit_code=0, exception=None):
        unit = self.root / 'audit.service'
        unit.write_text('ExecStart=node --experimental-strip-types /app/scripts/audit-live-gateway.ts /var/lib/test\n')
        arguments = ['monitor', '--state', str(self.root / 'monitor.json'), '--unit', str(unit),
                     '--delivery-state', str(self.queue)]

        def execute(command, **kwargs):
            if command[0] == 'systemd-cat':
                return SimpleNamespace(returncode=0)
            if exception:
                raise exception
            return SimpleNamespace(stdout=json.dumps(audit), returncode=exit_code)

        with patch.object(sys, 'argv', arguments), patch.object(monitor.subprocess, 'run', side_effect=execute), contextlib.redirect_stdout(io.StringIO()):
            return monitor.main()

    def test_completed_audit_findings_exit_success_but_keep_open_alert(self):
        self.assertEqual(self.run_monitor(report(submissions={'unresolved': 62, 'missingPaymentDetails': 0}), 1), 0)
        queue = delivery.load_queue(self.queue)
        self.assertTrue(queue['levels']['aged_submissions'])
        self.assertFalse(queue['levels']['audit_unavailable'])

    def test_invalid_audit_or_execution_failure_opens_unavailable(self):
        for audit, status in [({}, 1), (report(), 2), (report(sourceSyncAgeMs='bad'), 0)]:
            with self.subTest(status=status, audit=audit):
                self.assertEqual(self.run_monitor(audit, status), 1)
                self.assertTrue(delivery.load_queue(self.queue)['levels']['audit_unavailable'])

    def test_timed_out_audit_is_bounded_and_records_failure(self):
        self.assertEqual(self.run_monitor(None, exception=subprocess.TimeoutExpired('audit', 15)), 1)
        self.assertTrue(delivery.load_queue(self.queue)['levels']['audit_unavailable'])


if __name__ == '__main__':
    unittest.main()
