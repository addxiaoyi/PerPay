# EPay to PerPay cutover gates

Status: PerPay production order ingress opened on 2026-11-06 at 20:42 CST.
The user authorized deployment and cutover. Full legacy feature parity and the
first real native payment remain acceptance work; opening ingress does not prove
settlement, merchant notification delivery, or every old channel flow.

## Current production checkpoint - 2026-11-07 00:38 CST

- Active code: `/opt/perpay-candidate-20261107c/app`, version `1.0.0-rc.10`,
  schema 66; data remains `/var/lib/perpay-candidate-20261106m`.
- Administrator and merchant frontends have separate URLs, navigation and
  workflows: `/pay/admin/` and `/pay/merchant/`. Both use the main-site session.
  Full details and acceptance evidence are in [payment-portals.md](payment-portals.md).
- 97 Node 24 release checks and 133-table restore comparison passed. Six browser
  flows passed at 320/390/1440px in light/dark themes. Public checks verified
  33 assets, both route bases, deep links and anonymous API rejection.
- Public admission is live and ready. The integrity monitor is healthy with four
  balanced merchants, 561 gateway orders, 211 main orders and 22 preserved
  invoices. The 76 unbound orders remain quarantined; no new financial test
  operations were submitted. New invoicing remains disabled.
- Merchant enrollment, EPay key rotation, settlements, native refund processing,
  Alipay web redirects and callback retry are now implemented. Original main-site
  API key rotation remains at its authority. Native real-payment acceptance is
  deferred at the user's request; this frontend acceptance does not prove it.
- The verified closed WeChat order now passes startup integrity only with its
  matching system audit and without a payment posting or callback. A restore and
  reopen regression covers this. A transient release sync failure was recovered
  with `resume-live-code.py`; it did not restore or replace the financial data.
- Deployment evidence is in `/root/perpay-recovery-20261106-rc10/`:
  `portals-20261107c-deploy.json`, `portals-20261107c-live.json`,
  `portals-20261107c-integrity.json`, and `separated-portals/report.json`.
  The snapshot-reader rotation is verified; legacy writer rotation remains open.

The following checkpoint and remaining-work notes are historical. This section
and the linked portal record supersede their code paths and frontend status.

## Verified production checkpoint - 2026-11-06 20:47 CST

- Active code: `/opt/perpay-candidate-20261106g/app`, `1.0.0-rc.5`, Node
  `v24.22.1`; active data: `/var/lib/perpay-candidate-20261106e`, schema 61.
- Public `/pay/epay/readyz` returns 200 with `mode=live`, four accepting
  merchants, verified balance openings, and callback delivery enabled.
  Original `/pay/merchant` and `/pay/admin/merchants` resolve to the PerPay
  merchant workspace. `submit.php`, `mapi.php` and `api.php` retain the original
  `/pay/` paths. New native callbacks and all historical callback owners remain
  separate, including the main-site WeChat notification.
- Cutover proof: `/root/perpay-recovery-20261106-rc5/cutover-20261106/cutover.json`,
  SHA-256 `c63fa2ba5e86d10db50f9b98018e3e8067bca566d31eb4ea4997e1b0080d2b57`.
  The initial switch stopped before admission when the sync job raced listener
  startup. `resume-production-cutover.py` waited for health, reconciled again,
  and opened ingress without re-importing or restoring data.
- Final shared-cutoff comparisons retained 560 EPay orders, 121 notify logs,
  22 invoices, one invoice application, 211 main orders, 54 ledger records,
  one settlement, 45 main callbacks and 211 synchronization jobs. Four merchant
  liabilities matched; 76 orders remain with their original unbound, disabled
  merchant. Nine ambiguous LightPay records retain their old processing owner.
- Schema 60-to-61 restoration retained all 122 prior tables and the original
  key. Subsequent same-schema deployment verified 124 tables. Financial rollback
  rehearsal confirmed 10 synthetic payments, two late payments after pause and
  20 callback retries, with no provider or real merchant requests.
- A real-service-UID, read-only official query verified one historical paid order
  per channel (Alipay and WeChat): signature, recipient identity, transaction ID
  and exact amount all matched. This is sampled historical evidence, not full
  historical provider reconciliation or a new native collection test.
- The source collector now uses `perpay_snapshot_20261105`, with SELECT and LOCK
  TABLES only. Read succeeds and UPDATE is denied. New account, prior consumer
  configuration, then new-account restoration all synchronized successfully.
  Original writer credentials were retained. Evidence: `reader-rollback.json`.
- Merchant UI: create collection link, combined order search/pagination,
  live balance and ledger, fee adjustment/audit, API credentials, membership,
  refund request/admin approval/provider processing and historical invoices.
  Native refunds use durable leases, signed queries and atomic holds/postings.
  `PROCESSING` or unknown provider responses never finalize a refund.
- Per the user's 2026-11-06 instruction, **new invoicing is disabled**. Its four
  public submission paths return a readable maintenance response; historical
  records remain. Do not enable `PERPAY_EPAY_INVOICE_ENABLED` without completing
  issuance and configuring the actual item tax code.
- Read-only `perpay-integrity.timer` runs every minute, checking balances,
  confirmation and refund postings, callback delay and source-sync freshness.
  Latest post-cutover audit: four balanced merchants, zero native payments,
  zero native refunds, zero callback failures, preserved history. Real payment,
  ledger posting and merchant acknowledgement still need observation.
- Local complete Node run: 1,693 tests, 1,673 passed, 20 skipped, zero failed;
  later main-order-list and membership-sync fixes passed focused regressions.
  Admin tests: 2,045 passed initially plus the corrected composition test passed.
  Browser tests: 13 passed at 390/1280px, including permission revocation.
  Final server bundle passed 75 tests under Node 24 before deployment.

## Remaining acceptance

1. Observe a user-created native payment end-to-end using the official channel
   query, the immutable payment proof, merchant ledger and callback acknowledgement.
   Do not create real payments or refunds in automated tests.
2. Complete parity for merchant creation, credential rotation and settlement
   workflows, and review old web/H5/JSAPI flow support. Current native order
   adapters support Alipay QR and WeChat Native; this is not full mobile-channel
   parity. Existing historical checkout and callbacks retain the old owner.
3. Complete all database writer-credential consumer rotation; the new restricted
   snapshot reader is verified but does not rotate the old EPay writers.
4. Close new admission using
   `/root/perpay-recovery-20261106-rc5/rollback-production-perpay.py` if acceptance
   fails. It preserves the upgraded financial database and native callbacks,
   retaining historical callback routing. Never overwrite new records with the
   pre-cutover backup. Do not run this script merely to test a healthy live site.

## Historical pre-cutover checkpoint - 2026-11-06

This section supersedes obsolete configuration and recovery blockers in the
historical observations below. Current deployment evidence takes precedence.

- A read-only jump-host check on 2026-11-06 confirmed the active service runs
  `/opt/perpay-candidate-20261105i/app` with Node `v24.22.1`. Its package version
  is `1.0.0-rc.2`; the live database under
  `/var/lib/perpay-candidate-20261105f/data` is schema 58. The candidate service
  is active, gateway mode is `maintenance`, callback delivery is disabled, and
  `/pay/healthz` returns 200 while `/pay/epay/readyz`, `/pay`,
  `/pay/submit.php`, and `/pay/mapi.php` return 503. No production payment or
  callback was triggered by this inspection.
- An inactive code directory `/opt/perpay-candidate-20261105j/app` contains
  `1.0.0-rc.3` and supports schema 59. Local rc.4 validation passed on
  2026-11-06: 1,679 Node tests (1,659 passed, 20 skipped, 0 failed), version
  check, migration and full TypeScript checks, and production build. The rc.4
  bundle also passed 12 focused tests under the server's Node `v24.22.1` runtime
  in `/opt/perpay-rc4-verify-20261106`; SHA-256
  `5779e36be12317e204b006212a7cbfefbd24a57d6e46079fd66166faa09a117b`.
  That verification did not touch the active service or database. The rc.4
  schema-60 build has not been deployed. The active schema-58 database must not
  be migrated until a matching pre-upgrade database and original master key
  have a verified restore path; reverting only the service unit would leave
  the database unreadable by rc.2 or rc.3.
- The current public probes establish that payment entry remains closed; this
  turn did not inspect or change Nginx routing. Callback delivery and real
  channel acceptance therefore remain unverified.
- The 2026-11-05 read-only balance audit covered four enabled bindings. The
  legacy dashboard formula and full projection agreed for each merchant; this
  was formula compatibility, not financial reconciliation, and every
  projection still reported `financiallyReconciled: false`.
- That audit found one merchant with 110 main-site orders against a 100-order
  matching window, and another with 117 paid EPay orders with no matching
  imported main-site order number. These records remain unresolved. The audit
  found no native-channel intent at its read-only snapshot.
- A 2026-11-05 payment-confirmation audit found zero new provider confirmations,
  zero inconsistent proofs, zero unconfirmed PerPay ledger entries, and zero
  unconfirmed callback jobs. The candidate ledger contained 54 imported
  `main_site` entries and no `perpay_epay` payment entries; the callback outbox
  was empty. Historical `PAID` states are not provider settlement evidence or
  proof that a user balance was credited.
- The 76 unbound EPay orders and nine LightPay ownership findings remain
  preserved separately. Existing bindings do not authorize inventing
  historical ownership. Previous unit restoration tests do not prove financial
  rollback after a candidate has migrated or accepted payments.

## Live order-link audit, 2026-11-05 08:43 CST

- A fresh EPay source read used the running `epay-next-reconcile-v1` process
  configuration and a MySQL `REPEATABLE READ` consistent, read-only transaction.
  The main-site `store.json` was read once while that transaction was open; its
  inode, size and modification time stayed unchanged during the read. Its mtime
  was 2026-11-05 08:42:51 CST. These are separate stores, so this is not a shared
  cutoff and does not prove the JSON file equals the main process's memory.
- The snapshot contained four exact merchant bindings, 560 EPay orders and 211
  main-site orders. Of the 123 EPay `PAID` rows, 122 belonged to bound merchants
  and one remained unbound; 76 EPay orders overall remained unbound.
- Among bound records, the audit found zero exact matches on merchant order
  number (`merchantOrderId`/`outTradeNo`), zero internal-ID projection matches,
  and zero channel-transaction matches (`tradeNo`/`apiTradeNo`). It also found
  zero same-amount candidates for `gatewayOrderId` against EPay trade/provider
  numbers or `wechatOutTradeNo` against EPay `outTradeNo`. These are absent
  candidates in the inspected fields, not proof that records have no owner.
- One bound merchant had 117 paid EPay orders without a main-site order-number
  match. Two bound merchants had 110 and 100 main-site source orders, both at or
  above the legacy 100-row matching-window boundary. A fourth binding had 48
  EPay rows, including five paid rows, and no main-site orders in this snapshot.
  Keep these populations separate; no ownership was inferred or changed.
- The candidate still reports `/pay/readyz` as `not_ready` with
  `system_not_configured`; the gateway remains in maintenance. The audit did not
  create payment, ledger, callback, invoice or merchant records.

Still required before the requested final state is achieved:

1. Resolve the possible 110/100-row main-order truncation and the 117 unmatched
   paid orders using authoritative provider/main-site evidence; keep unproven
   ownership separate.
