# Payment alert delivery

The financial audit stays read-only and network-isolated. `perpay-payment-alerts.py`
writes the existing `perpay-payment-alert` journal transitions and, when
`--delivery-state` is configured, a persistent notification outbox. A separate
oneshot service sends SMTP mail or an HTTPS webhook. It never changes an order,
balance, callback, invoice or reconciliation result.

## Checks and delivery guarantees

- `payment_recovery`: overdue, stalled or invalid official payment-query tasks.
- `callback_delivery`: failed, delayed or awaiting-merchant callbacks.
- `financial_integrity`: payment, refund, settlement or ledger inconsistencies.
- `source_sync`: synchronization unavailable or at least 90 seconds old.
- `aged_submissions`: historical pending orders or missing payment details. These
  findings remain visible even when financial integrity is healthy.
- `audit_unavailable`: invalid output, timeout or an unexpected audit exit code.
- `invoice_readiness`: optional provider-readiness report unhealthy, missing,
  invalid or older than 90 minutes. This uses the report's `healthy` flag;
  `canActivate:false` or closed issuance switches alone are not faults.

A readable audit exiting `1` means findings were found. The monitor records and
queues them, then exits successfully. Invalid audit output or execution failure
still exits nonzero. A successful timer run therefore does not imply that every
business check is healthy; the journal, queue and original report retain that
distinction.

Queue events are fsynced before the journal checkpoint. Repeated observations
do not enqueue duplicate transitions. An opened event precedes its recovery;
invoice reason-code changes also enqueue a new active notification. A failed
send retains its event and retries after 30 seconds, doubling up to one hour,
with no attempt budget that discards an undelivered event. The queue refuses
corrupt state or more than 10,000 pending events rather than resetting evidence.

Delivery is at least once: a crash after recipient acceptance can cause a retry.
Webhook `Idempotency-Key` and mail `Message-ID` remain stable across retries.
Receivers should deduplicate the webhook ID. SMTP mailbox deduplication is not
guaranteed. Leases last 180 seconds and stale workers cannot acknowledge another
worker's lease. Keep the sender service's hard timeout at or below 120 seconds.

## Private notification configuration

Use one transport per private JSON file. Never commit it or put its URL, password
or authorization headers into command arguments. Both this JSON and any password
file must be regular files with mode `0600`, readable by the sender service user.
The queue directory must belong to that user and have mode `0700`.

Authenticated SMTP with certificate verification:

```json
{
  "schemaVersion": 1,
  "smtp": {
    "host": "smtp.example.net",
    "port": 587,
    "security": "starttls",
    "auth": true,
    "username": "alerts@example.net",
    "passwordFile": "/var/lib/perpay-alerts/smtp-password.private",
    "from": "alerts@example.net",
    "to": ["operations@example.net"]
  },
  "timeoutSeconds": 5
}
```

`security:"ssl"` uses implicit TLS, commonly port 465. `starttls` upgrades and
verifies TLS before authentication. `serverName` may specify the certificate/SNI
name separately from the connected host; hostname and CA validation stay enabled.
The password file contains only the password, with an optional final newline.
No password or recipient is stored in the event queue or delivery summary.

For an existing local relay that secures its own upstream connection, the only
plaintext exception is an explicitly configured literal loopback IP:

```json
{
  "schemaVersion": 1,
  "smtp": {
    "host": "127.0.0.1",
    "port": 25,
    "security": "local",
    "auth": false,
    "from": "alerts@example.net",
    "to": ["operations@example.net"]
  }
}
```

Loopback relay configuration cannot contain credentials or `serverName`.
Remote plaintext SMTP and unauthenticated remote SMTP are rejected. The code
does not infer a relay or choose a recipient.

Alternative generic webhook:

```json
{
  "schemaVersion": 1,
  "webhookUrl": "https://monitor.example.net/hooks/private-token",
  "headers": {"Authorization": "Bearer private-token"},
  "timeoutSeconds": 5
}
```

The receiver must accept POST JSON with `schemaVersion`, `event`, `id`, `check`,
`state` and `occurredAt` (Unix seconds). Invoice notifications additionally carry
validated reason `codes`, never provider response bodies or customer details.
Only HTTP 2xx acknowledges delivery. Redirects, HTTP URLs, URL credentials and
header injection are rejected. Environment proxy settings are not used.

