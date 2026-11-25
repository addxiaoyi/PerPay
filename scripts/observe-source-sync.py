"""Observe existing synchronization and readiness for a bounded window without starting a sync."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

MAX_SOURCE_AGE_MS = 90000
SAFE_REASONS = {
    'request_timeout', 'source_query_timeout', 'database_busy', 'connection_failure',
    'source_lock_cleanup_failed', 'source_lock_deadline', 'source_lock_window',
    'main_snapshot_unavailable', 'main_snapshot_signature_missing', 'main_snapshot_signature_invalid',
    'main_snapshot_identity_or_window', 'source_reader_privileges', 'source_protocol_rejected',
    'unknown_failure', 'unclassified_failure', 'delivery_rejected', 'apply_rejected', 'invalid_reply',
}
SAFE_STEPS = {
    'read_secrets', 'open_candidate', 'legacy_process', 'source_connect', 'source_grants', 'source_session',
    'capture_shared_sources', 'source_schema', 'source_lock', 'source_unlock', 'main_snapshot',
    'seal_capture', 'apply_shared_delta', 'close_source',
}
SAFE_STEPS.update('source_' + table for table in [
    'Merchant', 'AdminSession', 'MerchantBinding', 'MerchantInvoiceConfig', 'PayType', 'Channel',
    'Order', 'NotifyLog', 'Invoice', 'InvoiceApplication', 'Config',
])


def parse_time(value):
    if not isinstance(value, str):
        raise ValueError('timestamp must be a string')
    for pattern in ['%Y-%m-%dT%H:%M:%S.%fZ', '%Y-%m-%dT%H:%M:%SZ']:
        try:
            return int(datetime.strptime(value, pattern).replace(tzinfo=timezone.utc).timestamp() * 1000)
        except ValueError:
            continue
    raise ValueError('UTC source timestamp required')


def source_status(connection, now):
    row = connection.execute("SELECT value FROM system_metadata WHERE key='epay_source_sync'").fetchone()
    if row is None:
        return {'ready': False, 'reason': 'source_status_missing'}
    try:
        status = json.loads(row[0])
        captured = parse_time(status.get('capturedAt'))
        applied = status.get('appliedAt')
        age = now - captured
        valid = (type(status.get('version')) is int and status['version'] == 1 and status.get('ok') is True and 0 <= age <= MAX_SOURCE_AGE_MS and
                 type(applied) is int and captured <= applied <= now and
                 isinstance(status.get('sourceSha256'), str) and re.fullmatch('[a-f0-9]{64}', status['sourceSha256']) is not None)
        for table, field in [('epay_main_sync_runs', 'mainSequence'), ('epay_legacy_sync_runs', 'legacySequence')]:
            latest = connection.execute('SELECT sequence,captured_at FROM ' + table + ' ORDER BY sequence DESC LIMIT 1').fetchone()
            valid = valid and latest is not None and type(status.get(field)) is int and latest[0] == status[field] and latest[1] <= captured
        return {'ready': bool(valid), 'sourceAgeMs': age, 'reason': None if valid else 'source_proof_not_ready'}
    except (ValueError, TypeError, AttributeError):
        return {'ready': False, 'reason': 'source_status_invalid'}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def probe(origin, path):
    started = time.monotonic()
    try:
        with urllib.request.build_opener(NoRedirect).open(origin + path, timeout=3) as response:
            status = response.status
            # Health payloads are small. No customer/source payloads are read by this observer.
            raw = response.read(65537)
            payload = json.loads(raw) if len(raw) <= 65536 else None
        ready = isinstance(payload, dict) and payload.get('status') == 'ready'
        return {'ok': status == 200 and ready, 'status': status, 'milliseconds': round((time.monotonic()-started)*1000)}
    except (OSError, ValueError, urllib.error.URLError):
        return {'ok': False, 'reason': 'probe_unavailable', 'milliseconds': round((time.monotonic()-started)*1000)}


def journal_summary(lines):
    counts = {'successful': 0, 'retries': 0, 'failed': 0}
    reasons, phases, maxima = {}, {}, {}
    for line in lines:
        if not line.startswith('{'):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        if event.get('ok') is True:
            counts['successful'] += 1
        elif event.get('error') == 'legacy_source_sync_retry':
            counts['retries'] += 1
        elif event.get('error') == 'legacy_source_sync_failed':
            counts['failed'] += 1
        else:
            continue
        for key, collection, allowed in [('reason', reasons, SAFE_REASONS), ('failedStep', phases, SAFE_STEPS)]:
            value = event.get(key)
            if isinstance(value, str) and value in allowed:
                collection[value] = collection.get(value, 0) + 1
        durations = event.get('phaseMilliseconds')
        if isinstance(durations, dict):
            for step, duration in durations.items():
                if step in SAFE_STEPS and type(duration) is int and 0 <= duration <= 3600000:
                    maxima[step] = max(maxima.get(step, 0), duration)
    return dict(counts, reasons=reasons, failedSteps=phases, maximumPhaseMs=maxima)


def main(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root', required=True)
    parser.add_argument('--origin', default='http://127.0.0.1:16191')
    parser.add_argument('--duration-seconds', type=int, default=120)
    parser.add_argument('--interval-seconds', type=int, default=10)
    args = parser.parse_args(arguments)
    origin = urllib.parse.urlsplit(args.origin)
    if (not re.fullmatch('/var/lib/perpay-candidate-[a-z0-9-]+', args.data_root) or
            origin.scheme != 'http' or origin.hostname not in ['127.0.0.1', '::1'] or origin.path or
            origin.username or origin.password or origin.query or origin.fragment or
            not 30 <= args.duration_seconds <= 1800 or not 5 <= args.interval_seconds <= 60):
        parser.error('explicit loopback origin, candidate data root and bounded observation window required')
    started_at = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
    started = time.monotonic()
    deadline = started + args.duration_seconds
    samples = []
    while time.monotonic() < deadline:
        sample = {'elapsedSeconds': round(time.monotonic()-started)}
        try:
            database = Path(args.data_root, 'data/perpay.sqlite3').as_uri() + '?mode=ro'
            connection = sqlite3.connect(database, uri=True, timeout=1)
            try:
                sample['source'] = source_status(connection, int(time.time()*1000))
            finally:
                connection.close()
        except (OSError, sqlite3.Error):
            sample['source'] = {'ready': False, 'reason': 'source_read_unavailable'}
        sample['readiness'] = probe(args.origin, '/pay/epay/readyz')
        samples.append(sample)
        print(json.dumps({'event': 'source_sync_observation', **sample}), flush=True)
        remaining = deadline-time.monotonic()
        if remaining > 0:
            time.sleep(min(args.interval_seconds, remaining))
    try:
        completed = subprocess.run(['journalctl', '-u', 'perpay-legacy-sync.service', '--since', started_at,
                                    '--no-pager', '-o', 'cat', '-n', '1000'],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True,
                                   timeout=10, check=False)
        lines = completed.stdout.splitlines()
        journal_ok = completed.returncode == 0 and len(lines) < 1000
        events = journal_summary(lines)
    except (OSError, subprocess.TimeoutExpired):
        journal_ok, events = False, journal_summary([])
    ready = bool(samples) and all(sample['source']['ready'] and sample['readiness']['ok'] for sample in samples)
    # No samples, missing journal access, or no completed sync is an incomplete observation, never a pass.
    passed = ready and journal_ok and events['successful'] > 0 and events['retries'] == 0 and events['failed'] == 0
    print(json.dumps({'event': 'source_sync_acceptance', 'passed': passed, 'readOnly': True,
                      'elapsedSeconds': round(time.monotonic()-started), 'samples': len(samples),
                      'allSamplesReady': ready, 'journalAvailable': journal_ok, **events,
                      'scope': 'bounded observation; not long-term availability proof'}), flush=True)
    return 0 if passed else 1


if __name__ == '__main__':
    sys.exit(main())