2. Sign a common-cutoff opening balance and prove the legacy callback path cannot
   credit a new PerPay-confirmed order a second time. The empty candidate outbox
   only shows that no new PerPay payment has exercised this path yet.
3. Install and verify distinct PerPay callback routes while keeping in-flight
   legacy EPay and LightPay notifications on their existing handlers.
4. Finish merchant-management, key, balance-adjustment, refund and invoice parity.
5. Verify supported channel flows, including query/refund/mobile behavior.
6. Capture the final increment at a common cutoff and reconcile every preserved
   merchant/order/ledger/callback/invoice record.
7. Exercise actual legacy/new order routing and rollback while retaining all
   post-cutover financial records. Only then switch production ingress and
   verify payment, accounting and merchant callback outcomes separately;
   `epay_cutover` is currently absent.

No new order, payment, refund, balance adjustment or callback delivery was
triggered by the read-only console releases.

## Verified recovery on 2026-11-04 (supersedes the stale-store blocker below)

The existing persistence conflict was recovered without a process restart or
inspector connection. Before changing metadata, the exact conflicting disk
file was encrypted to an RSA recipient whose private key is protected by the
operator's Windows CurrentUser DPAPI and remains off the server. The archive
was downloaded, its independent digest checked, decrypted and parsed. The
deployed persistence module was rehearsed locally and on the server first.
After checking process identity, source hash, disk inode, timestamp and digest,
the disk mtime was lowered to allow the original scheduled save to run.
The same process atomically replaced the file within 10 seconds. Later saves
advanced its mtime normally. Both pre-recovery and recovered archives are in
`/root/perpay-recovery-20261104`; encrypted off-host copies and the protected
recovery key are in the workspace's sibling `.work/perpay-recovery-20261104`.

Independent decryption of the recovered file found 26 users, 4 main merchants,
211 orders and 54 ledger entries. Integer-cent ledger summaries matched all
four merchant summaries. Paid-order postings had no missing or duplicate
entries, amount differences or merchant mismatches in this archived snapshot.
This does not authenticate provider settlement or establish a final cutoff.

A read-only MySQL snapshot and the resumed main-site file then completed the
combined SQLite import rehearsal on server Node 24: 5 EPay merchants, 4 exact
bindings, 560 EPay orders, 121 notify logs, 22 invoices and 1 invoice application;
211 main orders, 54 ledger entries, 1 settlement, 45 callbacks and 211 sync jobs.
The reopened database passed integrity, encrypted-record round trips and
wrong-key rejection. All four bound current fees matched; the unbound EPay
merchant remains separate with an explicit rehearsal-only zero fee placeholder.
The sources do not share a final cutoff. No production ledger was imported,
no payment was sent, and the public submit ingress remains in maintenance.

On 2026-11-04 an independent Nginx process with a private tmpfs configuration,
loopback-only ports and synthetic legacy and PerPay upstreams exercised
maintenance, candidate cutover and rollback. The two new-order endpoints were
closed during maintenance and rollback and routed to the candidate during
cutover. The old provider paths remained with the legacy fixture; distinct
`/pay/perpay/v1/{alipay,wechat}/notify` paths reached the candidate fixture in
all three phases. Other paths under that prefix, including alternative order
endpoints, returned 404. Reloads used the temporary process PID. The isolated files
were removed. This is a routing design rehearsal, not the actual production
configuration, real provider notification, merchant acceptance, database
reconciliation or a completed production rollback exercise.

On 2026-11-04, read-only inspection of the deployed standalone EPay bundle
confirmed the public status route forwards `apiTradeNo` and `amount` from a
paid query directly into `markOrderPaid`; the inspected payment-helper chunk
only compares amount when the supplied value is truthy. The route file SHA-256
is `143d1cd1a9196294ea26c6ab92f719ffb5823273ca1cc9b604c0b7062e2a144d`;
the payment-helper chunk SHA-256 is
`ef9ce6f0180e32c72a673755e4ae02b55fb8c4ad05a1d32bc17b5ce7a2998f02`.
This verifies the deployed code path, not that an authenticated provider has
ever returned a paid response with missing fields. The local guard is not
deployed. Assess the impact on in-flight checkouts before changing the status
route, and retain authenticated provider callbacks. No production payment was
simulated and no routing was changed during inspection.

On 2026-11-04, inspection of the local legacy EPay source found that the
public `GET /api/pay/status/[tradeNo]` handler calls `markOrderPaid` when a
provider query reports paid, without first requiring an amount or provider
transaction ID. The local `markOrderPaid` amount comparison is conditional on
an amount being supplied. The local legacy Alipay and WeChat query adapters
can return an undefined amount or transaction ID. Therefore a signed paid
query response missing those fields must not be assumed safe to settle. This
is a source-level finding, not proof that the deployed standalone build has
identical code or that a provider has returned such a response. Verify the
deployed build and fix and test all paid-query callers before relying on the
legacy path. Do not send synthetic payment events to production.

On 2026-11-04, inspection of the effective Nginx configuration showed that
the exact `/pay/notify.php` location still uses the LightPay PHP handler and
the `/pay/` prefix still proxies the legacy EPay service. Harmless empty GET
probes returned `fail` from the Alipay notification path, 405 from the WeChat
notification path and 400 from LightPay. A nonexistent status reference
returned 404. Empty POST requests to `/api/merchant/orders` and
`/api/internal/payment/epay-order` returned 503. Inspection of the deployed
payment route file found two calls to its `createOrder` function, at those
two endpoints. These checks do not prove that every ingress variant is closed,
that a provider uses any particular callback URL, or that an authentic
notification would verify, settle, or reach the merchant. No real notification
or payment was sent, and no routing was changed.

On 2026-11-04, a read-only loopback request to the running main-site service
at `/api/merchant/access?merchantId=probe` returned HTTP 404 without a session.
The on-disk payment routes (SHA-256
`a2f62ed81e0679369c41b64cf4c4d76125bdb665b2e65d9335eef765cb1b8dac`)
do not define that route. The local candidate does define and test it, but
the running process was not restarted and its in-memory data has not been
preserved. The PerPay shadow unit also uses a private network and does not
configure a main-site identity origin. The local authorization tests therefore
do not establish an operable production merchant login. Securely preserve and
restore the main-site state, deploy and verify the authorization route, and
establish a restricted identity connection before any merchant cutover.

On 2026-11-03, read-only inspection found `/pay/mapi.php`, `/pay/submit.php`
and the `/pay/` catch-all routed to the existing service on port 3023.
`/pay/notify.php` separately targets LightPay's PHP handler. The existing
service also contains WeChat and Alipay notification routes, while the main
API exposes a separate WeChat notification endpoint. No PerPay listener was
observed on its default port 6190; the PerPay candidate notification routes
remain unmounted. These observations do not establish the effective callback
URL of any individual in-flight order. Preserve each order's existing handler
and authenticate its ownership before changing routing; do not infer it from
the URL alone or broadcast a notification to both systems.

On 2026-11-03, a fresh read-only SSH check found the main-site Node process
still running with PID 1879373, and `data/store.json` still had its
2026-10-23 modification timestamp. A recent PM2 log still contained the
external-modification save conflict. Neither the process nor the log check
proves which in-memory financial changes are absent from disk. Do not restart
the process, overwrite the store, or treat the file as a current snapshot.

Later on 2026-11-03, another read-only SSH check confirmed the same process
and unchanged store modification time. The last three current PM2 output
lines each reported that an external modification caused a save to be
skipped. The process was listening on ports 8787 and 8788; a request to the
root path on 8787 returned 404, which is not a health check. No signal,
restart, debugger attachment or production write was performed. This does
not determine which in-memory records differ from the file.

On 2026-11-03 a subsequent read-only loopback `/health` check reported
`persist.mode` as `json` and 25 in-memory users, while a separate read of
`store.json` counted 22 users. Both reported 0 submissions and 96,772 catalog
entries. These reads were not taken at a coordinated instant, but the user
count discrepancy is direct evidence that the file must not be assumed to
represent the live store. The deployed PostgreSQL store-KV synchronization
lists security, review, dashboard, circuit and notification keys, not the
payment object. The health result reports JSON mode; neither this inspection
nor a matching count establishes durability of any payment record. No
production data or process state was changed.

A later read-only check on 2026-11-03 again observed 25 users from `/health`
and 22 in the separate on-disk file, whose modification time was still
2026-10-23 12:54:24.990 UTC. PID 1879373 was still running; listeners were
observed on ports 8787 and 8788 but not 9229. The deployed persistence and
payment route file hashes still matched the values recorded below. These
observations are not an atomic snapshot and do not establish which payment
records are missing from disk. No signal, debugger, service restart or
production write was performed.

On 2026-11-04 another read-only check observed PID 1879373 still running,
26 users reported by `/health`, and 22 users in the separate on-disk JSON
file, whose modification timestamp remained 2026-10-23 20:54:24 CST.
These checks were not atomic and do not identify missing financial records.
The process reported 109,892 KiB of swapped pages at that instant. The public
submit endpoint returned 503, and nginx and the isolated shadow service were
active. No signal, debugger, restart or production write was performed.

On 2026-11-04 a later read-only check found scheduled store backups with
recent modification times. The latest backup had the same SHA-256 as the
unchanged on-disk `store.json`; its recent timestamp therefore does not show
that the running process's unsaved state was backed up. No backup contents or
hashes were printed, and neither file was modified by this check.

An additional read-only log inventory found the same skipped-save message in
the retained `starmc-api-out.log-20261024.gz` rotation and later rotations.
The archive filename is not an exact timestamp of the first conflict, and this
does not establish the cause of the external modification or identify lost
payment writes. The inspected payment admin endpoints cap their results and
are not a complete in-memory store export.

On 2026-11-03, read-only process inspection reported 132,440 KiB of swapped
pages for PID 1879373 and approximately 1,857 MiB of 2,047 MiB system swap in
use. The process ran as root, had no tracer, and listened on ports 8787 and
8788 at that instant. Its core-file limit was unlimited and the kernel core
pattern delegated to systemd-coredump; this does not establish whether a core
would be retained. These measurements change over time and do not measure the
pause or swap impact of an inspector capture. Swap confidentiality, coredump
policy, sufficient capacity, capture isolation and recovery custody remain
unverified. No process, swap, firewall, limits or coredump settings were
changed.

A further read-only check on 2026-11-03 identified the active swap as
`/swapfile` on the root ext4 filesystem; `lsblk` did not show a device-mapper
encryption layer on that filesystem. This does not establish whether the cloud
storage or host has encryption. `systemd-coredump.socket` was active and the
merged coredump configuration contained no explicit non-commented overrides;
the effective compiled defaults, retention and access controls were not
verified. No swap contents or core dumps were read and no settings changed.

Read-only inspection of deployed `src/persist.js` (SHA-256
`93d415433c16f674a3e972a0e7ebb19c313a2253ff51afa9871861a01d818afb`)
shows that scheduled saves skip when the file mtime is later than the loaded
mtime and clear `dirty` on that path; synchronous flush also skips. This is
not a merge or a durable save. The process start and current file timestamps
are approximately one second apart, but do not establish exactly when the
process loaded the file or what changed. The local persistence candidate has
14 passing conflict tests, including preserving pending state and rejecting
conflicting backups. It is not deployed and cannot recover already-unsaved
production state. Preserve and independently verify the live state first.