An optional `heartbeatUrl` must also be HTTPS. It receives a POST every
`heartbeatIntervalSeconds` (default 300) only if a completed audit was observed
within `auditFreshnessSeconds` (default 180). Configure an independent monitor to
alert when this heartbeat stops. It proves monitor liveness, not healthy payment
business checks. Without an independently configured recipient, a host cannot
notify anyone after the entire host goes offline.

## Install with the existing source deployment

Resolve the active service user and paths first. Install both Python files beside
each other in `/usr/local/libexec`; keep the financial audit's existing command
and `PrivateNetwork=yes`. Its existing wrapper command gains:

```text
--delivery-state /var/lib/perpay-alerts/delivery.json
```

Give that audit service `StateDirectory=perpay-alerts`,
`StateDirectoryMode=0700`, `UMask=0077` and write access to the directory under its
existing filesystem sandbox. Preserve its other restrictions. Use a persistent
state directory for notifications rather than the former `/run` state alone.

If invoice checks are installed, also pass:

```text
--invoice-readiness /var/lib/perpay-automation/invoice-readiness.json
```

The file is a private JSON report containing `schemaVersion:1`, an ISO-8601
`checkedAt` with timezone, boolean `healthy` and `canActivate`,
`remoteVerification` (`PASSED`, `FAILED`, `NOT_PERFORMED`) and a list of blocker
codes. Codes are restricted to letters, digits and underscores; arbitrary
provider errors and personal information are not forwarded. A half-written or
missing report opens an explicit readiness alert. The writer should publish it
atomically.

Example separate `perpay-alert-delivery.service` (substitute the verified user):

```ini
[Unit]
Description=Deliver persistent PerPay payment alerts
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=perpay-candidate
Group=perpay-candidate
StateDirectory=perpay-alerts
StateDirectoryMode=0700
UMask=0077
ExecStart=/usr/bin/python3 /usr/local/libexec/payment_alert_delivery.py --queue /var/lib/perpay-alerts/delivery.json --config /var/lib/perpay-alerts/notify.private.json
TimeoutStartSec=120
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=/var/lib/perpay-alerts
```

Example `perpay-alert-delivery.timer`:

```ini
[Unit]
Description=Retry PerPay payment alert delivery

[Timer]
OnBootSec=45s
OnUnitInactiveSec=60s
AccuracySec=5s
Unit=perpay-alert-delivery.service

[Install]
WantedBy=timers.target
```

Before enabling, validate the units, then validate configuration without sending:

```sh
python3 /usr/local/libexec/payment_alert_delivery.py \
  --queue /var/lib/perpay-alerts/delivery.json \
  --config /var/lib/perpay-alerts/notify.private.json --check-config
systemd-analyze verify /etc/systemd/system/perpay-alert-delivery.service /etc/systemd/system/perpay-alert-delivery.timer
```

`--check-config` validates local configuration only; it does not prove mail or
webhook delivery. Start the existing audit to seed its actual findings, then run
the sender and check its JSON summary and the authorized receiver. A missing
notification configuration exits `2` with `notification_unconfigured`; pending
events remain queued. A failed send, a stale audit or pending retries exits `1`.
Only `pending:0` with a fresh audit and no delivery error exits `0`.

Do not send a forged financial finding to a production order endpoint to test
notifications. A separate temporary queue and explicitly labelled synthetic
event can test delivery to the authorized recipient without touching any order.

## Verification and rollback

```sh
python3 test/payment-alerts.test.py
python3 -O test/payment-alerts.test.py
```

Tests cover network failures, stable IDs, duplicate and changed observations,
recovery ordering, restart leases and fencing, corrupt/full state, missing
configuration, TLS-before-authentication, local-relay restrictions, SNI,
credential redaction, unavailable audits and stale invoice readiness. They use
injected transports and do not send mail, call providers or move money.

To stop external delivery, disable only `perpay-alert-delivery.timer` and stop its
service. Retain the persistent queue and private configuration for recovery.
The financial audit and journal alerts continue. A code rollback must restore
the matching two Python files together; retain any queue evidence separately
before deploying an older schema reader. Do not delete financial data or mark
orders paid to silence an alert.
