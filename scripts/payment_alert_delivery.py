"""Durable, at-least-once payment alert delivery; never contains payment details."""
import argparse
from contextlib import contextmanager
from email.message import EmailMessage
from email.utils import formatdate, parseaddr
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import smtplib
import ssl
import sys
import tempfile
import time
from typing import Any, Callable, Dict, Iterator, Mapping, Optional, Sequence
import urllib.error
import urllib.parse
import urllib.request
import uuid


CHECKS = frozenset(('payment_recovery', 'callback_delivery', 'financial_integrity',
                    'source_sync', 'aged_submissions', 'audit_unavailable', 'invoice_readiness'))
MAX_PENDING = 10000
LEASE_SECONDS = 180
MAX_STATE_BYTES = 8 * 1024 * 1024
MAX_SENDS = 10


class DeliveryError(RuntimeError):
    """Public error codes deliberately exclude paths, URLs and response bodies."""


def private_file(path: Path) -> None:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise DeliveryError('unsafe_private_file')
    if os.name != 'nt' and (info.st_mode & 0o077 or info.st_uid not in (0, os.geteuid())):
        raise DeliveryError('unsafe_private_file')


def atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    descriptor, name = tempfile.mkstemp(prefix='.' + path.name + '.', dir=str(path.parent))
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            json.dump(value, output, separators=(',', ':'), allow_nan=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, str(path))
        if os.name != 'nt':
            descriptor = os.open(str(path.parent), os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextmanager
def queue_lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.parent.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise DeliveryError('unsafe_queue_directory')
    if os.name != 'nt' and (info.st_mode & 0o077 or info.st_uid != os.geteuid()):
        raise DeliveryError('unsafe_queue_directory')
    lock_path = path.with_name(path.name + '.lock')
    descriptor = os.open(str(lock_path), os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    acquired = False
    try:
        if os.name == 'nt':
            import msvcrt
            if os.fstat(descriptor).st_size == 0:
                os.write(descriptor, b'\0')
            os.lseek(descriptor, 0, os.SEEK_SET)
            try:
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
                acquired = True
            except OSError:
                raise DeliveryError('queue_busy') from None
        else:
            import fcntl
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
            except BlockingIOError:
                raise DeliveryError('queue_busy') from None
        yield
    finally:
        if acquired and os.name == 'nt':
            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        os.close(descriptor)


def require(condition: bool) -> None:
    if not condition:
        raise ValueError('invalid alert state or configuration')


def integer(value: Any, minimum: int, maximum: int) -> bool:
    return type(value) is int and minimum <= value <= maximum


def reason_codes(values: Any) -> bool:
    return isinstance(values, list) and len(values) <= 64 and all(
        isinstance(code, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,79}', code) for code in values)


def load_queue(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {'schemaVersion': 1, 'queueId': uuid.uuid4().hex, 'sequence': 0,
                'levels': {}, 'pending': [], 'observedAt': 0, 'heartbeatAt': 0}
    private_file(path)
    if path.stat().st_size > MAX_STATE_BYTES:
        raise DeliveryError('queue_too_large')
    try:
        queue = json.loads(path.read_text(encoding='utf-8'))
        require(integer(queue['schemaVersion'], 1, 1) and re.fullmatch(r'[a-f0-9]{32}', queue['queueId']))
        require(integer(queue['sequence'], 0, 2 ** 53))
        require(integer(queue['observedAt'], 0, 2 ** 53) and integer(queue['heartbeatAt'], 0, 2 ** 53))
        require(isinstance(queue['levels'], dict) and set(queue['levels']) <= CHECKS)
        require(all(type(level) is bool for level in queue['levels'].values()))
        require(isinstance(queue.get('details', {}), dict) and set(queue.get('details', {})) <= {'invoice_readiness'})
        require(all(reason_codes(codes) for codes in queue.get('details', {}).values()))
        require(isinstance(queue['pending'], list) and len(queue['pending']) <= MAX_PENDING)
        identifiers = set()
        for event in queue['pending']:
            require(re.fullmatch(r'[a-f0-9]{64}', event['id']) and event['id'] not in identifiers)
            identifiers.add(event['id'])
            require(event['check'] in CHECKS and event['state'] in ('opened', 'resolved'))
            require(all(integer(event[key], 0, 2 ** 53) for key in ('occurredAt', 'attempts', 'nextAttemptAt')))
            require(integer(event.get('leaseUntil', 0), 0, 2 ** 53))
            require(re.fullmatch(r'[a-f0-9]{32}', event.get('leaseToken', '0' * 32)))
            require('codes' not in event or event['check'] == 'invoice_readiness' and reason_codes(event['codes']))
        require(integer(queue.get('heartbeatLeaseUntil', 0), 0, 2 ** 53))
        return queue
    except (AssertionError, KeyError, TypeError, ValueError):
        raise DeliveryError('queue_invalid') from None


def queue_event(queue: Dict[str, Any], check: str, active: bool, now: int,
                codes: Optional[Sequence[str]] = None) -> None:
    if len(queue['pending']) >= MAX_PENDING:
        raise DeliveryError('queue_full')
    queue['sequence'] += 1
    state = 'opened' if active else 'resolved'
    identity = '{}:{}:{}:{}'.format(queue['queueId'], queue['sequence'], check, state)
    event = {'id': hashlib.sha256(identity.encode()).hexdigest(),
             'check': check, 'state': state, 'occurredAt': now, 'attempts': 0, 'nextAttemptAt': now}
    if check == 'invoice_readiness':
        event['codes'] = list(codes or [])
    queue['pending'].append(event)


def observe(path: Path, current: Mapping[str, bool], now: Optional[int] = None,
            details: Optional[Mapping[str, Any]] = None) -> int:
    now = int(time.time()) if now is None else now
    details = dict(details or {})
    if set(current) != CHECKS or not all(type(level) is bool for level in current.values()):
        raise DeliveryError('invalid_alert_observation')
    if not set(details) <= {'invoice_readiness'} or not all(reason_codes(codes) for codes in details.values()):
        raise DeliveryError('invalid_alert_details')
    with queue_lock(path):
        queue = load_queue(path)
        for check in sorted(CHECKS):
            active = current[check]
            changed_reason = active and details.get(check, []) != queue.get('details', {}).get(check, [])
            if active == queue['levels'].get(check, False) and not changed_reason:
                continue
            queue_event(queue, check, active, now, details.get(check, []))
        queue['levels'] = dict(current)
        queue['details'] = details
        queue['observedAt'] = now
        atomic_json(path, queue)
        return len(queue['pending'])


def https_url(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 4096 or any(ord(char) < 33 for char in value):
        raise DeliveryError('invalid_notification_url')
    try:
        url = urllib.parse.urlsplit(value)
        require(url.scheme == 'https' and url.hostname and not url.username and not url.password and not url.fragment)
        require(url.port is None or 1 <= url.port <= 65535)
    except (AssertionError, ValueError):
        raise DeliveryError('invalid_notification_url') from None
    return value


def read_config(path: Optional[Path]) -> Dict[str, Any]:
    if path is None or not path.exists():
        raise DeliveryError('notification_unconfigured')
    private_file(path)
    if path.stat().st_size > 32768:
        raise DeliveryError('notification_config_invalid')
    try:
        config = json.loads(path.read_text(encoding='utf-8'))
        require(integer(config['schemaVersion'], 1, 1))
        allowed = {'schemaVersion', 'webhookUrl', 'headers', 'smtp', 'timeoutSeconds', 'heartbeatUrl',
                   'heartbeatIntervalSeconds', 'auditFreshnessSeconds'}
        require(isinstance(config, dict) and set(config) <= allowed)
        require(('webhookUrl' in config) != ('smtp' in config))
        if 'webhookUrl' in config:
            config['webhookUrl'] = https_url(config['webhookUrl'])
        else:
            config['smtp'] = read_smtp(config['smtp'])
        headers = config.get('headers', {})
        require(isinstance(headers, dict) and len(headers) <= 16)
        reserved = {'host', 'content-length', 'transfer-encoding', 'content-type', 'idempotency-key'}
        require(len({key.lower() for key in headers}) == len(headers))
        for key, value in headers.items():
            require(re.fullmatch(r'[!#$%&\'*+.^_`|~0-9A-Za-z-]+', key) and key.lower() not in reserved)
            require(isinstance(value, str) and len(value) <= 4096 and not any(ord(char) < 32 or ord(char) == 127 for char in value))
        config['headers'] = headers
        config.setdefault('timeoutSeconds', 5)
        config.setdefault('heartbeatIntervalSeconds', 300)
        config.setdefault('auditFreshnessSeconds', 180)
        require(integer(config['timeoutSeconds'], 1, 10))
        require(integer(config['heartbeatIntervalSeconds'], 60, 86400))
        require(integer(config['auditFreshnessSeconds'], 60, 3600))
        if 'heartbeatUrl' in config:
            config['heartbeatUrl'] = https_url(config['heartbeatUrl'])
        return config
    except (AssertionError, KeyError, TypeError, ValueError):
        raise DeliveryError('notification_config_invalid') from None


def mail_address(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 254 or any(ord(char) < 33 or ord(char) > 126 for char in value):
        raise DeliveryError('invalid_mail_address')
    name, address = parseaddr(value)
    if name or address != value or not re.fullmatch(r'[A-Za-z0-9.!#$%&\'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}', value):
        raise DeliveryError('invalid_mail_address')
    return value


def read_smtp(value: Any) -> Dict[str, Any]:
    try:
        allowed = {'host', 'port', 'security', 'username', 'passwordFile', 'from', 'to', 'auth', 'serverName'}
        required = {'host', 'port', 'security', 'from', 'to'}
        require(isinstance(value, dict) and required <= set(value) <= allowed)
        host = value['host']
        require(isinstance(host, str) and 0 < len(host) <= 253 and re.fullmatch(r'[A-Za-z0-9.:-]+', host))
        require(integer(value['port'], 1, 65535) and value['security'] in ('ssl', 'starttls', 'local'))
        authenticate = value.get('auth', True)
        require(type(authenticate) is bool)
        server_name = value.get('serverName', host)
        require(isinstance(server_name, str) and 0 < len(server_name) <= 253 and re.fullmatch(r'[A-Za-z0-9.:-]+', server_name))
        if value['security'] == 'local':
            require(ipaddress.ip_address(host).is_loopback and not authenticate)
            require('username' not in value and 'passwordFile' not in value and 'serverName' not in value)
        else:
            require(authenticate)
        sender = mail_address(value['from'])
        require(isinstance(value['to'], list) and 1 <= len(value['to']) <= 10)
        recipients = [mail_address(recipient) for recipient in value['to']]
        require(len(set(recipients)) == len(recipients))
        configured = {'host': host, 'port': value['port'], 'security': value['security'],
                      'auth': authenticate, 'serverName': server_name, 'from': sender, 'to': recipients}
        if not authenticate:
            return configured
        require(isinstance(value['username'], str) and 0 < len(value['username']) <= 254)
        require(not any(ord(char) < 32 or ord(char) == 127 for char in value['username']))
        require(isinstance(value['passwordFile'], str))
        password_path = Path(value['passwordFile'])
        require(password_path.is_absolute())
        private_file(password_path)
        require(password_path.stat().st_size <= 4096)
        password = password_path.read_text(encoding='utf-8').rstrip('\r\n')
        require(0 < len(password) <= 4096 and not any(ord(char) < 32 or ord(char) == 127 for char in password))
        return dict(configured, username=value['username'], password=password)
    except (KeyError, TypeError, ValueError):
        raise DeliveryError('smtp_config_invalid') from None
    except OSError:
        raise DeliveryError('smtp_credentials_unavailable') from None


class NamedTlsSMTP_SSL(smtplib.SMTP_SSL):
    def __init__(self, server_name, *args, **kwargs):
        self.tls_server_name = server_name
        super().__init__(*args, **kwargs)

    def _get_socket(self, host, port, timeout):
        socket = smtplib.SMTP._get_socket(self, host, port, timeout)
        try:
            return self.context.wrap_socket(socket, server_hostname=self.tls_server_name)
        except BaseException:
            socket.close()
            raise


class NamedTlsSMTP(smtplib.SMTP):
    def __init__(self, server_name, *args, **kwargs):
        self.tls_server_name = server_name
        super().__init__(*args, **kwargs)

    def starttls(self, *, context=None):
        # smtplib uses _host for certificate verification, independently of the connected address.
        host = self._host
        self._host = self.tls_server_name
        try:
            return super().starttls(context=context)
        finally:
            self._host = host


def send_mail(config: Mapping[str, Any], payload: Mapping[str, Any], timeout: int) -> None:
    labels = {'payment_recovery': 'Payment recovery', 'callback_delivery': 'Merchant callback',
              'financial_integrity': 'Financial integrity', 'source_sync': 'Source synchronization',
              'aged_submissions': 'Aged pending orders', 'audit_unavailable': 'Payment monitor',
              'invoice_readiness': 'Invoice provider readiness'}
    message = EmailMessage()
    state = 'ALERT' if payload['state'] == 'opened' else 'RECOVERED'
    check = labels[payload['check']]
    message['Subject'] = '[StarPAY] {}: {}'.format(state, check)
    message['From'] = config['from']
    message['To'] = ', '.join(config['to'])
    message['Message-ID'] = '<{}@starpay-alert.local>'.format(payload['id'])
    message['Date'] = formatdate(payload['occurredAt'], usegmt=True)
    message.set_content('{}: {}\nObserved: {}\nEvent ID: {}\nReason codes: {}\n\n'
                        'This message reports a read-only payment monitor finding. '
                        'No order or financial state was changed.\n'.format(state, check, message['Date'], payload['id'],
                                                                          ', '.join(payload.get('codes', [])) or 'none'))
    context = ssl.create_default_context()
    try:
        if config['security'] == 'ssl':
            if config['serverName'] == config['host']:
                connection = smtplib.SMTP_SSL(config['host'], config['port'], timeout=timeout, context=context)
            else:
                connection = NamedTlsSMTP_SSL(config['serverName'], config['host'], config['port'], timeout=timeout, context=context)
        else:
            if config['security'] == 'starttls' and config['serverName'] != config['host']:
                connection = NamedTlsSMTP(config['serverName'], config['host'], config['port'], timeout=timeout)
            else:
                connection = smtplib.SMTP(config['host'], config['port'], timeout=timeout)
        with connection as smtp:
            if config['security'] == 'starttls':
                smtp.ehlo()
                smtp.starttls(context=context)
                smtp.ehlo()
            if config['auth']:
                smtp.login(config['username'], config['password'])
            if smtp.send_message(message, from_addr=config['from'], to_addrs=config['to']):
                raise DeliveryError('smtp_recipient_rejected')
    except (smtplib.SMTPException, OSError):
        raise DeliveryError('smtp_delivery_failed') from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        return None


def post(url: str, payload: Mapping[str, Any], headers: Mapping[str, str], timeout: int) -> None:
    request = urllib.request.Request(url, data=json.dumps(payload, separators=(',', ':')).encode(),
        method='POST', headers=dict(headers, **{'Content-Type': 'application/json', 'Idempotency-Key': payload['id']}))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            if not 200 <= response.status < 300:
                raise DeliveryError('notification_http_failure')
    except urllib.error.HTTPError as error:
        error.close()
        raise DeliveryError('notification_http_failure') from None
    except (OSError, urllib.error.URLError, ValueError):
        raise DeliveryError('notification_transport_failure') from None


def claim(path: Path, now: int) -> Optional[Dict[str, Any]]:
    with queue_lock(path):
        queue = load_queue(path)
        if not queue['pending']:
            return None
        event = queue['pending'][0]
        if event['nextAttemptAt'] > now or event.get('leaseUntil', 0) > now:
            return None
        event['leaseToken'] = uuid.uuid4().hex
        event['leaseUntil'] = now + LEASE_SECONDS
        atomic_json(path, queue)
        return dict(event)


def finish(path: Path, event: Mapping[str, Any], now: int, delivered: bool) -> None:
    with queue_lock(path):
        queue = load_queue(path)
        if not queue['pending']:
            raise DeliveryError('delivery_lease_lost')
        saved = queue['pending'][0]
        if saved['id'] != event['id'] or saved.get('leaseToken') != event['leaseToken']:
            raise DeliveryError('delivery_lease_lost')
        if delivered:
            queue['pending'].pop(0)
        else:
            saved['attempts'] += 1
            saved['nextAttemptAt'] = now + min(30 * 2 ** min(saved['attempts'] - 1, 7), 3600)
            saved.pop('leaseToken', None)
            saved.pop('leaseUntil', None)
        atomic_json(path, queue)


def deliver(path: Path, config: Mapping[str, Any], now: Optional[int] = None,
            transport: Callable[..., None] = post,
            mail_transport: Callable[..., None] = send_mail) -> Dict[str, Any]:
    timestamp = (lambda: int(time.time())) if now is None else (lambda: now)
    with queue_lock(path):
        queue = load_queue(path)
        audit_age = timestamp() - queue['observedAt']
        stale_audit = queue['observedAt'] == 0 or not 0 <= audit_age <= config['auditFreshnessSeconds']
        if stale_audit and not queue['levels'].get('audit_unavailable', False) and len(queue['pending']) < MAX_PENDING:
            queue_event(queue, 'audit_unavailable', True, timestamp())
            queue['levels']['audit_unavailable'] = True
            # The sender cannot supply the completed audit needed for recovery or a heartbeat.
            atomic_json(path, queue)
    sent = 0
    failure = None
    for _ in range(MAX_SENDS):
        event = claim(path, timestamp())
        if event is None:
            break
        payload = {key: event[key] for key in ('id', 'check', 'state', 'occurredAt')}
        if 'codes' in event:
            payload['codes'] = event['codes']
        payload.update(schemaVersion=1, event='perpay_payment_alert')
        try:
            if 'smtp' in config:
                mail_transport(config['smtp'], payload, config['timeoutSeconds'])
            else:
                transport(config['webhookUrl'], payload, config['headers'], config['timeoutSeconds'])
        except (DeliveryError, OSError):
            finish(path, event, timestamp(), False)
            failure = 'notification_delivery_failed'
            break
        finish(path, event, timestamp(), True)
        sent += 1
    with queue_lock(path):
        now = timestamp()
        queue = load_queue(path)
        recent_audit = queue['observedAt'] > 0 and 0 <= now - queue['observedAt'] <= config['auditFreshnessSeconds']
        if not recent_audit and not queue['levels'].get('audit_unavailable', False):
            if len(queue['pending']) >= MAX_PENDING:
                failure = failure or 'queue_full'
            else:
                queue_event(queue, 'audit_unavailable', True, now)
                queue['levels']['audit_unavailable'] = True
                atomic_json(path, queue)
        pending = len(queue['pending'])
        healthy_audit = recent_audit and not queue['levels'].get('audit_unavailable', True)
        heartbeat_due = 'heartbeatUrl' in config and now - queue['heartbeatAt'] >= config['heartbeatIntervalSeconds']
        heartbeat_due = heartbeat_due and queue.get('heartbeatLeaseUntil', 0) <= now and healthy_audit
        if heartbeat_due:
            queue['heartbeatLeaseUntil'] = now + LEASE_SECONDS
            atomic_json(path, queue)
    heartbeat_sent = False
    if heartbeat_due:
        identity = '{}:heartbeat:{}'.format(queue['queueId'], now // config['heartbeatIntervalSeconds'])
        payload = {'schemaVersion': 1, 'event': 'perpay_monitor_heartbeat', 'occurredAt': now,
                   'id': hashlib.sha256(identity.encode()).hexdigest(), 'pendingAlerts': pending}
        try:
            transport(config['heartbeatUrl'], payload, {}, config['timeoutSeconds'])
            heartbeat_sent = True
        except (DeliveryError, OSError):
            failure = failure or 'heartbeat_delivery_failed'
        with queue_lock(path):
            queue = load_queue(path)
            if heartbeat_sent:
                queue['heartbeatAt'] = now
            queue.pop('heartbeatLeaseUntil', None)
            atomic_json(path, queue)
    error = failure or ('audit_observation_stale' if not healthy_audit else
                        'notification_retry_pending' if pending else None)
    return {'ok': error is None, 'sent': sent, 'pending': pending, 'heartbeatSent': heartbeat_sent,
            'auditFresh': healthy_audit, 'error': error}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--queue', type=Path, required=True)
    parser.add_argument('--config', type=Path)
    parser.add_argument('--check-config', action='store_true')
    args = parser.parse_args()
    try:
        config = read_config(args.config)
        report = {'ok': True, 'configured': True} if args.check_config else deliver(args.queue, config)
        print(json.dumps(report))
        return 0 if report['ok'] else 1
    except DeliveryError as error:
        print(json.dumps({'ok': False, 'status': 'blocked', 'error': str(error)}))
        return 2
    except (OSError, ValueError):
        print(json.dumps({'ok': False, 'status': 'failed', 'error': 'notification_state_io_failure'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