On 2026-11-03, the local persistence candidate's complete 17-test conflict
suite passed under the server's Node 22.23.2 binary in a local, network-disabled
Linux container with a read-only workspace and temporary storage. This includes
the two POSIX permission checks skipped on Windows. It does not establish that
the candidate is deployed or that the live in-memory store can be recovered.

Read-only inspection of the deployed payment routes on 2026-11-03 also found
that the administrator merchant-ledger endpoint returns at most 500 entries,
while the merchant balance ledger and settlements endpoints return at most
200 each. These responses have no pagination in the inspected handlers.
They can help investigate individual records but cannot establish a complete
live-state export or a shared cutoff; no authenticated data was retrieved.

The synthetic live-state recovery test now joins inspector capture and resume
to the public-key encrypted archive and offline-key recovery, including wrong
key, modified ciphertext, digest mismatch and no-overwrite checks. A separate
synthetic controller-crash test passed. These tests do not isolate a production
inspector, bound production pause time, or capture production state.

The same public-key archive round trip was also exercised on 2026-11-03 with
synthetic state in a separate Windows process running a SHA-256-verified copy
of the deployed persistence module. Wrong-key, modified-ciphertext, digest,
no-overwrite and process-resume checks passed. The local copy was removed.
The fixture started with its inspector enabled; it did not attach to the
production process, demonstrate Linux production isolation, bound a production
pause, or establish an independently held production recovery key or digest.

On 2026-11-03 the deployed-module synthetic fixture also passed on the server
in a disposable Linux container, with Node 24.22.1 verified against npm package
integrity, a SHA-256-checked test bundle and deployed-module copy, no network,
read-only mounts and root filesystem, no published ports, dropped capabilities,
a non-root UID and a private PID namespace. The test signalled its own fixture
process to enable the inspector, captured and resumed synthetic state, and
checked encrypted archive recovery and rejection paths. The fixture observed
about 2.2 seconds paused; this is not a production pause bound. The container
and dedicated temporary files were removed. This does not isolate or attach to
the production process, secure a production inspector, establish independent
key and digest custody, or recover or validate production data.

The local main-site order handler rejects a retry using the same merchant
order number with a different amount, channel, notification URL or return
URL. Synthetic HTTP tests cover both merchant and EPay bridge routes, including
state remaining unchanged on conflict. This change is not deployed and does not
fix or preserve the currently running main-site process; its unpersisted state
must be recovered before any restart. Historical unmatched identifiers must
not be automatically merged because the old gateways may create independent
orders and use different provider-facing identifiers.

The isolated exact-order fixtures for Alipay and WeChat also reject signed
retries that change notification URL, return URL, name or merchant parameter.
Unsupported device modes are rejected separately. Tests check that these
failures do not add orders, payment intents, ledger entries or callback jobs.
These are synthetic candidate tests, not real provider or production tests.

The candidate callback outbox gives a GET fallback its own bounded retry
budget after the final POST receives 405 or 415. Synthetic tests cover an
expired GET lease across a database reopen, fencing the old lease, and
exhausting the GET budget. Delivery remains at-least-once: an expired request
may already have reached the merchant, so merchant-side idempotency remains
necessary. This does not validate production destinations or authorize rollout.

On 2026-11-03, a fresh server compilation and the shadow check ran locally
with synthetic records and loopback listeners. It detected the expected
account/ledger movement mismatch and rejected revoked or mismatched identity
access. The local Docker daemon was unavailable, so this run was not
network-isolated and did not use real channels, production data or a
coordinated snapshot. The script now labels the explicitly selected execution
mode; setting the container flag is not itself proof of isolation.

Later on 2026-11-03 the same synthetic server bundle was SHA-256 checked after
transfer and run on the server in a disposable `mysql:8.4` container using
Node 24.22.1 from the npm `node-linux-x64` package. Docker was invoked with
`--network none`, a read-only root and bundle, no published ports, dropped
capabilities, a non-root UID and resource limits. The synthetic identity
checks and expected balance-movement mismatch passed. The container exited
and its dedicated server-side temporary directory was removed; the running
main-site process remained present and loopback HTTP returned 200. These
checks do not establish real provider compatibility, live balances, historical
ownership, or a production-ready migration and do not authorize cutover.

On 2026-11-02 the current server build and corrected shadow check ran in a
disposable `mysql:8.4` container with `--network none`, a read-only bundle
mount, writable tmpfs, no published ports, dropped capabilities and resource
limits. Node 24.22.1 matched the distribution SHA-256 and the application
bundle matched its local transfer hash. The first attempt exposed a missing
`static/app/alipay.png` in the temporary bundle; the resource was transferred
and its hash verified before the successful run. The synthetic order, binding
mismatch and revoked-access checks passed. The container and temporary bundle
were removed. This did not test real merchant sessions, production database
contents, provider connectivity, checkout, callbacks, invoices or routing and
is not a deployable release package or authorization to cut over.

On 2026-11-02 the current server build was run locally with a synthetic
identity service, temporary database and loopback listener. The shadow check
was updated to supply the now-required `apiId` and verified that both an
identity API ID mismatch and revoked access are rejected. No production data
or provider credentials were used. This was not a network-isolated container,
production deployment, real merchant login or payment verification.

The `/pay` base-path implementation has an isolated browser test for admin
login, assets, order and notification navigation, a site-scoped order page,
and a checkout redirect. A root-path browser regression also passed. These tests
use synthetic data and do not verify EPay compatibility, provider callbacks,
the production proxy, the merchant workspace, or financial reconciliation.
Do not treat them as authorization to deploy or switch payment traffic.

## Before cutover

0. Choose and verify the public routing shape before packaging: the current PerPay build serves `/admin/`, `/api/`, `/checkout/` and `/assets/` from the origin root, and `PERPAY_PUBLIC_URL` intentionally rejects a path such as `/pay`. Either deploy it on a dedicated origin or complete and test a base-path implementation that preserves signed request paths, cookies, static assets, checkout URLs and provider callbacks. A proxy rewrite alone is not a completed migration.

1. Inventory active merchants and bindings, including the merchant with 76 unbound historical orders and the missing main-site binding. Confirm ownership from authoritative records; do not infer it from names or amounts.
2. Establish a common cutoff and an explicit process for writes and late provider callbacks during migration. Record source timestamps, snapshot hashes and the replay position. A current main-site file and an older EPay backup are not a consistent snapshot.
3. Restore backups into isolated infrastructure and verify source and migrated rows by original ID, including merchant credentials, fees, orders, balances, accounting entries, notification attempts, invoices and applications. Resolve every discrepancy before switching.
4. Validate provider-authenticated account identity, merchant order number, provider transaction ID, status and exact amount. Exercise duplicate, concurrent same-amount, replay, mismatch, refund and delayed-notification cases. An amount-only match is not enough.
5. Prove that the payment confirmation and callback outbox insert commit atomically, and that restart, lease expiry, duplicate delivery and callback retry preserve order and ledger invariants. Confirm legacy callback URL policy and acknowledge any HTTPS-only incompatibility.
6. Test merchant login and authorization, balance and fee operations, ordering, invoice flow, historic record access and callback endpoints on an isolated deployment. Keep production provider credentials and merchant destinations out of tests.
7. Verify a new database backup and restore, database and master-key compatibility, old service and configuration artifacts, ingress configuration, DNS and caches, monitoring, and named operator access. Test rollback in isolation and preserve evidence.

On 2026-11-03 at approximately 08:34 China time, the most recent scheduled
main-site backup was compared byte-for-byte with the current on-disk
`store.json` and matched. The source file had not been modified since
2026-10-23, while the running service still logged skipped saves. The deployed
backup scheduler copies that file, so the backup timestamp alone is not proof
of current in-memory data. Do not restart the service or restore either file
over newer state. A separately validated, encrypted live-state preservation
and recovery procedure is still required; this comparison did not inspect or
capture the running process's memory.

An aggregate-only read of the same stale main-site file on 2026-11-03 found
one settlement, 45 callbacks and 211 sync jobs. A subsequent isolated combined
import encrypted and verified these original records, but does not convert
them to operational models or replay callbacks and jobs. They remain reported
as unmapped business collections. Candidate schema 53 now registers the
encrypted retention tables in the application migration catalog; the preserved
records are not replayed. This is not a current
count, a coordinated snapshot, or proof of settlement or callback correctness.

The explicitly enabled candidate main-site workspace now has a paginated,
read-only historical settlements and callbacks endpoint. It rechecks the
merchant binding and key guard, requires activity import counts to match, and
returns a limited projection without callback URLs, signatures or payloads.
Synthetic tests cover pagination, disabled merchants, wrong keys and incomplete
imports. A default-disabled EPay merchant UI candidate and loopback proxy can
read the endpoint when explicitly configured. Synthetic integration tests cover
the Next proxy, PerPay identity checks, cross-merchant denial and revocation;
desktop and mobile browser fixtures cover pagination and stale-data clearing.
Browser tests use synthetic data;
neither UI nor endpoint is deployed, callbacks are not replayed, and financial
reconciliation remains unproven. The proxy and UI flags are
`PERPAY_SHADOW_ACTIVITY_ORIGIN` and `NEXT_PUBLIC_PERPAY_SHADOW_ACTIVITY`; the
PerPay historical workspace must also be explicitly enabled.

The candidate currently migrates its database to schema 54. An older binary
whose migration catalog ends before 54 refuses to open that database; switching
the binary back alone is not a rollback. Keep the old gateway and its database
separate, retain all candidate-side writes after cutover, and rehearse routing
reversal and record-by-record reconciliation before allowing production traffic.
Never restore an older database over financial records created after cutover.
The local candidate still identifies itself as rc.2; issue a distinct release
identity and verify version metadata before publishing or deploying it.

Schema 54 additionally retains a losslessly reserialized main-site payment
object as an authenticated encrypted archive in the isolated combined import.
It does not map or replay the fields in that object, prove a current snapshot,
or replace the original source backup. Synthetic tests cover reopening,
wrong-key rejection, non-JSON input and transaction rollback. The corrected
combined rehearsal checks the instance ID after reopening. On 2026-11-03,
schema 54 was rehearsed using the verified October 31 EPay backup and stale
October 23 main-site file in a network-disabled MySQL container; the encrypted
archive matched after reopening, and a wrong key was rejected. The backup hash
was unchanged and the isolated container was removed. The sources were not
coordinated or current; fees and timezone were assumed, 76 orders remain
unbound, and this does not establish financial reconciliation or cutover
readiness. No live state was captured.

On 2026-11-03, schema 53 was rehearsed against the SHA-256-verified October 31
EPay backup restored into a disposable network-disabled MySQL container and
the October 23 on-disk main-site store. The actual candidate application
reopened the isolated database successfully and checked preserved records and
key rejection. The sources contained 530 EPay orders, 211 main-site orders,
50 main ledger entries, one settlement, 45 callbacks and 211 sync jobs. The
audit still reported 76 unbound EPay orders and one missing main-site merchant;
order identifiers did not match across the two sources. The fees and timezone
were rehearsal assumptions, and the source timestamps differ. This does not
establish current state, financial reconciliation or ownership, and does not
authorize traffic cutover. The isolated container and dedicated temporary
bundle were removed.
8. Define a single authority for each order throughout the transition. Pending orders and late callbacks must remain routable to their original owner; the two gateways must never independently settle or notify the same order.
9. Define and reconcile the authoritative merchant balance across the legacy
   EPay balance and main-site ledger before enabling new payments. The current
   Alipay and WeChat confirmation candidates insert a payment ledger entry but
   do not update `epay_merchant_accounts.balance_cents`; the isolated EPay
   import populates that field from the source merchant's `money`. Do not expose
   that field as a current available balance or treat the ledger insert alone
   as proof that the merchant's combined balance changed. Establish the source
   balance semantics and opening balance, then test atomic balance updates or
   derivation, duplicate notifications, refunds, concurrent changes, and
   reconciliation before cutover.

