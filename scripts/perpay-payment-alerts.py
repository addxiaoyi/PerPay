"""Run the financial audit, journal transitions and queue reliable notifications."""
import argparse
from datetime import datetime
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
from typing import Mapping, Optional

from payment_alert_delivery import CHECKS, DeliveryError, atomic_json, observe, private_file, reason_codes


AUDIT_TIMEOUT_SECONDS = 15
INVOICE_MAX_AGE_SECONDS = 90 * 60


def active_alerts(report):
    def count(group, key):
        value = group[key]
        if type(value) is not int or value < 0:
            raise ValueError('invalid audit count')
        return value

    recovery = report['paymentRecovery']
    callbacks = report['callbacks']
    if type(report['financialHealthy']) is not bool or type(report['sourceSyncReady']) is not bool:
        raise ValueError('invalid audit health')
    source_stale = count(report, 'sourceSyncAgeMs') >= 90000 or not report['sourceSyncReady']
    delivery_failed = count(callbacks, 'failed') + count(callbacks, 'delayed') > 0
    return {
        'payment_recovery': sum(count(recovery, key) for key in ['overdue', 'stalled', 'invalid']) > 0,
        'callback_delivery': sum(count(callbacks, key) for key in ['failed', 'delayed', 'awaitingMerchant']) > 0,
        'financial_integrity': count(report, 'inconsistentPayments') + count(report['refunds'], 'inconsistent') +
        count(report['settlements'], 'inconsistent') + count(report, 'ledgerProofErrors') > 0 or
        (not report['financialHealthy'] and not source_stale and not delivery_failed),
        'source_sync': source_stale,
        'aged_submissions': sum(count(report['submissions'], key) for key in ['unresolved', 'missingPaymentDetails']) > 0,
    }


def transition(previous, current):
    for name, active in current.items():
        if active and not previous.get(name, False):
            yield name, 'opened', 'err'
        elif not active and previous.get(name, False):
            yield name, 'resolved', 'info'


def previous_alerts(path: Path):
    try:
        private_file(path)
        previous = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {}
    if not isinstance(previous, dict) or not set(previous) <= CHECKS or not all(type(level) is bool for level in previous.values()):
        raise DeliveryError('alert_state_invalid')
    return previous


def invoice_alert(path: Path, now: Optional[int] = None):
    now = int(time.time()) if now is None else now
    try:
        private_file(path)
        if path.stat().st_size > 65536:
            raise ValueError('invoice readiness too large')
        readiness = json.loads(path.read_text(encoding='utf-8'))
        if type(readiness['schemaVersion']) is not int or readiness['schemaVersion'] != 1:
            raise ValueError('invoice readiness version')
        if type(readiness['healthy']) is not bool or type(readiness['canActivate']) is not bool:
            raise ValueError('invoice readiness flags')
        if readiness['remoteVerification'] not in ('PASSED', 'FAILED', 'NOT_PERFORMED'):
            raise ValueError('invoice readiness verification')
        if not reason_codes(readiness['blockers']):
            raise ValueError('invoice readiness reasons')
        stamp = readiness['checkedAt']
        if not isinstance(stamp, str):
            raise ValueError('invoice readiness timestamp')
        # Production still uses Python 3.6, whose %z parser needs compact offsets.
        normalized = stamp[:-1] + '+0000' if stamp.endswith('Z') else stamp
        normalized = re.sub(r'([+-]\d{2}):(\d{2})$', r'\1\2', normalized)
        pattern = '%Y-%m-%dT%H:%M:%S.%f%z' if '.' in normalized else '%Y-%m-%dT%H:%M:%S%z'
        checked = datetime.strptime(normalized, pattern)
        if checked.tzinfo is None:
            raise ValueError('invoice readiness timezone')
        age = now - checked.timestamp()
        if age < -60:
            return True, ['INVOICE_READINESS_CLOCK_SKEW']
        if age > INVOICE_MAX_AGE_SECONDS:
            return True, ['INVOICE_READINESS_STALE']
        if not readiness['healthy']:
            return True, sorted(set(readiness['blockers'])) or ['INVOICE_READINESS_UNHEALTHY']
        return False, []
    except FileNotFoundError:
        return True, ['INVOICE_READINESS_MISSING']
    except (OSError, KeyError, TypeError, ValueError, AttributeError, DeliveryError):
        return True, ['INVOICE_READINESS_INVALID']


def record_observation(path: Path, previous: Mapping[str, bool], current: Mapping[str, bool],
                       delivery_path: Optional[Path] = None, details=None):
    # Queue first: a crash between journal output and its checkpoint cannot lose a notification.
    if delivery_path is not None:
        observe(delivery_path, current, details=details)
    else:
        print(json.dumps({'event': 'perpay_notification_status', 'status': 'blocked',
                          'error': 'delivery_queue_unconfigured'}), file=sys.stderr)
    for name, state, priority in transition(previous, current):
        event = json.dumps({'event': 'perpay_payment_alert', 'check': name, 'state': state})
        subprocess.run(['systemd-cat', '-t', 'perpay-payment-alert', '-p', priority],
                       input=event + '\n', universal_newlines=True, check=True, timeout=5)
    atomic_json(path, current)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--unit', type=Path, required=True)
    parser.add_argument('--delivery-state', type=Path)
    parser.add_argument('--invoice-readiness', type=Path)
    args = parser.parse_args()
    commands = [shlex.split(line[len('ExecStart='):]) for line in args.unit.read_text().splitlines()
                if line.startswith('ExecStart=')]
    if len(commands) != 1 or len(commands[0]) != 4 or not commands[0][2].endswith('/scripts/audit-live-gateway.ts'):
        parser.error('expected one payment audit command in the service unit')
    audit = commands[0]
    previous = previous_alerts(args.state)
    try:
        result = subprocess.run(audit, stdout=subprocess.PIPE, check=False,
                                universal_newlines=True, timeout=AUDIT_TIMEOUT_SECONDS)
        output = result.stdout
        status = result.returncode
    except (OSError, subprocess.TimeoutExpired):
        output = ''
        status = 1
    print(output, end='', flush=True)
    try:
        current = active_alerts(json.loads(output))
        current['audit_unavailable'] = status not in (0, 1)
    except (KeyError, TypeError, ValueError):
        current = dict(previous, audit_unavailable=True)
    # The first failed audit still records every check so the queue schema stays explicit.
    current = dict({check: False for check in CHECKS}, **current)
    details = None
    if args.invoice_readiness is not None:
        current['invoice_readiness'], codes = invoice_alert(args.invoice_readiness)
        details = {'invoice_readiness': codes}
    record_observation(args.state, previous, current, args.delivery_state, details)
    # A readable audit with findings is a successful monitor run, with findings still open.
    return 1 if current['audit_unavailable'] else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except DeliveryError as error:
        print(json.dumps({'ok': False, 'event': 'perpay_notification_status', 'error': str(error)}), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, subprocess.SubprocessError):
        print(json.dumps({'ok': False, 'event': 'perpay_notification_status', 'error': 'alert_monitor_failed'}), file=sys.stderr)
        sys.exit(1)