The per-merchant candidate audit also checks main-site settlement records
against freeze, payout and unfreeze ledger entries. Missing collections,
unknown states, missing or orphaned references, wrong ownership or amounts,
and missing or duplicate postings are reported as issues. This check uses
the inspected main-site accounting rules; it does not authenticate a bank or
provider payout, establish a shared cutoff, or reconcile production data.

The isolated balance checkpoint compares each account's balance movement to
new ledger entries from a caller-supplied baseline, and detects removed or
modified baseline ledger records. It requires transactionally consistent reads
and reports new or missing merchants separately. A signed synthetic Alipay
confirmation demonstrates the current mismatch: the ledger moves while the
account balance does not. Checkpoints contain sensitive financial records and
must not be logged. This check cannot authenticate its baseline, establish an
opening balance, verify provider settlement, compare frozen balances, or decide
which source is authoritative. It must not be used alone to approve cutover.

A local recovery-envelope component now encrypts a synthetic live-state
buffer with a fresh AES key wrapped to an RSA public key. It requires an
independently supplied public-key fingerprint and expected snapshot ID; a
50 MiB synthetic test rejects the wrong private key and modified ciphertext,
wrapped key or snapshot ID. The private key need not be present where an
envelope is created. An accompanying archive component writes ciphertext to a
private directory, synchronizes the file, publishes without replacing an
existing file, and reads it back against an independently retained digest.
On 2026-11-03 a 50 MiB synthetic round trip passed in a network-disabled Linux
container with tmpfs, including rejection of shared and symlinked directories.
The bundle and changed test file were SHA-256 checked during transfer, and the
server-side temporary directory was removed. A first run revealed that trying
to rewrite an existing archive could exhaust tmpfs before detecting the
conflict; the final run passed after adding an early check while retaining the
atomic no-replace publication. These components do not capture the running
process, establish trusted archive-directory ancestors or independent digest
custody, bound an inspector pause, protect process memory from swap or crash
dumps, establish offline key custody, or verify a production restore. Windows
does not have the POSIX directory permission and fsync checks implemented here.
They have not been used on production data and do not authorize an inspector
attachment or restart.

On 2026-11-03, read-only inspection of the deployed main-site source confirmed
that `/api/user/data-export` returns only the authenticated user's selected,
sanitized data; it is not a complete store export. The deployed scheduled
backup copies the on-disk `store.json`, not the running process state. While
that file remains stale, neither mechanism is a live-state recovery snapshot.
No export, process attachment, backup restoration, or production write was
performed as part of this inspection.

The legacy merchant balance endpoint estimates the combined balance using up to
100 main-site orders and 1,000 paid EPay orders, applies the current merchant
fee rate to historical EPay payments, and subtracts invoice fees. It does not
establish historical settlement or opening balances. The isolated order-link
audit flags merchants at either window limit as possibly truncated. Counts below
the limits do not prove snapshot completeness, historical fee accuracy, or that
an order-number match represents the same payment. Resolve those facts from
complete source records and provider evidence before using a balance at cutover.

On 2026-11-03, read-only process inspection identified the service listening on
127.0.0.1:3023 as the standalone build under the `20261025-reconcile-v2`
release. Its corresponding source subtracts invoice fees for `ISSUING`,
`ISSUED`, and `UNKNOWN` applications from available balance but displays
invoice ledger entries only for `ISSUED` applications. The displayed balance
and displayed ledger can therefore differ. Source inspection does not prove
deployed bundle equivalence or any individual application status. Treat
unresolved invoice amounts as separate reconciliation items; do not create
opening postings or treat the displayed balance as independently verified.

On 2026-11-03, read-only inspection of the standalone route bundle in that
running release confirmed the same three-status subtraction and ISSUED-only
ledger filter. Its SHA-256 was
`551d34fef975564ce1a2be73cf998f712b1e44cfb2f6bb43d4db484eec2b1402`.
An isolated network-disabled MySQL restore of the verified 2026-10-31 backup
contained one PENDING invoice application with zero fee and no applications in
the three deducted states. This is historical data, not current invoice state
or evidence that current balances reconcile. The container was removed and
the original backup hash remained unchanged.

On 2026-11-03, a read-only transaction using the running EPay application's
database identity queried current `InvoiceApplication` counts and summed fees
by status. It returned one PENDING application with zero fee and no other
statuses. The account itself was not verified to be SELECT-only; the query
used `SET TRANSACTION READ ONLY` and did not mutate records. This was one
database snapshot, not a shared main-site cutoff, invoice-provider check, or
merchant-by-merchant settlement reconciliation; subsequent changes may occur.

On 2026-11-03, a read-only consistent transaction using the running EPay
application's database identity counted five EPay merchants and four bindings.
One merchant had no binding; its 76 orders consisted of 69 CLOSED, six PENDING,
and one PAID. These are current database statuses at the query time, not proof
of provider settlement, live main-site ownership, or a coordinated cutoff. The
database identity was not verified to be SELECT-only and no data was modified.
The unbound records continue to block cutover; do not assign them automatically.

The main-site refund source can be encrypted and checked in an explicitly
enabled, discarded in-memory rehearsal. It preserves original IDs, checks the
merchant binding and any order reference, and rejects duplicate or oversized
refund records within a savepoint. This is not a durable migration or refund
reconciliation: the candidate schema is outside the frozen migration catalog,
and neither provider refund evidence nor refund ledger effects are verified.
The ordinary import gates continue to reject refund-bearing source data; the
rehearsal reports `mainPaymentsVerified: false` when refunds require review.
The refund audit additionally counts manual refund records without an order ID.
The legacy administrator workflow permits them, so that count is an
investigation lead, not proof of invalidity; these records still require
independent channel evidence. Synthetic refund, ledger and isolated-import
tests passed. No current production refund data was queried for this change.
On 2026-11-03 a read-only aggregate inspection of the known-stale production
main-site disk file found zero refund records. This is not a live snapshot and
does not establish that production has no refunds or that provider refunds are
absent; live-state recovery and channel reconciliation are still required.

The isolated import report separately exposes `mainBalanceSummaryVerified`.
It is true only when a versioned main-site balance summary is present and
matches the main-site ledger; an absent summary reports false even if
`mainPaymentsVerified` is true. This checks only the supplied main-site
snapshot, not EPay balances, provider settlement, snapshot freshness, or
overall financial reconciliation.

## Switch and observation

1. Stop or quiesce new order creation according to the approved cutoff process, drain in-flight writes, then perform the final delta capture and reconciliation.
2. Enable the new gateway only after every preceding gate passes. Keep the original gateway and its state available for in-flight orders and rollback; do not delete or overwrite it.
3. Verify actual merchant authentication, static assets, order reads, callback processing, error rates, provider status and reconciliation queues. A health response or local test alone is not proof of a functioning payment.
4. Record routing changes, timestamps, checksums, verification results and the operator responsible. Stop rollout on discrepancies or inability to prove exact settlement.

## Rollback

1. Stop new order creation on the new gateway and preserve all post-cutover orders, ledger events and callback attempts. Never restore an old snapshot over newer financial data.
2. Restore the previous ingress and service configuration only after deciding how each new-gateway order and in-flight provider callback will be routed and reconciled.
3. Verify old service health and authorization, provider callbacks, job scheduling and data access. Reconcile all transactions created during the attempted cutover before reopening general traffic.
4. Retain both systems' evidence and backups. Resolve missing bindings, financial differences or ambiguous order ownership before retrying.
# Snapshot Authentication Update

New encrypted EPay snapshots include an authenticated manifest binding the snapshot ID, source name and per-table counts. Verification rejects a missing, modified or invalid manifest before comparing the snapshot with the source. Snapshots created before this change do not have a manifest and must be recaptured from an independently validated isolated restore; do not add a manifest to an unverified older snapshot. This protects integrity of the captured data but does not prove that its source is complete, the restore is current, or that the migration and financial reconciliation succeeded.

`readAuthenticatedEPaySnapshot` loads the authenticated snapshot into memory without querying MySQL, rejecting missing or duplicate primary keys and invalid row authentication. It is a migration building block, not an importer: the importer guard remains enabled, and the returned rows can contain sensitive fields and must never be logged or written as plaintext.

An isolated synthetic test closes and reopens a file-backed snapshot database,
verifies that sample merchant, channel and callback secrets are not present as
plaintext in the closed database file, and checks that an incorrect key cannot
authenticate the manifest. This is not a full forensic disk-erasure test, a
production key-recovery drill or a persistent business-data migration. Opening
the database alone does not authenticate this snapshot's encryption key; the
snapshot must be read and authenticated. The current isolated business mapping
places channel configuration and notification details in plaintext memory and
must not be persisted as-is.

## Merchant Shadow API

The isolated import now preserves each `MerchantInvoiceConfig` source row as
authenticated ciphertext bound to its original merchant ID. It verifies a
readback and rejects rows without a corresponding merchant. The original row
remains archival only: its legacy encryption key and settings have not been
restored or validated, and no invoice configuration is activated. This is not
a production schema migration, invoice-flow verification or cutover approval.

The isolated main-site ledger rehearsal now stores complete source records in
an authenticated encrypted table rather than a plaintext temporary table. It
binds ciphertext to the entry and merchant and checks the decrypted record
against mapped amounts, timestamp, type and identity. This table is not in the
application migration catalog: the current release's schema ceiling is frozen.
A new release and reviewed migration are required before persistent use. Mapped
ledger fields such as reason and actor remain plaintext, and synthetic file
tests do not establish forensic erasure, key custody or production recovery.

When a main-site payment snapshot includes its orders, the isolated import
checks paid-order postings, recorded amounts, fees and merchant IDs before
reporting `mainPaymentsVerified: true`. It preserves each original order ID
and selected searchable fields in a separate table and encrypts the complete
source record. The row is bound to the mapped merchant and verified after
decryption; it is not merged with an EPay order. An inconsistent link aborts
the rehearsal and an absent orders collection reports false. This table is
not part of the application migration catalog, and the rehearsal discards its
in-memory destination. Search fields remain plaintext. It is not a persistent
import, coordinated comparison, key custody or recovery drill, historical
provider settlement proof, or a replacement merchant interface.

A `main-orders` workspace candidate reads only that separate historical
table. It rechecks main-site authorization and merchant binding, authenticates
each encrypted source record and returns a limited projection, not raw payment
fields. The application can mount it only through an explicitly supplied
`includeMainOrders` dependency; normal startup does not set that option.
Synthetic tests cover access, tampering, pagination and application mounting.
It is not wired into the merchant dashboard and does not provide a unified
order list, payment operations, or a cross-service atomic revocation guarantee.
The historical schema and key recovery must be approved first.

An unmounted transaction-level main-order import candidate additionally
requires the database master-key guard, an empty target with no prior import,
matching main-site API bindings, versioned balance-summary agreement and
internally consistent main-site payment postings. It encrypts and reads back
each source order and records completion in the same transaction; failures
roll back to a savepoint even if the caller catches the exception. A synthetic
file-backed test closes and reopens SQLite and checks recovery, a wrong key,
rollback and repeated empty imports. It does not authenticate the supplied
snapshot, capture changes after its cutoff, import other business records,
prove forensic erasure, or authorize production use. The candidate schema is
not in the frozen application migration catalog.

The read-only merchant shadow API is disabled by default. An isolated test instance can explicitly set `PERPAY_HOST=127.0.0.1` and `PERPAY_EPAY_SHADOW_IDENTITY_ORIGIN=http://127.0.0.1:8787` to mount it; the identity service must provide the new exact-merchant access endpoint. Each request checks the main-site session and the enabled EPay binding again. The order endpoint supports bounded pagination, status and literal-text search. A separate endpoint lists limited invoice and application metadata, with independent next-page flags; it does not expose invoice email or tax ID. It does not provide balances, settlement, invoice creation or payment operations, and is not a replacement merchant workspace.

The isolated workspace and WeChat code lookup also bind each data query to the
main-site API identity returned by authorization. Tests change that identity
between authorization and reads, including between order and notification
queries, and verify that stale access does not return the affected records.
This is a local authorization check, not a cross-service atomic revocation
guarantee or evidence that the production identity endpoint is deployed.

The explicitly enabled historical shadow workspace also exposes a read-only
`combined-orders` list across retained main-site orders and EPay orders. It
keeps both source records even when merchant order numbers match, labels the
result unreconciled and does not allow payment or invoice actions. The list
checks the binding and import marker and authenticates returned main-site
records. Synthetic tests cover source separation, pagination, filters, changed
bindings, invalid keys and damaged selected records. Offset pagination may
shift while orders change, and filtered-out records are not authenticated by
that request. No dashboard, production identity, ingress or data is connected;
this list does not establish ownership, completeness or cutover readiness.

The legacy merchant dashboard candidate has a separate combined-order panel
behind `NEXT_PUBLIC_PERPAY_SHADOW_COMBINED=1` and a separately configured
loopback-only proxy via `PERPAY_SHADOW_COMBINED_ORIGIN`. The proxy validates
merchant scope, record shape and explicit unreconciled/non-deduplicated flags,
and strips extra response fields. Cross-project synthetic tests covered the
two sources, merchant denial, revoked sessions and forged response flags. A
Vite fixture with mocked HTTP responses exercised pagination, access failure,
merchant switching and document overflow at desktop and 390px viewports.
Neither flag is enabled in production; the fixture is not live identity,
payment, migration or browser acceptance, and offset pages can change as
orders arrive.

An in-process integration test now connects the actual local main-site payment
identity route, the combined-order shadow endpoint and its legacy dashboard
proxy. Synthetic owner, member and administrator sessions exercise exact
merchant access; member revocation, changed bindings and duplicate main-site
merchant IDs fail closed. The returned projection excludes the other merchant
and retained private fields. The main-site server, sessions and data are test
fixtures, not the deployed identity service or production authorization proof.

The cross-project integration test exercises the local main-site identity route against all five shadow views (orders, ledger, invoices, historical notifications and callback attempts), including invalid sessions, a different merchant, revoked membership and cross-merchant order identifiers. It uses synthetic data and does not verify the deployed identity service, ingress isolation, live roles or write permissions.

The isolated import rehearsal now encrypts each non-null channel configuration as a whole with channel-bound authenticated encryption and checks that it can be recovered. Migration 49 adds a separate table without changing earlier migration checksums. A separate unmounted migration function checks the master-key guard, encrypts legacy plaintext in one transaction, rejects mismatched existing ciphertext, and is idempotent on retry. It has only synthetic local tests; it is not invoked by migration 49 or any production route. It does not replace or enable the guarded production importer, establish channel configuration provenance, or prove that other order/log fields contain no secrets. Removing a plaintext column value does not securely erase older SQLite pages, WAL files, backups, or logs. Before enabling the gateway, inventory existing plaintext, rehearse recovery and removal under a documented retention plan, and verify master-key backup and recovery.

The shadow API also provides a read-only, per-order view of new callback queue status and attempts, separate from historical notification logs. It checks the current identity and order ownership, rejects inconsistent job ownership, and does not return destination URLs, response bodies, error details or lease tokens. An isolated process test reads fixture attempts and verifies access revocation; no merchant callback is sent. This is not a scheduler or a migrated production workspace.

The isolated ledger-entry endpoint returns paginated signed integer-cent changes for the exact currently authorized binding, together with each entry's source. It intentionally returns `reconciled: false` and does not calculate or return a balance. These entries do not replace the authoritative main-site ledger, do not prove that historical entries were migrated, and must not be displayed as an available balance. Synthetic tests cover cross-merchant denial and access revocation; production reconciliation and the actual merchant UI remain incomplete.

The process can explicitly enable historical main-site order and refund summaries
with `PERPAY_EPAY_SHADOW_MAIN_ORDERS=true` and the existing loopback-only shadow
identity configuration. It defaults off and requires the shadow identity origin.
These read-only endpoints recheck merchant authorization and mark their results
unreconciled. A loopback listener alone does not prevent an external reverse
proxy from exposing it; deployment must also restrict proxy routing. This is an
isolated inspection feature, not approval to expose production history or cut over.

The orders endpoint supports an explicit `format=legacy` projection for isolated
compatibility testing, with decimal strings, dashboard status names and page
metadata. It only includes EPay orders, marks the scope as `epay_only`, and
disables invoice actions; it neither merges main-site orders nor supplies a
balance, settlement or invoice workflow. No existing dashboard is wired to
this projection and it must not replace the production orders endpoint until
the complete workspace and financial data are reconciled.

The legacy workspace repository contains a shadow-order client.
It accepts only loopback HTTP origins, forwards the fixture session, rejects
unexpected merchant identities, invoice capabilities and pagination metadata,
and returns only an allowlist of fields. A default-disabled proxy route and
separate, feature-flagged read-only candidate section are now present in the
local dashboard. An isolated integration test exercises the main-site identity
route, PerPay workspace and proxy using synthetic data, including pagination,
search, cross-merchant denial and membership revocation. A separate browser
fixture checks rendering and clearing after denial. These tests do not prove
the complete deployed browser-to-database path or production ingress isolation.
The view does not merge main-site records, enable invoicing or authorize passing
production sessions to a shadow process.

Loopback binding does not prevent an existing reverse proxy from exposing an endpoint. Do not route production traffic to the shadow instance or use production session cookies in tests. Use isolated data and identity fixtures, verify ingress isolation separately, and complete the other gates before cutover. The main-site endpoint exists only in the local source candidate and has not been deployed or verified against the currently running main-site version.

The process-level automated test starts `src/main.ts` with a fresh temporary database, a mock identity server and loopback ports, checks an order and immediate revocation, then terminates the child process and removes the test database. It validates startup wiring, not production ingress isolation, live identity, payment, or migration completeness.

## Confirmation Prototype

An unmounted isolated dispatcher now routes `mapi.php` requests by payment
type to injected WeChat or Alipay adapters and keeps their notification paths
separate. It rejects ambiguous parameters and sets `Cache-Control: no-store`.
Synthetic channel tests exercise the dispatcher with signed notifications and
duplicate delivery. This is not mounted by application startup, does not
provide `submit.php`, native PerPay order mapping, production balance
reconciliation, provider interoperability, or production ingress isolation.
Do not route live payments to it.

An unmounted isolated HTTP route now passes authenticated EPay requests to the
transactional exact-WeChat intent creator. It returns HTTP 202 with explicit
`isolated: true` and `payable: false`; a repeated identical request retains its
original trade number. Synthetic tests exercise the route, invalid signatures,
duplicate parameters and same-amount intent confirmation. This route neither
contacts a provider nor creates a native PerPay payment order, and it must not
be mounted on a public or production ingress. Its generic errors are not an
operational payment API, and successful intent creation is not payment.

A separate unmounted isolated `mapi.php` adapter joins the same authenticated
intent to the fenced Native submission client and returns its encrypted and
verified QR result to the authenticated requester. The synthetic integration
test covers concurrent duplicate requests, uncertain network outcomes, signed
notification replay, and the atomic order, ledger and callback result. It uses
mock provider transport, not the production provider. It supports only WeChat
Native, not the existing full EPay contract, and the separate compatibility
ledger has not been reconciled with the main-site balance. No public checkout
or production routes are enabled by this adapter.

Migration 43 adds an explicit one-to-one EPay merchant to PerPay site binding.
An unrouted validator reads that binding, checks that the merchant and site are
enabled, decrypts the merchant's current signing key, and validates the EPay
request. It neither provisions bindings nor creates orders or contacts a
payment provider. The immutable mapping is a prototype: authorization, audit,
reviewed correction and migration procedures still need implementation.
An unrouted synchronous transaction helper now checks merchant, key, binding
and site policy in the same SQLite write transaction as its caller's database
operation, with tests for rollback. It is not integrated with PerPay's actual
order service or channel intent creation; callers must not perform external or
asynchronous side effects inside it. Do not infer bindings from IDs or enable
this as a production route.

Migration 41 adds immutable Alipay order-intent and confirmation records. The non-routed confirmation function verifies signatures against the intent's account, seller, public key and exact amount, then commits the order update, a separate `perpay_epay` ledger entry and callback job in one SQLite transaction. A unique provider transaction number rejects reuse. Tests exercise mismatches, duplicate notifications and rollback when callback enqueue fails.

No production intent-creation path, provider callback route or callback scheduler is connected. A deliberately unmounted Alipay callback handler checks bounded form input and duplicate fields and calls the confirmation transaction; synthetic tests cover signature tampering and duplicate delivery. Migration 44 adds an isolated WeChat confirmation prototype with an encrypted per-intent API v3 key and authenticated provider identity, exact amount, transaction uniqueness, ledger and callback enqueue in the same transaction. An unmounted unified-notification function can derive the lookup ID only after verifying and decrypting against a bounded set of caller-supplied trusted credentials; it rejects ambiguous matches and revalidates against the stored intent inside the confirmation transaction. The trusted credential source, route, credential and certificate rotation, provider acknowledgements, trusted intent creation, refund and late-payment behavior remain unresolved. Neither prototype changes the legacy merchant balance; that value and the main-site ledger have not been reconciled into a single authority. Intent fees and channel identities must be securely captured from actual order creation. Do not enable these prototypes or apply their schemas to production as a substitute for the cutover gates.

Migration 45 adds an isolated, immutable WeChat credential registry with encrypted API v3 keys, explicit validity windows, and append-only revocation records. The stored-credential confirmation prototype loads a bounded set by serial and checks revocation in the same write transaction as confirmation. It re-reads the matched registered credential, requires its app and provider merchant to equal the immutable order intent, and verifies the notification and exact amount again before committing. A synthetic test confirms an existing intent with a rotated platform key and API v3 key and rejects a different provider merchant without writing accounting or callback records. Registration checks the initialized database master-key guard. An administrator-only management API is mounted only with the explicitly enabled shadow workspace, requires same-origin and CSRF checks for writes, derives the actor from the session, rejects demo-mode writes, and never returns keys. This does not establish the authenticity of configured platform keys, provide a management UI, or automate certificate renewal. Real provider interoperability, certificate expiry, delayed notifications, recovery, operational revocation and overlapping-key scenarios remain unverified and must be validated before enabling any route.

For an X.509 certificate, isolated registration additionally requires the supplied serial to equal the certificate serial and its configured validity window to be contained within the certificate's validity interval. Public-key inputs have no certificate serial or validity to check. These checks do not validate a certificate's origin, chain, or relationship to the provider account; operators still need an authenticated provider-key acquisition and rotation procedure. The test certificate is self-signed and is strictly a synthetic fixture.

Migration 46 adds an isolated immutable site-to-WeChat account binding and a request fingerprint record. An unmounted synchronous creation function authenticates the EPay request and site binding, selects an active registered credential only for the bound provider identity, freezes the merchant fee and encrypted channel intent, and inserts the EPay order and intent in one transaction. A synthetic end-to-end test creates two equal-amount orders, checks retry and conflicting requests, rejects a different provider identity, verifies rollback, and confirms the orders only with separate signed provider transaction IDs. This code currently accepts only the explicitly supported `wxpay` PC mode and HTTPS URLs, does not contact WeChat, does not create a native PerPay `payment_orders` row, and does not use the native amount-slot matcher. Its site bindings have no administrator provisioning or correction workflow. The local merchant fee is not yet proven equivalent to the authoritative main-site fee, and its ledger remains separate. It is not connected to public EPay routes, native order views, a real payment adapter, or production data; do not deploy or cut over on the basis of this synthetic test.

The native PerPay `payment_orders` schema requires `payable_amount_cents` to
exceed `requested_amount_cents` and requires a positive allocation offset.
The native site-order test currently demonstrates two 10000-cent requests
being assigned 10001 and 10002 cents. The isolated exact-WeChat test uses a
separate EPay intent and confirms by provider transaction identity. Both tests
passed locally on 2026-11-03, but neither proves real provider behavior.
Do not map exact-amount EPay orders through the native offset allocator or
alter an existing payable amount. A replacement must first design and test an
exact-amount native representation, provider-identified matching, durable
accounting and a reviewed schema migration without weakening existing orders.

New isolated exact WeChat intents now use 32-character UUID-derived trade
numbers. Existing intents keep their original identifiers on retry, including
older 36-character fixture identifiers. Before connecting any actual provider
submission, validate its current order-number requirements and define an
explicit reconciliation procedure for incompatible existing intents; never
rewrite an identifier or create a second payable order automatically.

Migration 47 adds an isolated submission fence for exact WeChat intents. A
reservation requires the original active merchant, site and channel identity;
there is at most one reservation per trade number. A failed or expired lease
becomes `UNCERTAIN`, not eligible for another submission. Verified payment
confirmation changes an existing fence to `SETTLED` in the same transaction as
the EPay order, separate ledger and callback queue. Integrity checks reject
inconsistent settled evidence. Tests use a real reopened temporary database,
including an outbox failure and same-amount orders.

This is not a complete WeChat request adapter, live-verified provider query, or a complete
recovery state machine. A database lease cannot recall a request already sent
by a stalled worker, and there is deliberately no automatic retry or release
from `UNCERTAIN`. Reconciliation, credential revocation while a request is in
flight, refunds and provider response verification must be designed and tested
before exposing a route or allowing real requests. The compatibility ledger
is not the main-site authoritative balance.

An unmounted native-submission client now constructs and signs the fixed
WeChat Native request using a reserved exact-order intent and an internally
configured gateway callback URL. It validates the signed response against the
active credential and records the returned QR URL encrypted under migration 50.
The submission remains `UNCERTAIN` even after receiving a QR URL; provider
payment confirmation is separate. Timeout, tampering, expired leases and
concurrent confirmation cannot make the order eligible for automatic resending.
Only injected synthetic transport has been tested. Separate, unmounted routes
now accept signed provider notifications and expose the encrypted QR URL only
to an authorized bound merchant while its order is pending and the code is
within its conservative two-hour lifetime. Tests cover tampered and duplicate
notifications, transaction rollback, cross-merchant denial and expiry. There is
no production-mounted provider notification endpoint, payer checkout, deployed scheduler,
certificate-provenance process, live interoperability test or validated
replacement workflow. Do not enable this client for production payments.

An unmounted query-response confirmation function checks an active,
unrevoked registered credential and verifies the provider signature before
matching app, channel merchant, exact order number, currency, amount and
successful transaction ID. It requires an existing submission and commits via
the same isolated confirmation, ledger and callback transaction as a signed
notification. An unmounted query client signs a GET to the fixed WeChat origin,
accepts an injected trusted transport, limits response size, and selects the
matching currently active platform credential after the response. Synthetic
tests verify request signatures, identity and amount matching, revocation,
tampering, timeouts, duplicate notification, and rollback. Neither component
handles non-success or not-found outcomes, validates live provider behavior,
or makes an uncertain submission eligible for retry. Merchant signing keys
still need a trusted encrypted store and lifecycle, and provider transport and
certificate trust need operational validation. Do not expose these functions
as endpoints accepting caller-supplied credentials or response data.

The legacy EPay notifier retries POST and, only when the last POST returns 405
or 415, tries a signed GET; it records each request separately. Migration 42
and the isolated callback processor now model the GET as a separately leased
and recorded request, using the pinned HTTPS transport. Tests cover restart,
signature, 405/415 gating and expired lease fencing. The processor is not wired
to a production scheduler, HTTPS-only targets may exclude legacy merchants,
and real merchant interoperability remains unverified. Do not enable it until
those compatibility and cutover gates are satisfied.

An independent callback scheduler prototype coalesces overlapping triggers,
limits each run and aborts and waits for its active run on stop. Synthetic
tests exercise it against the persistent queue. It is not mounted in the
application lifecycle and cannot deliver production callbacks. An isolated
merchant-key reader decrypts the current stored key using authenticated
merchant ID and version and checks its fingerprint; tests reject wrong keys,
cross-merchant ciphertext and changed fingerprints without sending a callback.
It is not wired into the application. Before wiring it, verify key rotation
against actual merchant behavior, operational health and alerts,
shutdown/restart behavior and a policy for uncertain delivery outcomes.

An unmounted isolated gateway runtime now joins that dispatcher and scheduler,
requires an explicitly injected callback transport, and starts processing only
on an explicit call. A synthetic file-backed test closes and reopens the
database between bounded runs and verifies signed callbacks resume. The caller
still owns HTTP listener shutdown, ingress isolation and transport safety;
this is not a production startup integration or proof of merchant delivery.
An isolated retry test confirms that a newly started attempt reads the current
key after a version change. An already-started request can still use the old
key; coordinate a merchant-side overlap or pause and drain deliveries before
rotation. This test does not establish live merchant compatibility or provide
an operational rotation mechanism.

An additional isolated assembly constructs both provider adapters, both
notification handlers and the callback scheduler with the same database and
master key. Synthetic Alipay and WeChat fixtures exercise signed order
creation and provider notification through this assembly; the WeChat fixture
also checks ledger posting and scheduled signed delivery. No listener is
started by the assembly. This does not supply a payer checkout, production
credentials, verified provider transport, historical migration, or deployment
and must not be used as evidence that production cutover is ready.

The isolated assembly now rejects callback URLs unless both providers use the
same HTTPS origin and gateway prefix and the paths end in `/alipay/notify` and
`/wechat/notify` respectively. This prevents common configuration mismatches,
but cannot prove that a reverse proxy routes that prefix to the new instance or
that old in-flight orders remain on the old handler. Those routing properties
must be verified separately before any cutover.

The isolated assembly now accepts signed page-mode `submit.php` requests for
the supported PC Alipay and WeChat channels and returns a locally generated QR
image with the validated item and exact amount. Synthetic tests cover both
channels, tampering, HTML escaping and the document security policy. Its
isolated status endpoint requires a short-lived order-scoped capability in a
request header and reports paid only after the same provider confirmation and
ledger checks used by the callback processor. Synthetic tests cover expiry,
tampering, merchant scope and inconsistent ledger entries; a browser fixture
checked desktop and mobile status polling. On verified payment the isolated
page can return to the original HTTPS merchant URL with EPay-signed fields;
reserved payment parameters in that URL are rejected. Synthetic tests and a
mocked browser navigation cover this path; current merchant keys are used, so
rotation overlap and merchant handling of existing URL query fields require
real interoperability checks. There is no live provider or payer verification,
production rate limiting or production mount. The isolated status route has
an in-process aggregate budget and returns 429 before order lookup. It does not
identify client addresses, coordinate multiple processes or provide metrics;
trusted ingress rate limits and operational alerting remain required. An uncertain submission still
requires reconciliation. This page is not a complete replacement checkout and
does not authorize cutover.

On 2026-11-01 this synthetic process check also passed on the server in a disposable `mysql:8.4` container with `network=none`, no published ports and a tmpfs temporary directory. Node 24.22.1 was taken from the official distribution and checked against its published SHA-256; the pinned Node Docker image itself could not be downloaded. The transferred application bundle was checked by SHA-256. The container and temporary files were removed. The existing public EPay liveness endpoint returned HTTP 200 afterward, which is not payment verification. No production sessions, database, provider credentials, ingress or routing were used or changed; this test does not establish reverse-proxy isolation for a future deployment.
The WeChat query signing-key registry and encrypted key storage are isolated code only. Provider-issued certificate provenance, real channel interoperability, key rotation and recovery remain unverified. A matching local key pair does not prove ownership. The query transport is not a production deployment or authorization to cut over.

On 2026-11-03, a read-only SSH check found the running main-site Node process
still active, system swap at 1819 of 2047 MiB used, and
`systemd-coredump.socket` active. `/var/lib/systemd/coredump` was owned by
root with mode 0755. The host's systemd 239 manual documents `Storage=external`
as the default and identifies that directory as the external dump location;
the tmpfiles configuration also specifies mode 0755. These are configuration
and documentation observations, not proof of the effective policy, dump file
permissions, actual dump contents, or underlying disk encryption. The process
was not attached, stopped, restarted, or dumped. A production memory capture
remains blocked until isolation, independent key and digest custody, swap and
core confidentiality, and a bounded pause have been verified.

The isolated merchant audit also checks each invoice application's recorded
merchant order number against its referenced EPay order, and reports missing
references separately from mismatches. Authenticated snapshots and both restore
audit scripts supply this field. Synthetic tests cover matching, missing and
mismatched values and count-only reporting. This check does not establish
invoice amounts, statuses, provider issuance, source freshness or financial
reconciliation; no production data was queried or modified for this change.

The isolated merchant audit now also reads invoice amounts as decimal strings,
reports missing or invalid amounts, and counts amounts differing from the
referenced order. The difference is an investigation lead, not proof of an
error: invoice policy, partial invoicing, status, and provider issuance have
not been verified. Authenticated reports expose counts only. Synthetic tests
and server type checking passed; the restored historical database was not
queried again for this addition. This does not establish financial reconciliation.

On 2026-11-03, two separate read-only repeatable-read transactions queried the
database configured for the online EPay service. The first found 22 invoices,
none missing an order, with a merchant mismatch, a missing or negative amount,
or an amount differing from its linked order. The second found 76 orders whose
EPay merchant had no binding: 69 CLOSED, 6 PENDING and 1 PAID. These were
aggregate queries using the application's database account in explicit read-only
transactions; they did not retrieve identifiers or alter records. They were not
a common snapshot with one another or with the main-site store, and do not prove
merchant ownership, provider payment or invoice issuance, balances, callbacks,
or financial reconciliation. In particular, these results do not authorize
production cutover.

Another production EPay read-only repeatable-read transaction on 2026-11-03
grouped invoice records by local status. It found 11 PENDING invoices, all
without an external ID or receipt path, and 11 ISSUED invoices, all with a
receipt path but no external ID. The single invoice application was PENDING
and had neither an invoice number nor URL. These are field-presence counts,
not proof that missing fields are invalid for their providers, that paths are
readable, or that the tax provider issued or failed to issue any invoice.
Do not reissue an invoice or cut over pending workflows on this evidence.
The same day's read-only checks found all 11 ISSUED receipt values start with
`/`, are not HTTP(S) URLs, and have no `.pdf` suffix or query string. A
separate host-side `lstat` check found no corresponding regular file or
symlink when interpreting any of the 11 values as an absolute filesystem
path. The values were not printed or opened. They may instead be application
URL paths or refer to files in a different root or host. The checks did not
test authenticated downloads, PDF contents, provider issuance or a consistent
snapshot across the database and filesystem. Preserve the existing handler and
identify the real receipt storage before migration or cleanup.
An additional aggregate query found that all 11 values start with
`/pay/receipt/` or `/pay/receipts/`. The current Nginx configuration routes the
`/pay/` prefix to the existing service on port 3023. No authenticated request
or receipt content was inspected, so this does not prove that the handler
exists or works. Preserve this route until its behavior and storage are verified.
The current 3023 release's app-paths manifest lists no receipt-named route.
For all 11 path values, read-only host filesystem checks also found no matching
regular file in the release public directory, its standalone public directory,
or the main-site web root after removing the `/pay/` prefix. A separate
unauthenticated HEAD request to each path directly on loopback port 3023 returned
404. Only counts and statuses were reported; paths and contents were not logged.
The filesystem and requests were not coordinated with the database snapshot.
HEAD without a session does not establish authenticated GET behavior, provider
issuance, or absence of receipts on other storage. Receipt recovery remains a
cutover gate; no invoices were reissued or records changed.
On 2026-11-03, a read-only listing of 31 `ops-config` backup tarballs and
panel ZIP archives found no archive with a top-level or nested member named
`receipt`, `receipts`, `invoice` or `invoices` as a directory or filename stem.
All 31 listings succeeded; archive contents were not extracted or inspected.
This filename-only search does not exclude renamed files, nested archives,
off-host copies or other backup locations, and does not establish issuance or
receipt availability.

An unmounted ledger balance projection now combines retained main-site ledger
entries with confirmed candidate EPay payment entries inside a single SQLite
transaction. It requires a main ledger import marker, verifies the retained
main source records for the selected bound merchant, rejects unrecognized
sources and fails closed on inconsistent confirmation or callback records.
An additional synthetic projection test mutates each mapped main ledger
amount, type, timestamp, reason and actor independently; the existing encrypted
source reader rejects every mutation before a balance is returned. This test
does not establish the authenticity or completeness of the original archive.
Synthetic WeChat tests cover exact net credit, duplicate notifications and
merchant separation. This is not a reconciled opening balance, does not prove a
common production cutoff, and does not implement refunds, settlements, manual
adjustments or the authoritative production balance. It is not mounted in the
merchant workspace and must not be used as authorization to switch traffic.
The projection additionally authenticates the retained main payment archive,
requires the bound merchant and API identity to exist there, and checks each
of that merchant's retained ledger records against the archived source. It
also rejects detected historical refund and posting inconsistencies. These
checks do not authenticate channel refund outcomes or establish that the
archive is current, complete, or taken at the EPay cutoff.
An additional synthetic import exercises a historical payment, recorded
manual refund and settlement freeze through the real ledger importer and the
projection. Available and frozen amounts match the fixture's archived balance
summary. It does not verify a provider refund, a real settlement, or the
completeness of the production ledger.

The candidate can now expose `GET /api/merchant/epay/shadow-ledger-balance`
only when `PERPAY_EPAY_SHADOW_BALANCE=true` and a loopback shadow identity
origin is configured. It rechecks the authorized binding in a consistent read
transaction and labels the result `financiallyReconciled: false`. It fails
closed above a 2 MiB archive or 2000 ledger, order or callback rows. Tests
cover disabled mounting, unauthorized and cross-merchant requests, binding
changes, invalid keys, limits and transaction cleanup. These conservative
limits are not a capacity benchmark; loopback alone does not prevent a reverse
proxy exposing the route. No production proxy, runtime or configuration was
changed. Do not enable this endpoint in production before security, resource,
identity and financial reconciliation gates are satisfied.

The legacy merchant workspace candidate now has an independently enabled
shadow balance panel and a loopback-only, size-bounded server proxy. It does
not replace the existing balance, and labels the projected numbers unreconciled.
An in-process cross-project test uses a synthetic identity response and SQLite
fixture to check authorized access, merchant isolation, an invalid session,
non-loopback origin and an upstream response falsely claiming reconciliation.
This is not an actual main-site identity session, browser acceptance, live
deployment or production reconciliation. The server-side proxy and client-side
panel each remain disabled unless separately configured.
On 2026-11-03 a local Vite fixture and system Edge were used to exercise the
panel at 1200x800 and 390x844. Merchant switching, access denial and a delayed
response crossing a merchant switch did not retain the previous displayed
balance. This browser test used mocked HTTP responses and no production session,
financial data, payment provider, deployment or proxy configuration.

## Production maintenance checkpoint (2026-11-03)

The isolated gateway now drains an in-flight callback during an orderly stop
without claiming another job. A synthetic database-backed test exercises an
acknowledged final attempt and leaves a second job pending; emergency scheduler
stop still aborts the current operation. This change is local and is not proof
of live merchant delivery, production deployment, or a bounded shutdown for a
custom transport that ignores its timeout contract.

The local shadow-enabled administrator API can read and change an EPay
merchant's fee in integer basis points. A change requires the previous fee and
update timestamp, authenticates a PerPay administrator, checks same-origin and
CSRF, and commits the fee and audit record together. Existing payment intents
retain their captured fee. Synthetic tests cover authorization, stale writes,
audit rollback and an existing intent. This does not synchronize fee changes
with the old main-site system, provide its administrator identity integration
or establish the initial fee; it is not deployed or ready for production use.
The shadow-enabled PerPay administrator API also lists EPay merchants with
cursor pagination and reads each merchant's fee-change audit history using a
descending audit-sequence cursor. These queries require a PerPay administrator
session and do not expose merchant keys. Synthetic tests cover unauthenticated
access, cursor validation, audit ordering and rollback. No main-site session
is accepted as a PerPay administrator session, and no production integration
has been added. A local candidate page lists merchants, submits a versioned
fee change and displays audit history; its navigation entry appears only when
the shadow administrator API is reachable. Browser tests at 390 and 1280 pixels
use mocked API responses, including invalid input and a concurrent-change
response. They do not verify a real administrator session or production data.

On 2026-11-04 a read-only EPay snapshot was imported into a disposable tmpfs
quarantine alongside an encrypted copy of the on-disk main payment object.
The source counts were 5 merchants, 4 bindings, 560 orders, 121 notifications,
22 invoices and 1 invoice application. The reopened target passed integrity
and archive round-trip checks. Three merchant fee candidates matched the old
main file; two used explicit zero placeholders: one EPay merchant had no main
binding and one binding pointed to a merchant absent from that file. In the
opposite direction every merchant in the old main file had a matching EPay
binding; this does not establish that the running main process has the same
merchants. No main accounting was imported. The main file was stale, the
snapshots had no shared cutoff, and neither current fees nor finance were
verified. The tmpfs data and key were discarded. Production ingress remained
in maintenance; this rehearsal does not authorize cutover.

A subsequent repeatable-read snapshot on 2026-11-04 contained 76 orders for
an EPay merchant with no main-site binding: 69 CLOSED, 6 PENDING and 1 PAID.
One order had a provider reference and one notification log belonged to these
orders. No invoice or invoice application belonged to the unbound merchant.
These are EPay-side records only: a provider reference or notification log is
not proof of payment, callback delivery, or ownership. The main-site disk file
was stale and had no coordinated cutoff. The temporary SQLite databases and
their random key were discarded after the integrity check; this was not a
recoverable backup or a financial reconciliation.

A further 2026-11-04 read-only snapshot compared the unbound orders with the
stale main-site disk file. Of the 76 orders, 75 had no EPay `apiTradeNo`; the
one with a reference had no exact match against that file's main order trade
numbers. The unbound merchant's callback URLs matched more than one candidate
main merchant, while its name had no exact candidate in that file. Transaction
number fields may have different meanings across systems, callback URLs may
be shared, and the file is not the running store. These counts therefore do
not prove a missing live order, provider payment state, or merchant ownership.
No identifiers, URLs, or credentials were printed or changed.

Later on 2026-11-04, an authenticated administrator session read the running
main-site merchant list and each merchant's ledger endpoint. The four returned
merchants had 54 ledger entries in total; no per-merchant response reached the
500-entry limit, and each available and frozen balance matched the sum of its
returned integer-cent ledger entries. Two available balances were negative.
These requests were separate, not an atomic snapshot, and the endpoints do not
provide a recoverable full store or prove channel settlement.

The main-site merchant ID and API ID pairs were independently compared by
SHA-256 digest with a read-only, repeatable-read EPay `MerchantBinding`
snapshot. All four main-site merchants matched the four EPay bindings; there
were no unmatched pairs in this observation. This supersedes the earlier
comparison against the stale main-site disk file, not the historical 76-order
unbound EPay merchant finding. The two systems were read at different times,
and neither ownership nor balances were changed by this comparison.

On 2026-11-04, the live administrator order endpoint returned 211 orders,
below its 500-row limit, with 45 nonempty provider references. A separate
read-only EPay snapshot found one nonempty provider reference among orders
belonging to merchants without a main binding. A salted SHA-256 comparison
found no exact match to the returned main-site order references. The reads
had no shared cutoff, the endpoint limit and filtering still apply, and the
two fields may represent different provider namespaces. This does not prove
ownership, settlement, or absence from other records. No production data was
modified.

A later comparison restricted the EPay side to the single locally PAID order
belonging to an unbound merchant. Its three order-reference fields had no
exact match among the returned main-site order IDs, merchant order IDs, or
provider references (211 records). The requests had no shared cutoff and
identifier semantics can differ; this is not proof of ownership, settlement,
or absence from the live store. The associated audit script now selects PAID
orders only and must not be used to describe all 76 unbound orders.

The known public EPay submit endpoints and main-site merchant order creation
endpoint return 503 during maintenance; the legacy notification routes remain
in place. The main API still listens on non-loopback interfaces and existing
background jobs may run, so these checks do not establish a complete write
freeze. The pre-maintenance EPay Nginx configuration is backed up at
`/root/epay-before-maintenance-20261103211523.conf`; removing the separate
`perpay-maintenance-main.conf` is also required when restoring normal ingress.

The isolated merchant `api.php` query now has a process-local aggregate request
budget, applied before parsing credentials or querying the database. It does not
trust forwarded address headers. All clients share this budget, so one client
can exhaust it; it is neither per-merchant brute-force protection nor a
multi-instance limit. Production ingress still requires trusted client-address
handling, distributed rate limiting, monitoring and interoperability validation.

On 2026-11-04 two locally PAID WeChat Native orders with PENDING notification
status and no notification logs were queried by signed, read-only provider
requests. Authenticated responses matched each recorded channel identity,
trade number, transaction number, CNY and exact amount; one reported SUCCESS
and one REFUND. REFUND does not establish the refund's completion or amount.
Neither local provider result contained a refund object or refund number. A
separate, uncoordinated comparison to the stale main-site disk file found no
candidate match within the bound main merchant using the examined order and
transaction identifiers. This is not evidence that the running main store
lacks those orders, ledger entries or refunds. No callback, refund, payment,
ledger update or compensation was initiated.

`perpay-shadow.service` runs a separate, empty PerPay database using a dynamic
user and a private network namespace with only loopback. On this host systemd
reported that IPAddressDeny is unsupported; do not rely on it for isolation.
The shadow service was restarted and retained its instance identity, and its
health endpoint returned 200 inside the namespace. It has no production data,
merchant identity integration, or provider connectivity and is not a cutover.

On 2026-11-04, a Playwright test exercised the built merchant administration
page against a real local PerPay HTTP server and a disposable SQLite database.
It checked an unauthenticated request and forged administrator headers were
rejected, edited a test merchant fee, verified its audit record, and confirmed
the PerPay session was rejected after logout. This supplements the mocked UI
tests; it does not verify main-site identity, production authorization,
provider payment, live balances, or migration readiness.

On 2026-11-04 an isolated Linux test captured, encrypted and reopened a
50,000,000-byte synthetic in-memory store while its fixture continued to run.
One observation measured 2,290 ms for capture and archiving and a maximum
fixture heartbeat gap of 1,749 ms. The container had no network and used a
temporary filesystem; its test data and key were discarded. The synthetic
payload and container do not represent production memory pressure, latency or
pause bounds. This test does not establish inspector isolation, swap or core
dump confidentiality, independent recovery-key custody, or a recoverable
snapshot of the running production process. Those remain prerequisites for
any production capture or restart.

On 2026-11-03, an EPay MySQL repeatable-read, read-only transaction found no
orders with `createdAt` on or after `2026-11-03 13:15:23`. That comparison
starts eight hours before the recorded 21:15:23 CST ingress change to allow for
UTC-stored timestamps. The application database identity has not been proven
SELECT-only. This is a single EPay database observation, not a coordinated
main-site snapshot, proof against backdated writes, or proof that internal
callers and already queued provider requests are stopped. Tests from the
jump host could not connect to ports 3002, 3003, 3004, 8787 or 8788; they do
not establish firewall policy or accessibility from other networks.

On 2026-11-05, the authenticated administrator session loaded the PerPay
merchant ledger. The selected merchant's 26-cent available balance matched
the candidate's read-only projection; this is not a financial reconciliation.
The administrator-adjustment section returned no records. This confirms read
access only; no financial write was attempted.

A repeatable, read-only transaction against the current candidate database
found four bound merchants and no native PerPay payment intents. For the
merchant whose visible name is `2293237813`, the main-ledger projection and the
legacy dashboard formula both returned 26 cents. All four formula comparisons
agreed, but every result remains explicitly `financiallyReconciled: false`.
The projection found 110 main-order source rows for that merchant, exceeding
the legacy dashboard's 100-row comparison window. Another bound merchant had
117 paid EPay orders with no exact main-order-number match; a second had five
paid EPay orders and no imported main orders. These are unresolved historical
associations, not proof that the payments are invalid or belong to another
merchant. The candidate balance formula includes their legacy projection, but
the PerPay balance ledger contains only 54 `main_site` entries and no
`perpay_epay` entries; the callback queue is empty. The payment-evidence audit
therefore reports 123 historical paid EPay orders without a new trusted
confirmation record. This means the new evidence model intentionally does not
treat those historical rows as channel-authenticated confirmations. The
unbound-order count remains 76, including one locally paid order.

The candidate `/readyz` endpoint returned 503 `system_not_configured`.
Read-only inspection found no initialized PerPay administrator identity and no
collection-code payload/profile. The encrypted Alipay application/provider
keys for one enabled production account could be decrypted and parsed without
printing their values, but that account is not configured for collection
without its missing collection-code payload. The main merchant workspace's
StarMC administrator session does not initialize PerPay's separate internal
administrator identity. No payment or financial state was changed.

Focused local regression coverage for combined balances, legacy-balance
projection, merchant access, workspace reads and ledger audit passed 20/20
tests against local fixtures. This does not satisfy the production data or
provider-readiness gates above.

These observations leave production cutover blocked: the candidate cannot
accept payments, the historical EPay orders are not represented by trusted
PerPay ledger postings, one merchant's legacy order window is truncated, and
there is no coordinated main-site/EPay cutoff. Keep maintenance enabled and
preserve the old callback routes until identity and collection configuration,
full source capture, per-merchant financial reconciliation, callback routing,
and recovery/rollback acceptance are complete.

## Configuration provenance recheck, 2026-11-05

After the administrator re-authenticated, the live PerPay merchant workspace
loaded the selected merchant's ledger and adjustment history. It showed the
same 26-cent available balance as the candidate projection and no adjustment
records; this remains a read-only access check, not a financial reconciliation.

The active candidate service still runs the 2026-11-05a build in maintenance.
Its local `/pay/readyz` response is 503 `system_not_configured`. A read-only
Node 24 SQLite inspection found one enabled production Alipay account, but no
stored collection payload, and zero initialized rows in `admin_identity`.
Encrypted configuration was decrypted only in memory; the four channel
records (one enabled Alipay and three disabled WeChat) contain no field whose
name indicates a collection code, QR code or payment payload. The only
collection-related key name in `epay_config_values` is `invoice_item_code`;
its value was not read or emitted.

The inspected main-site `store.json` was modified at 2026-11-05 09:43 CST. Its
`payment.channels.alipay` and `.wechat` objects contain no collection-code or
QR-code fields. This file observation is not a coordinated snapshot of the
running main-site process and does not exclude an uninspected external source.
No account, payment, ledger, callback, invoice or configuration state was
changed. Keep maintenance enabled; a trusted collection source and initialized
operator-authentication path are still absent, and the unresolved historical
financial and callback gates above still prohibit cutover.

## Backup recovery and rc.4 migration rehearsal, 2026-11-06

At 2026-11-06 08:54 CST, the active candidate's own backup runner completed
`run-once` against its running schema-58 SQLite database. It published
`perpay.sqlite3.backup-2026-11-06T00-54-02.331Z-717cca87-fd5f-402f-933d-051f9f975658.sqlite3`
with SHA-256 `49081f40b2149755c72e497aa0b72f465f8eb18c5f15fd38944933ec644979c7`,
size 6,696,960 bytes, and instance ID `a9da325a3db8432bf6c9d8f3b1f3f370`.
The service runner verified the published digest and schema. No service restart
or production database replacement was performed.

The backup was copied into a disposable, permission-restricted directory and
restored with the deployed runner's explicit state-rebuild option. Restore
verified the configured master key against the database guard and encrypted
Alipay secrets. Node 24 SQLite reported `integrity_check=ok` and 121 tables.
Read-only content fingerprints and row counts for 39 merchant, payment,
order, balance, ledger, callback and invoice tables matched between the
restored snapshot and active database with no differing table. Counts included:
5 merchant accounts, 4 bindings, 5 merchant secrets, 560 EPay orders, 54
balance-ledger entries, 4 balance openings, 4 live balances, 0 callback jobs,
0 callback attempts, 22 invoices, 1 invoice application, 211 imported main-order
sources and 54 imported main-ledger sources. This confirms the backup contents
for those PerPay tables matched the active database at comparison time. It is
not a business-level reconciliation of the source records or a coordinated
main-site/EPay cutoff.

The locally hashed rc.4 package (`5779e36be12317e204b006212a7cbfefbd24a57d6e46079fd66166faa09a117b`)
was copied to a new isolated server directory and the remote archive hash
matched. On another disposable restore, the rc.4 database module upgraded the
copy from schema 58 to schema 60. SQLite integrity remained `ok`; the merchant,
order, ledger, callback and invoice counts listed above were unchanged. The
isolated package reused the existing rc.3 verification directory's
`node_modules` through a symlink for runtime dependencies; no clean dependency
install was performed. This is migration evidence, not a clean-install or
production-deployment acceptance test. Temporary restore
directories were removed; the verified backup and isolated rc.4 package remain.

After these checks the active `perpay-candidate` process remained PID 850499.
The public health route returned 200 while `/pay/epay/readyz`, `submit.php` and
`mapi.php` each returned 503, confirming that maintenance and the payment
admission block remain in effect. Historical ownership, source-level financial
reconciliation, provider collection configuration, trusted callback handling,
merchant identity, and rollback acceptance are still unresolved. Do not switch
the production payment entry points.

## Dependency and LightPay evidence recheck, 2026-11-06

The rc.4 isolated clean-install attempt used Node 24.22.1 and npm 10.9.8.
The service account has no `/home/perpay-candidate` directory, so the retry
used a private HOME and npm cache inside the isolated package. The resulting
debug log shows repeated `ENOTFOUND` fetch failures against both
`registry.npmjs.org` and `registry.npmmirror.com`; npm then emitted
`Exit handler never called!`. DNS resolution worked from the SSH jump host,
but the target application server could not resolve those registries during
the install. No installation was retried from the jump host. The failed clean
install directory and its log were retained; do not treat the npm internal
error as evidence that the application package itself is defective.

A fresh read-only inspection found the LightPay SQLite file at
`/www/wwwroot/lightpay/data/orders.sqlite`, last modified 2026-10-05. It
contained 211 orders (19 `paid`, 192 `pending`), 19 callback-attempt rows, and
no merchant, site or merchant-ledger rows. The main-site disk store was read
through a stable file descriptor on 2026-11-06; it continued to change between
observations, so the LightPay and main-site reads are not a coordinated point
in time.

The current disk-store comparison found exact order/merchant/amount candidates
for 202 LightPay rows and nine rows with an unknown merchant and no exact main
order ID. The separate encrypted historical payment archive contained four
merchants and 211 orders, but none of those nine merchant IDs or order IDs.
For the nine unmatched rows, the LightPay records had no site ID, resolved
site merchant, merchant-ledger entry, callback attempt or provider trade
number. These are negative findings from stale/uncoordinated sources, not
proof that the orders have no owner or did not settle. Keep their identities
preserved and do not bind or credit them by inference.

Post-check routing remained in maintenance: the candidate health route
returned 200; EPay readiness, `submit.php` and `mapi.php` returned 503. An
empty GET to `/pay/notify.php` reached a handler and returned 400, which does
not prove a valid legacy callback can be authenticated and processed. The
LightPay `/pay/api/project.php` route returned 404. The active candidate
process remained PID 850499; no payment, callback, financial write, restart or
production route change was performed. Production cutover remains blocked by
historical ownership, financial reconciliation, collection configuration,
merchant identity, provider callback acceptance, clean-install and rollback
gates.
