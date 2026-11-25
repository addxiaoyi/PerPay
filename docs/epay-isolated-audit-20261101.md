# EPay isolated restore audit, 2026-11-01

On 2026-11-04 at approximately 15:00 CST, the original main-site Node process
was still running and the latest 20 output lines all reported skipped saves.
Its store file still had an October 23 modification time. The process reported
swap use and an unlimited core-file limit; these observations do not establish
which records are missing, but make restart or inspector capture unsuitable
without a reviewed preservation procedure. No process was attached or stopped.
The configured maintenance locations continued to reject new EPay submissions.
Credential-free GET requests to the legacy Alipay, WeChat and LightPay callback
paths returned HTTP 200, 405 and 400 respectively; the first two matched the
old EPay upstream responses. This confirms only routing for those requests,
not successful delivery, authentication, settlement or actual callback writes.
The local MySQL snapshot wrapper now has a non-MySQL regression test requiring
authenticated source column metadata. This test and the associated snapshot
and importer tests passed; the changed wrapper was not deployed.

On 2026-11-04, an attempt to import the separately retained live snapshot was
rejected because its authenticated manifest did not contain column metadata.
The deployed snapshot wrapper did not enable the metadata flag; the old
manifest was not modified. A new read-only, repeatable-read capture with the
flag enabled was then made directly from the active EPay database into tmpfs.
The authenticated snapshot contained 5 merchants, 4 bindings, 560 orders,
121 notification logs, 22 invoices and 1 invoice application. The candidate
transactional importer verified original identifiers, and its temporary target
passed integrity checks before and after reopening. Temporary databases and
their ephemeral key were discarded. The source connection used the running
application's database credential, not a verified least-privilege account;
the capture used a read-only transaction. The importer used zero fee rates as
explicit rehearsal assumptions. This did not migrate production data, compare
with a current main-site ledger, prove provider settlement, or authorize cutover.

On 2026-11-04 (China time), a read-only consistent-snapshot EPay query found
two PAID orders with pending notification, both on WeChat. Separate signed
WeChat order queries, verified with the configured platform key and checked
against order identity and amount, returned SUCCESS for one and REFUND for the
other. The SUCCESS transaction ID also matched the EPay record. Neither result
proves merchant callback delivery or main-site ledger state. No callback,
refund, order update or balance adjustment was performed.

Read-only queries for refund numbers derived from the legacy `RF` prefix
returned signed HTTP 404 responses for both candidates. This does not rule
out a different refund number or establish why the refunded order remains
PAID locally. A separate check found no candidate identifiers in the stale
October 23 main-store disk file's selected payment and security collections.
That file does not represent the current in-memory store. A bounded scan of
51 retained PM2 log files found no candidate identifiers; compressed files
over 4 MiB or over 8 MiB decompressed would be skipped, and only the last
4 MiB of current uncompressed logs were read. This is not a complete audit of
all systems, logs, provider records, or live account state.

On 2026-11-03, the hash-verified October 31 EPay backup was restored in a
network-disabled MySQL 8.4 container with a tmpfs database and a 512 MiB
memory limit. A binary comparison of nonempty, unpadded `apiTradeNo` values
found zero values associated with more than one EPay merchant in that backup.
The backup hash was unchanged, the temporary container was removed, and the
main API health endpoint returned HTTP 200 afterward. One earlier start failed
under the same memory cap; smaller MySQL buffer and redo settings permitted
the successful restore. This historical aggregate does not cover current
orders or the main-site store, establish provider namespaces or ownership,
or resolve the unbound orders. It is not financial reconciliation.

On 2026-11-03 the SHA-256-verified October 31 EPay backup was restored into a
disposable MySQL 8.4 container with network disabled, a tmpfs data directory,
and a 512 MiB memory limit. A read-only transaction compared each invoice
application's platform order number, merchant ID, and merchant order number
with the referenced EPay order using binary string comparisons. Of one
application, zero had a missing order, merchant mismatch, or merchant order
number mismatch. The backup hash was unchanged and the temporary container was
removed. The main-site API process remained active and its health endpoint
responded afterward. This historical backup is not a current or coordinated
snapshot, and the check does not verify invoice amounts, issuance, provider
status, current balances, or financial reconciliation.

On 2026-11-03, a live EPay aggregate ran using the active application's
database connection with a session explicitly set to read-only, verified by
`@@tx_read_only`, and a consistent-snapshot transaction. It reported 76
unbound orders: 30 closed and 4 pending Alipay, 6 closed, 1 paid and 2 pending
WeChat, and 33 closed orders of other types. No order identifiers or database
credentials were emitted, and the transaction was rolled back. This used the
application account, not a separately provisioned read-only account; it did
not query providers, identify an individual order, establish ownership, or
coordinate a snapshot with the main site. In particular, the aggregate does
not establish whether the previously observed provider-success/local-pending
order has since been resolved.

On 2026-11-03, another read-only comparison used the verified October 31 EPay
backup in a disposable network-disabled MySQL container and the current
LightPay SQLite database. Neither `tradeNo` nor `outTradeNo` of the 76 unbound
EPay orders exactly matched the `id` of any of the 211 LightPay orders. No
order or merchant identifiers were emitted. The container was removed and the
backup hash remained unchanged. These sources have different cutoffs; absence
of a match does not rule out missing history, prove ownership or settle the
provider-success/local-pending discrepancy.

On 2026-11-03, the verified October 31 EPay backup was restored to a
network-disabled disposable MySQL container and compared read-only against
the current LightPay SQLite database. One unbound EPay order had a nonempty
stored `apiTradeNo`; none of the 19 nonempty LightPay `trade_no` values matched
it byte-for-byte. No identifiers or merchant details were emitted. The
container was removed and the backup hash remained unchanged. The two sources
have different cutoffs; this does not rule out missing records, verify provider
transactions, establish ownership, or resolve the separately identified
provider-success/local-pending order.

On 2026-11-03, a real Node 22 inspector ran on a synthetic process in a
disposable network namespace with an nftables output rule allowing only UID
60000 to reach its loopback port. New root and nobody connections were denied;
the dedicated UID discovered the synthetic inspector and evaluated a harmless
fixture expression successfully. The synthetic process was still running after
the debugger client disconnected. The namespace was removed, no host test
rule or listener remained, and the existing main-site PID was still running.
This was not a memory capture, an established-connection test, a production
inspector attachment, or proof against a privileged process assuming the UID.
Production firewall interactions, cleanup on failure, key custody and pause
bounds remain unverified; this experiment does not authorize live attachment.

On 2026-11-03, another disposable network namespace applied an nftables
output rule to a synthetic loopback listener, allowing only UID 60000.
New root and nobody connections were rejected, and a process started with
UID 60000 connected successfully. A root connection opened before the rule
received no response after the rule was installed; this single timeout does
not prove every established-connection or packet path is blocked. At a later
read-only check, UID 60000 had no passwd entry and no running processes on
the host; this is not a reservation or durable identity. The host had no test
table or test listener afterward. A privileged process can assume that UID or
change firewall rules, and production rules, inspector binding, failure
cleanup, independent key custody and pause bounds remain unverified. This
experiment does not authorize attaching to the live process.

On 2026-11-03, local Node 24.22.1 ran the confirmation audit, authenticated
Alipay and WeChat callback integration, exact WeChat order, merchant access,
merchant workspace, and historical main-order workspace tests. All 16 tests
passed. The WeChat test also checks that a confirmed payment with an
inconsistent submission fence is flagged by the common confirmation audit.
These tests use synthetic data and do not validate deployed routes, actual
identity-service behavior, provider interoperability, or financial balances.

On 2026-11-03, a disposable network namespace on the production host tested
an nftables output rule against a synthetic loopback HTTP listener. The rule
allowed a root client and rejected a `nobody` client; the namespace and its
rules disappeared when the test exited. This is not inspector authentication:
the main API also runs as root, so same-UID processes, including a compromised
root service, remain able to connect. The test did not cover existing sockets,
IPv6, all network paths, production rules, or actual inspector access. It does
not authorize enabling the production inspector or capturing live state.

On 2026-11-03, the per-merchant audit ran against the same authenticated
historical EPay snapshot used by the combined import and the stale main-site
disk file. It reported one binding with no corresponding main-site merchant,
one unbound EPay merchant and 76 unbound EPay orders. Within explicit bindings,
the two source order-number sets had no direct matches; the report counted
211 main and 454 EPay orders without a direct counterpart. Those counts are
not proof that payments or merchants are missing: the sources have different
cutoffs and order-number semantics can differ. No ownership was assigned.
The first attempt failed because the MySQL initialization process briefly
answered the socket health check before the final server started. The runner
now waits for the final mysqld process as PID 1 as well as a successful ping;
the repeat completed and both temporary containers were removed. This remains
an isolated historical check, not a provider or production reconciliation.

On 2026-11-03, the historical backup was restored in a disposable MySQL 8.4
container with no network and a tmpfs data directory. The combined isolated
import preserved 530 EPay orders, 211 main-site orders, 50 ledger records,
one settlement, 45 callbacks and 211 sync jobs. Encrypted records were
verified after reopening, an incorrect key was rejected, import markers and
activity counts matched, and no historical jobs were replayed. The Node
24.22.1 runtime was installed from the npm package with npm integrity checks;
the transferred source bundle was SHA-256 checked. The isolated container and
temporary bundle were removed and the source backup hash remained unchanged.
The main-site disk file was last modified on October 23, source cutoffs were
not coordinated, and fees and timezone were assumptions. This is not a
current live-state backup, provider settlement check, financial reconciliation,
production schema migration, or authorization to switch traffic.

On 2026-11-03, a separate synthetic inspector controller was killed while its
fixture process was paused. The fixture resumed its heartbeat on both local
Node 24 and server Node 22.23.2. The temporary server test was removed and the
existing main-site process remained running. This only exercises controller
termination with a synthetic process; it does not prove a capture watchdog,
production pause bound, safe key custody, or successful recovery of live data.

On 2026-11-03, a synthetic child process on the production host ran the
verified deployed persistence module under Node 22.23.2. After the inspector
connection closed while stopped at a breakpoint, the synthetic process resumed
and its independent synthetic disk file remained unchanged. A separate
52,289,688-byte synthetic capture paused for an observed 2,364 ms. The test
package hash matched after transfer and the temporary package was removed.
This was a single synthetic run, not a maximum pause guarantee, production
inspector attachment, encryption-key custody procedure, or live snapshot.

On 2026-11-03 a local synthetic test with the deployed persistence source
hash and Node 24.22.1 found that inspector `Runtime.evaluate` cannot use a
plain dynamic import to retrieve the loaded store: Node rejected it because
the evaluation lacked a dynamic import callback. The existing breakpoint
fixture still recovered its synthetic state and resumed. This did not attach
to production, test production's Node version, bound production latency, or
provide a deployable live-state recovery procedure.

On 2026-11-03 at 00:01 CST, a read-only process-tree inspection found that
PM2's `starmc-api` PID 1879328 was an `npm start` wrapper, followed by the
`envLayering.js` launcher and Node server PID 1879373. The latter owned ports
8787 and 8788. The disk store still had the 2026-10-23 modification timestamp,
and recent output still reported rejected saves. The deployed persistence
module still matched SHA-256
`93d415433c16f674a3e972a0e7ebb19c313a2253ff51afa9871861a01d818afb`.
PIDs are transient and must be revalidated immediately before any recovery;
signaling the PM2 wrapper is not equivalent to addressing the server process.
No signal, inspector attachment, restart or memory capture was performed.

On 2026-11-02, the combined candidate importer ran against the verified
2026-10-31 EPay backup in a network-disabled MySQL 8.4 container with a tmpfs
database and SELECT-only source account. In one temporary AppDatabase
transaction it imported 530 EPay orders, 211 main-site orders, and 50
main-site ledger entries. It reopened the target, compared the encrypted
main-site records, checked integrity and rejected an incorrect key. The
source backup hash was unchanged after cleanup; the container and temporary
bundle were removed. The main-site file was last modified on 2026-10-23,
fees and timezone were assumptions, and the sources had no shared cutoff.
This is not provider settlement verification, financial reconciliation, a
current production snapshot, or permission to switch traffic.

On 2026-11-02, the isolated historical restore additionally imported 211
main-site orders and 50 ledger entries into one temporary SQLite transaction.
After closing and reopening the database it authenticated and compared every
encrypted source record and rejected a wrong key. The container and temporary
files were removed and the source backup and disk file hashes remained
unchanged. This was not a live-state snapshot, a channel settlement check, or
financial reconciliation; the source cutoffs differed and fees were assumed.

On 2026-11-02, a fresh MySQL 8.4.13 container on the jump host restored the
verified 2026-10-31 EPay backup over a private socket with networking disabled
and a tmpfs database. The current rehearsal used a SELECT-only account and
authenticated source column metadata, including the empty invoice-config table,
in the encrypted snapshot manifest. Snapshot readback, source verification,
mapped identifiers, and persistent historical main-order reopening passed.
The snapshot and temporary main-site disk copy were removed with the isolated
container. The main-site file was stale, the sources had different cutoffs, and
fees and timezone were assumptions; financial reconciliation and production
readiness remained false. Host and Docker administrators could access the
temporary data. No production route or database was changed.

## Production persistence warning

On 2026-11-02, a read-only transaction against the live EPay database returned
five merchants, four bindings, one unbound merchant and 76 unbound orders:
69 CLOSED, six PENDING and one PAID. No orders referenced a missing EPay
merchant. A separate read-only transaction found that the unbound paid order
has a recorded provider transaction ID, one associated notification log has
SUCCESS status, and there are no unbound invoice applications. These two
transactions are not coordinated with each other, the live main-site state,
or provider records; stored statuses do not prove settlement or ownership.
The existing application's account was used and has write privileges despite
the transactions being read-only. It is not a least-privilege snapshot account.
No identifiers, credentials, or financial data were printed or persisted.

On 2026-11-02, a separate read-only comparison of the live EPay unbound paid
order against the LightPay SQLite orders found no exact match for its recorded
provider transaction ID or either EPay order number. No identifiers were
printed. These sources were not captured at a coordinated cutoff, and missing
matches do not determine the order's merchant, settlement, or historical
ownership. The MySQL query used a read-only transaction with the existing
application account, which itself has write privileges.

On 2026-11-02, a direct read-only WeChat order query for the unbound paid EPay
order returned HTTP 200 and SUCCESS. The response signature verified against
the configured platform key and key identifier; the provider's order number,
channel merchant ID, app ID, transaction ID, exact amount and CNY currency
matched the stored order and channel. No credentials or transaction identifiers
were printed. This establishes a provider-confirmed payment for that channel,
not the identity of the corresponding main-site merchant, merchant callback
effect, complete settlement accounting, or a coordinated financial snapshot.
No payment, refund, or database modification was initiated by the query.

On 2026-11-02, another read-only comparison found that this paid order's
notification target was on the main-site domain under `/pay/`. Its one stored
notification record reports SUCCESS, HTTP 200 and a `success` response body.
The stale main-site disk file contained no top-level exact order or callback
field matching any of the EPay order or provider transaction IDs. This is not
a search of the live in-memory state, a coordinated snapshot, or proof of
merchant credit or ownership. No notification was sent during the check.

On 2026-11-02, the same order's notification path was checked against the
fixed test endpoint `/pay/api/test-pay/notify`; it matched, without query or
fragment. The compiled handler in the then-running reconciliation release
implements GET and POST by directly returning `success`, without ledger or
merchant-credit processing. This describes the current deployed handler, not
necessarily the handler deployed when the notification originally occurred.
The recorded success must not be used as proof of credit or ownership.

The live database's unbound paid order was created on 2026-10-24, belongs to
EPay merchant 1000, and has an out-trade number matching `TEST` followed by
digits. The current reconciliation release's compiled test-order handler
selects merchant 1000, generates that order-number pattern, and sets the test
notification path. This is strong evidence consistent with the test creation
flow, but does not prove the historical deployed handler, the payer's identity,
or the ownership of the merchant's other 75 orders. The record and provider
payment must remain preserved and must not be automatically reassigned.

On 2026-11-02, a live read-only EPay aggregation found all 76 unbound orders
use merchant 1000. Ten combine the `TEST`-digits order-number pattern with
the exact test notification URL (one PAID, three PENDING, six CLOSED). The
other 66 do not satisfy both signals: three are PENDING and 63 CLOSED. Among
those 66, 58 notification URLs each exactly matched one merchant callback in
the stale main-site disk file, with two distinct URLs and two distinct
candidate merchants; eight had no exact match. These are leads only: callback
URLs may be shared or changed, main-site memory was not captured, and the
sources were not coordinated. Do not assign any order from these matches.

For the 58 records with a unique callback candidate, a subsequent comparison
restricted to that candidate merchant found no exact main-site merchant-order
number or internal-order ID match in the stale main-site disk file. This does
not exclude other creation paths, records missing from disk, historical
binding changes, or a match in the live in-memory state. No assignments or
financial changes were made.

On 2026-11-02, a read-only exact-identifier scan for the 58 callback-candidate
orders found no matches in 126 selected local EPay PM2 and Nginx log files.
Two files above 20 MB and compressed logs were excluded; other hosts, log
formats, and records without those identifiers were not covered. A negative
match does not establish order ownership or prove that no evidence exists.
The identifiers and log contents were not printed or copied.

A subsequent low-priority streaming scan examined 54 selected large or gzip
EPay, main-site, and Nginx log files without read errors and found no exact
order-number matches for those same 58 candidates. This does not cover other
hosts, unselected archives or events without an identifier, and it does not
prove ownership. No log contents or order identifiers were printed or saved.

On 2026-11-02 at approximately 14:18 CST, a read-only SSH check through the
configured jump host found `starmc-api` online. Its `data/store.json` remained
50,863,630 bytes and last modified on 2026-10-23 at 20:54:24 CST. Each of the
last 100 sampled output-log lines contained `skipping save`. This confirms the
earlier persistence warning still applies; it does not establish which records
are absent from disk or capture a complete runtime state. No process was
signalled, restarted, or modified during this check.

A further read-only check on the same day found the Node server process had
started at 20:54:23 CST on October 23, approximately two seconds before the
current file's modification time. The deployed source compares the file's
mtime against an in-process `loadMtime` and clears `dirty` when it skips a
save. An `lsof` sample showed no process holding that file open at the instant
of the check. None of these observations identifies the writer, determines the
loaded timestamp, or excludes a short-lived write or atomic rename. Do not
alter file timestamps or restart the service to bypass the guard.

On 2026-11-02 a further read-only check found the live server process listening
on its application ports, with no inspector listener shown for that process.
The host reported Node 22.23.2 and approximately 1,468 MiB available memory.
The SHA-256 of the deployed persistence module still matched the local legacy
fixture. A local Windows/Node 24 synthetic test of that module recovered and
authenticated a roughly 52 MB fixture; it observed 967 ms paused in that one
run and confirmed the synthetic process continued. This is not a production
runtime test, an upper bound on pause or memory usage, a key-custody procedure,
or authorization to attach a debugger. No production process was signalled.

On 2026-11-02 at approximately 12:39 CST, read-only inspection found the
main-site process still online and `store.json` still last modified at
2026-10-23 20:54:24 CST. All 50 sampled recent output-log lines reported a
skipped save. The latest scheduled backup inspected, created at 12:24 CST,
had the same SHA-256 as that disk file. The health endpoint reported 25 users
while the disk file held 22. These observations show that the scheduled copy
does not preserve the current complete running state; they do not identify the
external writer, quantify payment divergence, or provide a consistent backup.
No process was signalled or restarted and no production file was changed.

On 2026-11-02, the stale main-site disk file was streamed through SSH into a
memory-only refund audit on the jump host. Its SHA-256 matched before, during,
and after the read. The file contained zero refund records and the audit found
no orphan manual-refund postings. The temporary runner was removed. This file
is not a current running-state snapshot; these counts do not verify current
refunds, provider settlement, or financial reconciliation.

On 2026-11-02, a new no-network tmpfs restore reran the private auditor using
the exact SELECT-only grants check and provider-transaction candidate logic.
The historical EPay backup and the stale main-site disk file had the same
SHA-256 values before and after the run; the streamed main file hash matched.
Within explicit merchant bindings, zero provider transaction IDs matched
(zero same-amount, mismatched-amount, or ambiguous candidates). Unbound orders
were not assigned. This does not rule out missing or different transaction IDs,
historical binding changes, or records absent from either snapshot. The two
sources have different cutoffs, so this is not financial reconciliation. The
restore container was stopped and removed; no production data was modified.

The private restore auditor now requires the exact SELECT-only account and
grant set, no active role, and `skip_networking`; an isolated MySQL 8.4.13
fixture accepted the expected grants and rejected an added INSERT grant. This
grant check was added after the historical comparison below, so that earlier
run only verified the CREATE TABLE denial, not the complete grant set. The
fixture was stopped after the check and contained no production records.

On 2026-11-02, `audit-private-restore.mjs` compared a freshly restored copy
of the 2026-10-31 EPay backup with the main-site disk file streamed directly
into process memory. The main file SHA-256 matched the streamed bytes and was
unchanged before and after; it remained the stale 2026-10-23 file. The EPay
backup hash also remained unchanged. No main-site file was written on the jump
host. The SELECT-only database account was denied CREATE TABLE. The disposable
container had no network and was removed after the audit.

The five EPay merchant records all had parseable recorded balances; this does
not establish available balances or their agreement with the main ledger.
Three of four bindings had a main merchant in the stale file; the fourth did
not, and its API ID was not found there. One EPay merchant was unbound, with
76 unbound orders. Within the bindings, the two snapshots had zero equal
merchant order numbers, 211 main-only orders and 454 EPay-only orders. These
counts are not proof of missing funds or ownership: the sources have different
cutoffs and their creation paths can differ. Financial reconciliation and
production readiness remain false.

On 2026-11-02, the 2026-10-31 EPay backup was streamed through SSH into a
disposable MySQL 8.4.13 container on the jump host, without saving the backup
to its disk. Its source SHA-256 was unchanged before and after the restore and
matched the historical value documented below. The container had no network,
a read-only root filesystem, a non-root user, dropped capabilities, and a
tmpfs database; the host and Docker administrators can still access it. Its
base was imported from an Ubuntu 24.04.5 rootfs whose SHA-256 manifest passed
verification using the host's Ubuntu archive keyring. MySQL package hashes
matched the repository index and that index's signature verified against a
key downloaded from the same HTTPS repository; the key fingerprint was not
independently authenticated. Runtime libraries came read-only from the host.

With a SELECT-only account over the private Unix socket, the Node 24.22.1
candidate captured and verified an encrypted in-memory snapshot and read all
rows back. It rejected a CREATE TABLE permission probe. Counts were 5
merchants, 4 bindings, 530 orders, 96 notifications, 22 invoices and one
invoice application across 11 InnoDB tables. The container and its tmpfs were
removed after the run; the snapshot and its ephemeral key were not retained.
This is a historical structural check, not a current consistent snapshot,
business-record migration, per-merchant financial reconciliation, provider
settlement verification, or authorization to switch production traffic.

On 2026-11-02, the configured jump host had sufficient available memory for
an isolated fixture but did not have a local MySQL 8.4 image; attempts to pull
an image timed out or had their connections reset. Official MySQL Ubuntu 24.04
8.4.13 server, client and client-plugin packages were downloaded into a
mode-0700 directory under `/dev/shm` and checked against SHA-256 values from
the HTTPS repository package index. The index signature was not independently
verified. Without installing packages or changing the host database, an
unprivileged instance using a private Unix socket, `--skip-networking`, and a
tmpfs datadir created and read an InnoDB table with synthetic data. It was
stopped after the check. This proves neither container isolation nor backup
recovery and must not be used with production data without a reviewed isolation
and credential plan. The temporary package directory remains on the jump host;
it contains only downloaded software and synthetic database data. No production
backup was transferred.

Later the same day, Node 24.22.1 was obtained from the `node-linux-x64` npm
package and its tarball matched the npm metadata integrity value; it was not
independently compared with an official Node distribution. A SHA-256-checked
copy of the current PerPay source ran `epay-mysql-integration.test.ts` against
the synthetic 11-table MySQL 8.4.13 fixture. A SELECT-only account was denied
an INSERT, and the test captured and decrypted each source row successfully.
The server used a private Unix socket with networking disabled; a temporary
loopback-only socat bridge exposed only this synthetic fixture to the test.
The server and bridge stopped after the test. The bridge caused cold-cache
`caching_sha2_password` authentication to fail because the client sees TCP
while MySQL sees a Unix socket; warming the test account through the Unix socket
allowed the test to pass. This workaround is specific to the fixture and does
not validate production authentication, access isolation for real records,
historical backups, migration, settlement or financial reconciliation.

On 2026-11-02, a read-only inspection of the deployed main-site payment route
file found no `/api/merchant/access` route. An anonymous loopback GET to that
path returned 404, while `/api/merchant/profile` returned 401. The local
candidate implements the exact-merchant access route and its isolated test
passes, but this check does not establish live authenticated authorization.
The PerPay shadow workspace therefore cannot be treated as connected to the
current production identity service. Do not restart the main-site process to
deploy it until its unpersisted state has been safely preserved and reconciled.
The local candidate's `requireUser` invokes SuperTokens verification and
`attachLocalUser`; that middleware synchronizes user/session metadata and calls
`scheduleSave` even though the merchant-access route itself only reads merchant
data. The corresponding deployed `server.js` source also contains these calls,
but source inspection alone does not prove which version is loaded in memory.
The cross-project identity test uses synthetic session middleware, not a live
SuperTokens session. Do not describe it as a write-free production identity
probe or use it as evidence that cookie refresh and revocation work live.

At 2026-11-02 09:44 CST, a read-only production resource check reported
1,438 MiB available RAM and 312 MiB free swap out of 2,047 MiB. The running
main-site Node process reported 67,668 KiB RSS; no listener on port 9229 was
observed. These are instantaneous measurements, not safe resource limits or
proof that an inspector can be activated securely. In particular, the earlier
MySQL fixture was OOM-killed; do not retry a recovery workload on this host
without an independently reviewed capacity and isolation plan. No production
process was attached to, restarted, or modified during this check.

On 2026-11-02, the deployed persistence module was copied read-only through
the jump host and matched SHA-256
`93d415433c16f674a3e972a0e7ebb19c313a2253ff51afa9871861a01d818afb`.
On local Node 24.22.1, the verified module fixture recovered 52,289,688 bytes
of synthetic in-memory state and passed its encryption and recovery checks;
the observed synthetic pause was 558 ms. The copied source was removed after
the run. The test starts a disposable process with the inspector already on;
it does not attach to production, bound production pauses, prove independent
key custody, or authorize a live snapshot or restart.

On 2026-11-02 a read-only filename search under `/home` and `/root` (depth
five for database and archive files, depth six for LightPay-related names)
found no separately named LightPay order database or SQL backup. Two EPay
resource archives under `/root` were inspected by listing member names; neither
listed a `store.json`, `orders.sqlite`, `orders.db`, LightPay-named file or SQL
dump under the checked patterns. The search was bounded and did not inspect
nested archives, renamed files, database content or off-host backups. It does
not establish historical order ownership.

At 2026-11-01 23:51 CST, a read-only check confirmed that Nginx and the
PM2-managed `starmc-api` process were online and the local API health endpoint
and public `/pay` returned HTTP 200. The API is not a systemd unit: an
inactive `systemctl` result for that name does not mean the PM2 process is
down. Its process chain had started on 2026-10-23; the store file remained
unchanged since 2026-10-23 20:54 CST, and all 100 sampled output-log lines
reported external modification and skipped saves. No process was signalled or
restarted. HTTP availability does not establish persistence or financial
correctness; the live-state preservation and reconciliation gates remain open.

On 2026-11-01, the verified historical EPay backup was restored once more in
the network-isolated tmpfs MySQL container. A SELECT-only snapshot supplied
merchant and binding identities to a separate SQLite file on `/dev/shm`; that
file used placeholder merchant account fields and an ephemeral master key.
The transaction-level main-order candidate imported 211 orders from the
stale 2026-10-23 main-site file. After closing and reopening SQLite, each
encrypted source order was authenticated and compared, and a wrong master key
was rejected. The restored EPay source still contained 530 orders; the two
sources were not at a common cutoff. No production data or route was changed,
and the temporary container and tmpfs directories were checked absent. This
checks reopen behavior, not disk durability, independent key custody, full
business-data migration, provider settlement or financial reconciliation.
The rehearsal used Node 22, outside the supported Node 24 runtime.

On 2026-11-01, a further isolated restore of the same hash-verified historical
EPay backup rehearsed the main-site order preservation candidate. The stale
main-site file contained 211 orders and 50 ledger entries; the in-memory
import checked main-site order/posting links, stored every order by its original
ID and mapped merchant, and authenticated each encrypted source record on
readback. It also mapped the 530 EPay orders separately. Fees and timezone
remained assumptions, source snapshots had different cutoffs, and both
`financiallyReconciled` and `productionReady` remained false. The source
order table was not installed into the application schema or persisted; the
temporary no-network container and transferred files were removed and checked
absent. The server's Node 22 runner is outside the supported Node 24 runtime.

On 2026-11-01, the hash-verified 2026-10-31 EPay backup was restored again
to an isolated MySQL 8.4 container with no network, a tmpfs database, and
an explicitly SELECT-only audit account. The current local TypeScript
historical rehearsal captured and authenticated all 11 source tables and
completed the in-memory mapping, including the versioned main-site balance
summary check. The inputs contained five merchants, 530 orders, 96 notification
records, 22 invoices, one invoice application, and 50 main-site ledger entries;
identifier checks passed. The main-site file was still the stale 2026-10-23
file, fees were assumed zero and timezone UTC+08:00 for the exercise. The
rehearsal reported `financiallyReconciled: false` and `productionReady: false`.
No live financial records or routing were changed. The temporary container and
transferred files were removed, and their absence was checked. The runner used
server Node 22.23.2 for this rehearsal; this does not establish compatibility
with the application's supported Node 24 release runtime.

At 2026-11-01 23:14 CST, a read-only check through the configured jump host
found `starmc-api` and Nginx online, while the main-site disk file was still
last modified on 2026-10-23 20:54:24 CST. All 300 sampled recent application
output lines reported that the file was modified externally and saving was
skipped. An independent in-memory check of that unchanged disk file found
three merchants, 50 ledger entries, no malformed or orphan ledger entries,
and version 1 cached balance summaries agreeing with ledger sums for those
merchants, with no orphan summaries. The file's metadata was unchanged during
the read. This was not a run of the TypeScript audit or an EPay restore, and
the stale file cannot establish the running process's balances, a coordinated
cutoff, data durability, or financial reconciliation. No production process
was signalled and no data was changed.

At 2026-11-01 22:53 CST, a network-isolated tmpfs MySQL restore of the
hash-verified EPay backup and the stale main-site disk file were jointly
rehearsed in an in-memory destination. A SELECT-only source account was denied
CREATE TABLE; all 11 source tables were InnoDB and their encrypted snapshot was
verified. The rehearsal mapped 530 EPay orders, 96 notification logs, 22
invoices, one invoice application and 50 main-site ledger entries. It checked
identifiers and mapped ledger totals. EPay merchant fees were assumed zero and
the source timezone assumed UTC+08:00 solely for this structural exercise.
The source files have different cutoffs, the main file is stale, source-only
session/configuration records are not migrated, and financial reconciliation
remains false. The temporary container and transferred code were removed.

At 2026-11-01 22:43 CST, the hash-verified EPay backup was restored to a
network-isolated MySQL container with a tmpfs data directory. A read-only
comparison against the stale 2026-10-23 main-site disk file found all three
main-site merchant IDs and API IDs matched exactly one of four EPay bindings.
The main-site file contained 50 ledger entries; the aggregate shape check found
no malformed required fields, invalid timestamps, missing merchants or
unsupported fee precision. These snapshots have different cutoffs and the
main-site disk file is known to be stale: this is neither a live-state backup
nor financial reconciliation. The container and temporary script were removed.

At 2026-11-01, a disposable server-side child using the hash-verified deployed
module and synthetic state was started without an active inspector, then sent
SIGUSR1. The loopback inspector recovered 52,289,688 synthetic bytes; the
observed pause was 1,737 ms. Encryption recovery, wrong-key and tamper checks
passed. After invoking Node's internal `process._debugEnd()` in that child, its
inspector port stopped responding and its event loop continued. The temporary
test directory was removed. This internal API and one fixture do not establish
production-safe attach, inspector isolation, pause bounds, key custody or
recovery; no production process was inspected or signalled.

At 2026-11-01 21:29 CST, a read-only SSH check through the configured jump
host confirmed the main-site Node process and Nginx were running. The store
file remained last modified at 2026-10-23 20:54:24 CST, and all 200 sampled
lines at the end of the current main-site output log reported an external-file
conflict and skipped save. The deployed persistence module SHA-256 remained
`93d415433c16f674a3e972a0e7ebb19c313a2253ff51afa9871861a01d818afb`.
This check did not capture process memory, reconcile financial records, or
change the service; it does not establish which writes are missing.

A later local test used a disposable ES module with a synthetic store and a
timer structured like the legacy conflict branch. A debugger captured the
module-scoped store while the timer was paused, and the child resumed after
debugger disconnection without changing its separate synthetic disk file.
The test does not run the deployed module, test an attach to an existing
process, preserve a production snapshot, bound production pause time, or
establish inspector access control. It does not authorize a production attach.

At 2026-11-01 a separate local test used a read-only copy of the deployed
`persist.js` with the SHA-256 shown below and a stub configuration. It loaded
synthetic disk state, created a synthetic conflicting in-memory state of
52,289,688 serialized bytes, and recovered that state from the conflict branch.
The test resumed its child process, authenticated and recovered an encrypted
temporary copy, and rejected a wrong key and modified ciphertext. The measured
pause was 938 ms on this local run; it is not a production latency bound. The
inspector was started with the synthetic process, not attached to the running
production process. This does not test production inspector activation,
authentication, encryption-key custody, capacity, safe cleanup or restoration.
The source copy contains application code, not production store data.

At 2026-11-01 19:39 CST, read-only inspection found the running main-site
process had started on 2026-10-23 and its configured `data/store.json` had
last changed on 2026-10-23 20:54:24 CST. The current application output log
contained 16,740 `modified externally, skipping save` messages at the first
check; the last 500 lines at the subsequent check all contained this message.
The deployed persistence code clears the dirty flag when this check rejects a
save. This is evidence of rejected save attempts, not proof of which business
changes are absent from disk or whether any secondary store retained them.
Do not restart, overwrite the file, or assume the periodic file backups capture
current process memory. Preserve and reconcile the running state using a
reviewed procedure before recovery. All comparisons in this report that use
the file as a current main-site snapshot are potentially stale and cannot
authorize migration or cutover.

On 2026-11-01, the running process's existing health
endpoint reported 25 users, while the persisted file contained 22. Both
reported zero submissions and 96,772 catalog entries; matching counts do not
prove matching contents. The process reported persistence mode `json`. This
confirms divergence for user counts but does not establish payment-record
differences or preserve the live state. The health endpoint also performs its
normal external service health probes.

On 2026-11-01 a separate synthetic Node process on the server was tested with
approximately 52 MB of generated data and a loopback-only inspector. Capturing
its state paused that synthetic process for an observed 1,603 ms; the test also
observed its event loop advancing after debugger disconnection. The test never
attached to the live application and its temporary test file was removed. This
single measurement does not bound production pause time, establish safe
authentication or isolation for a production inspector, or provide encrypted
storage and recovery of sensitive state. It does not authorize attaching to
the production process.

The local main-site persistence candidate was also corrected in the shared
workspace: an external-file conflict now keeps the in-memory state marked
dirty, exposes `saveConflict` in the persistence snapshot, and makes an
explicit flush fail instead of silently clearing the pending write. A synthetic
conflict test and the related merchant/sync tests passed on 2026-11-01. This
candidate has not been published or deployed to production; the live service
still requires a controlled release and verification.

On 2026-11-01, the local persistence candidate hash was
`6fb69fc4434e3f451ef54a132936550f5afb4806f0c0becc4648423c84ed48b3`, while
the deployed `/www/wwwroot/starmc-api/src/persist.js` hash was
`93d415433c16f674a3e972a0e7ebb19c313a2253ff51afa9871861a01d818afb`; the
remote file did not contain `saveConflict`. A three-second read-only check saw
the application output log grow by one line, with all 100 sampled recent lines
being external-modification skips. The production fix is therefore not live.

Follow-up read-only inspection found the 2026-11-01 19:24 CST periodic backup
has the same SHA-256 as the old store file. The 2026-10-24 rotated output log
already contains 5,221 skip messages; log rotation dates do not establish the
exact first occurrence. The deployed save path returns before both file writing
and its optional PostgreSQL flush when it detects a newer file. The inspected
PostgreSQL key-value mapping does not include payment data; this does not prove
whether another component separately persisted any particular payment record.
The live process remains running. No memory snapshot or recovery has been made.

Inspection of the deployed payment routes found administrator-only GET
endpoints for merchant lists, orders, per-merchant ledger and callbacks. The
orders, ledger and callbacks endpoints return at most 500 records and are not
a complete export or an atomic snapshot. On 2026-11-01 the existing browser
tab displayed cached merchant information, but refreshing prompted a token
refresh; its displayed data was not accepted as current evidence. An authorized
working session and a complete preservation method remain necessary.

On 2026-11-01 a separate synthetic fixture was checked on the server in a disposable `mysql:8.4` container using `--network none`, no published ports and a tmpfs database directory. Node 24.22.1 and the transferred test bundle were checked against their SHA-256 values. The fixture had one row in each of 11 tables; its SELECT-only account was denied an insert, and every decrypted snapshot row matched its source. The container and the dedicated transfer directory were removed. This check used no production data and does not replace the historical restore integration test, import verification, or financial reconciliation.

This is an investigation result, not a migration approval or a financial reconciliation.

- A further signed read-only Alipay query on 2026-11-02 showed that the three `40004` responses each contained the signed sub-code `ACQ.TRADE_NOT_EXIST` when queried with the current configured channel account and order number. The fourth response did not return that sub-code. These responses do not establish that the historical orders were created under the currently configured provider account, do not establish merchant ownership, and do not authorize closing, deleting or reassigning records. No local data was changed.

- A separate read-only comparison of the six unbound PENDING orders with their current channel rows found no channel `updatedAt` later than its order `createdAt`. These application timestamps are only weak evidence: they do not establish credential history, prevent untracked configuration changes, or prove which provider account processed a historical request.

- A repeat read-only Alipay query on 2026-11-02 classified the earlier three unverified results: all three responses passed signature verification over the original response object and returned business response code `40004`, rather than a successful order response with verified order number and amount. The fourth again passed signature, order and amount checks with WAIT_BUYER_PAY. No sub-code or complete provider-account identity was established; `40004` alone is not proof of non-payment. No order, ledger, balance or callback was changed.

- A subsequent aggregate-only comparison checked both unbound PENDING WeChat orders against the current EPay notification table and the potentially stale main-site disk store. Both had the TEST-plus-digits external-order pattern and exact test notification endpoint; neither had an EPay notification log or an exact match in the examined main-site order ID, merchant order ID or trade number fields. These are shared characteristics of both orders, not proof of which person paid, merchant ownership, absence from the live process, or whether a credit is required. The live WeChat query established that one is paid despite its local PENDING state; do not ignore it as a test or settle it automatically.

- On 2026-11-02, four unbound EPay orders locally marked PENDING and using Alipay were queried using the configured official gateway with signed `alipay.trade.query` requests. One HTTP 200 response passed verification of the signature over the original response object bytes and matched the queried order number and exact amount; its status was WAIT_BUYER_PAY. The other three could not be validated under these checks and remain unknown, not unpaid. This observation does not establish the original merchant, complete provider account identity, historical ledger effects or callback delivery. No order, balance, ledger or callback was changed.

- On 2026-11-02, two currently unbound EPay orders locally marked PENDING and using the WeChat v3 channel were individually queried by out-trade number using signed read-only GET requests. For both HTTP 200 responses, the platform signature, timestamp, key identifier, configured channel merchant and app identity, order number, CNY and exact amount were checked. One authenticated response reported SUCCESS with a provider transaction identifier and the other reported NOTPAY. Only aggregate results were retained. This is a live reconciliation discrepancy: the successful provider state does not establish the original merchant, any main-site posting or callback delivery. No order status, ledger, merchant balance or callback was modified; do not switch traffic or automatically compensate on this evidence alone.

- On 2026-11-02 the main API's active Node child had no `DATABASE_URL` in its startup environment. The deployed launcher injects its generated environment before spawning that child, and deployed config selects JSON-only persistence when `DATABASE_URL` is absent. This rules out assuming a configured PostgreSQL persistence copy from that startup configuration; it does not prove that no independent database exists elsewhere. The child was serving application ports and no inspector port was observed for that PID. This inspection did not activate the inspector or capture process memory and does not establish a safe pause bound, inspector isolation, key custody or recovery procedure.

- On 2026-11-02 a fresh read-only check found that the earliest and latest retained scheduled main-site backups and the current disk store had identical SHA-256 hashes. Their timestamps therefore do not demonstrate that recent in-memory changes were saved. The most recent 20 output lines still reported skipped writes. A separate consistent, read-only EPay transaction found 76 unbound orders: 69 CLOSED, 6 PENDING and 1 PAID. These checks do not establish ownership, recover process memory, or provide a coordinated cross-system snapshot.

- On 2026-11-02 a read-only, consistent MySQL transaction inspected the callback URL query keys of 550 current EPay orders. None used a reserved signed payment field; no invalid URLs were observed. This checks only URL parsing and field-name collisions, not DNS, reachability, delivery, acknowledgements or future orders. No callback was sent. At the same check the historical backup hash still matched the value below; no designated isolated audit container was running. The latest 40 main-site output lines still reported external modification and skipped persistence, so the on-disk main-site file remains unsuitable as an assumed current snapshot.

- The 2026-10-31 EPay backup SHA-256 matched the previously recorded value before restore.
- The restore ran in a disposable MySQL 8.4 container with `--network none` and a tmpfs data directory. The container was removed after the check.
- The EPay backup and the read-only main-site store file are from different points in time. The main-site read is not a transactional snapshot coordinated with EPay.
- The isolated backup contained 5 merchants, 4 bindings, 530 orders, 22 invoices and 1 invoice application.
- Three of four bindings referenced a merchant in the main-site store read. One did not; its EPay merchant had 48 orders, 5 marked paid.
- A further read-only comparison found no current main-site merchant with the missing binding's `mainApiId`, and no conflicting API IDs among the bindings that were checked. This does not establish who owned the missing merchant or prove the separate unbound merchant belongs to it.
- One EPay merchant was unbound, accounting for 76 orders. These are investigation findings, not proof of corruption or a license to delete records.
- A second read-only restore inspection found that the unbound merchant was enabled in the backup and its 76 orders comprised 69 CLOSED, 6 PENDING and 1 PAID. One notification-log row belonged to those orders, and no invoice applications did. Statuses are as of the backup, not current provider or production status. The identity and ownership of the unbound merchant are still unresolved.
- A subsequent isolated restore of the same SHA-256-verified backup compared exact HTTPS callback URLs from the unbound merchant's orders with callbacks on current main-site merchants and orders. The 76 orders contained four distinct usable callback URLs, and their combined matches pointed to multiple current main-site merchants, not one unique candidate. The script outputs aggregate counts only; shared callbacks do not prove ownership, and the restored backup and live main-site file are not a coordinated snapshot. The isolated container and temporary transferred files were removed; no bindings or financial data were changed.
- A further isolated restore compared the unbound legacy merchant name exactly against current main-site merchant usernames and display names. It found no exact name match and consequently no overlap between name and callback candidates. This result is not evidence that no owner exists: names can change, and the data sources have different cutoffs. The audit used the server's Node 22 runtime for this read-only report, not a supported PerPay runtime validation. The container and transferred files were removed.
- Another isolated restore compared the full legacy `apiTradeNo` against current main-site order `tradeNo`, without printing identifiers or assigning owners. Of the 76 unbound orders, 75 had no usable recorded transaction ID and one had an ID with no exact main-site match. This compares uncoordinated snapshots and neither verifies provider settlement nor rules out missing historical records. The audit ran with server Node 22 for reporting only; its network-isolated MySQL container and transferred files were removed.
- No invoice ownership or missing-order issue was reported by the implemented checker for these inputs. The checker does not prove that invoice amounts, ledger entries, callbacks, or financial balances reconcile.
- A subsequent read-only order-link audit compared the same EPay backup with a separately read current main-site store. Within explicit bindings, it found 0 identical merchant order numbers, 211 main-site orders without an EPay match and 454 EPay orders without a main-site match. The other 76 EPay orders belonged to an unbound merchant. These counts include records from different cutoff times and are not proof that money or orders are missing; investigate order creation paths and historical bindings before drawing ownership conclusions.
- The restore used an isolated, disposable MySQL container and the checked backup; it did not import data into PerPay or alter production financial data. The temporary MySQL initialization server can briefly answer health checks before restarting; wait for the final server readiness log before importing.
- Source inspection shows that the main site's Alipay projection sends its internal `order.id` to the configured `project.php` bridge, not `merchantOrderId`; its native WeChat path instead uses a separate `wechatOutTradeNo`. EPay's `submit.php` and `mapi.php` store their caller's `out_trade_no` as `outTradeNo`. These paths do not establish that the configured bridge writes to the EPay database, nor that a bridge order is an EPay order.
- A further isolated audit checked the speculative equality of main-site internal order ID and EPay `outTradeNo`, restricted to each explicit merchant binding. It found zero candidates (including zero amount mismatches or ambiguous candidates). This does not rule out other links, historical bindings or differing snapshot times and must not be used to assign ownership.
- Read-only inspection located the bridge at `/www/wwwroot/lightpay/api/project.php`; it stores orders separately in LightPay SQLite, keyed by the main-site internal order ID. In separately read current LightPay and main-site data, 202 of 211 LightPay orders matched a main order by ID, merchant ID and exact amount; 9 had neither a current main order nor a current main merchant. These are identity candidates, not proof of provider settlement or callback success.
- Comparing those 9 with the four main merchant IDs in the restored EPay binding snapshot found no matching binding. The three datasets do not share a cutoff; retain the records and investigate historical backups and authorized identity evidence rather than assigning an owner automatically.
- The inspected `project.php` checks the amount when an order ID already exists, but does not compare the supplied merchant ID against the stored merchant ID. The bridge is authenticated, but this is still a cross-merchant integrity risk if an internal caller reuses an ID incorrectly. Do not deploy a patch based on the stale local bridge copy; verify the running source and test idempotency and ownership before changing production.
- A candidate patch copied from the then-current production bridge checks the stored merchant ID before allowing an existing order to be reused, and rejects missing or mismatched ownership. An isolated PHP integration test using a temporary SQLite database and a mocked payment provider covered same-merchant retry, cross-merchant rejection, amount mismatch, and preservation of the stored row. The candidate has not been deployed; recompare the live source and run release and rollback checks before any deployment.
- A read-only historical comparison targeted the nine LightPay records missing both a current main-site merchant and order. Of six `store.json.*` files inspected, five lacked the required payment arrays; the one usable historical snapshot contained neither their merchant IDs nor their order IDs. This is not an exhaustive search of all backups and does not establish ownership.
- Further filename searches in `/www/backup` found no standalone `store.json` or `orders.sqlite` backup; three sampled operations-config archives contained no matching data-file paths. Other archives or off-host backups have not been exhaustively inspected.
- A subsequent read-only inventory listed all 16 then-present `/www/backup/ops-config/*/backup.tar.gz` archives successfully and found no members named `store.json*` or `orders.sqlite*`. This checks member names only; it does not rule out renamed, nested or off-host backups.
- A later read-only inventory on 2026-11-01 listed the central directories of all 15 `/www/backup/panel/*.zip` files; none contained members whose basename matched `store.json*` or `orders.sqlite*`. A separate filename search under `/www/wwwroot` to depth seven found the current LightPay database, the current main-site store and the six previously examined store snapshots. These filename checks do not inspect archive contents, nested archives, renamed files, off-host backups or database settlement records, and do not establish ownership.
- A separate read-only comparison of the current main-site store and LightPay SQLite again found nine records with neither a current order nor a current merchant. Their two distinct stored merchant identifiers have lengths 4 and 1, so arbitrary substring matches in logs are not meaningful. Of 30 readable `starmc-api` PM2 logs, none contained the nine order IDs; a second scan found neither merchant identifier in a labeled `merchant_id`, `merchantId` or `pid` field. The live store, SQLite file and logs were not captured at a coordinated cutoff, and these limited log searches neither prove ownership nor exclude other log formats, rotated or off-host records. Do not assign these orders from short identifiers or incidental text matches.
- A further read-only comparison on 2026-11-01 examined LightPay site references, merchant ledger entries, callback attempts and saved provider transaction numbers for those nine records. None had a site reference, linked merchant ledger entry, callback attempt or nonempty stored provider transaction number. The script outputs aggregate counts only and its temporary server-side copy was removed. The two sources were not captured at a coordinated cutoff, and absent local associations do not prove that an order was unpaid or establish its owner.
- At the time of a later routing check, active Nginx configuration did not contain the historical exact `/pay/api/project.php` location; anonymous GET and a credential-free empty POST to that path returned 404. The checked main-site route code defaults to this path, and no nonempty override was present in its process environment. This indicates a possible projection outage but is not a valid-payment test or proof of a particular order's status. See `lightpay-bridge-release-gate.md` before taking action.
- Following the authenticated-manifest change, the verified 2026-10-31 backup was restored again into a disposable MySQL 8.4 container with no external network. An isolated account successfully read the source and was explicitly denied `CREATE TABLE`; the real MySQL driver then captured and compared all 11 tables in an in-memory SQLite snapshot and verified the authenticated manifest. The container was removed. This was snapshot verification only, not an import, production backup, ownership determination or financial reconciliation.
- A later structural rehearsal used a fresh restore of the same backup and a private, discarded in-memory SQLite destination. It verified imported identifiers for merchants, bindings, payment types, channels, orders, notifications and invoices. All merchant fee rates were deliberately set to zero and the source timezone to UTC+08:00 as test assumptions, not established historical values. Sessions remain in the encrypted source snapshot rather than the destination. Null, empty and nonempty configuration values are treated separately. This was not a persistent migration or financial reconciliation.
- A further fresh restore reran the rehearsal after adding row-level checks for merchant balance amounts, the three order amount fields, and invoice amount and service fee. The checks compared source decimal values to target integer cents; they do not validate the financial meaning of those fields, the main-site ledger, provider settlement, or invoice-application fees.
- The EPay merchant balance endpoint is a display projection, not an immutable ledger: it fetches only the first 100 main-site orders and at most 1,000 paid EPay orders, deduplicates by merchant order number, and calculates historical net values using the current merchant fee rate. It subtracts invoice applications in ISSUING, ISSUED and UNKNOWN states, while its displayed invoice ledger contains only ISSUED entries. A migration must not use this projection as a complete authoritative balance or derive historical fee postings from today's rate.
- On 2026-11-02, inspection of the local EPay candidate's `src/lib/epay/orders.ts` found that `markOrderPaid` updates the order and starts notification, but does not update `Merchant.money`. Its `src/app/api/merchant/balance/route.ts` computes the combined display from main-site balance, selected EPay orders and invoice application fees, without reading `Merchant.money`. This explains why the PerPay candidate's imported `balance_cents` cannot simply be assumed to be the displayed balance. The local source inspection does not prove the full history or semantics of that field, current deployed behavior, or reconciled balances.
- On 2026-11-01, a read-only ingress and compiled-code check confirmed the default `/pay/` proxy used port 3023, served by `epay-next-reconcile-v1` from `20261025-reconcile-v2`. Its compiled merchant balance handler SHA-256 was `551d34fef975564ce1a2be73cf998f712b1e44cfb2f6bb43d4db484eec2b1402`; inspection confirmed the same page-size, paid-order limit, current-rate and invoice-status logic above. This establishes a risk in the routed code, not that a particular balance is wrong; verify actual data and fees under a coordinated snapshot.
- Read-only inspection of the main-site payment source (`routes.js` SHA-256 `a2f62ed81e0679369c41b64cf4c4d76125bdb665b2e65d9335eef765cb1b8dac`) showed that new orders record the fee and net amount, and confirmed payments create `payment_paid` entries and queue callbacks in memory. The balance endpoint returns only the first 200 ledger rows, so that response is not an exhaustive ledger export. This source inspection does not establish crash durability or a cross-system transaction.
- A separate read-only pass of the main-site `store.json` checked 211 orders and 45 `payment_paid` entries. For the checked fields, no missing or orphan order references, paid orders without postings, duplicate postings, merchant mismatch, invalid or mismatched amounts, or postings against unexpected states were found. This file read was not coordinated with EPay or provider records, does not prove it is the latest persisted state, and is not financial reconciliation.
- On 2026-11-02, an aggregate-only reread of that potentially stale file found 161 `expired`, 45 `paid`, and 5 `failed` orders. None of the expired records had a `paidAt` value or a matching `payment_paid` posting. The deployed payment route marks pending orders as expired, and the scheduled sweep excludes orders with a payment timestamp or posting. The candidate main-payment audit recognizes `expired` but rejects known unpaid states with a payment timestamp and already rejects payment postings against unpaid states. This does not verify current in-memory orders, provider settlement, or a consistent migration cutoff.

Do not use this report to authorize cutover. Establish a shared cutoff or a change-capture strategy, account for every missing binding and unbound merchant, verify financial ledger and order amounts with provider records, and verify the migrated records before any production switch.

## Subsequent isolated status and invoice check

On 2026-11-04, a read-only repeatable-read transaction against the active
EPay database counted one invoice application in PENDING status. Its order
was recorded PAID, and the stored merchant and external order identifiers
matched; the application had neither an invoice number nor an issued time.
The recorded fee was not negative. PENDING is the default in the legacy Prisma
schema, so the earlier audit's unrecognized-status finding was a false positive;
the local audit now accepts it. No invoice provider was queried and these
database fields do not establish whether an invoice was actually issued. This
was not a coordinated main-site snapshot and no application was modified.

On 2026-11-04, another read-only repeatable-read transaction against the active
EPay database counted 560 orders in total and the same 76 orders without a
current MerchantBinding: 69 CLOSED, 6 PENDING and 1 PAID. A daily aggregate
showed 4 orders on 2026-11-02 and 8 on 2026-11-03. At the previously recorded
candidate maintenance cutoff of 2026-11-03 13:15:23 +08:00, no orders were
created at or after the cutoff. This supports that maintenance did not add a
new unbound order after that cutoff, but it does not establish ownership or a
common cutoff with the main-site process.

On 2026-11-04, anonymous GET probes returned 404 for both
`/pay/api/project.php` and `/api/project.php`. `/project.php` returned a 200
HTML response, not evidence that the LightPay bridge ran; the server returned
the main-site application shell. The `/pay` and legacy submit/mapi entry points
returned 503, while the LightPay notification path returned 400 to an empty GET.
These probes did not carry valid payment parameters, create orders or verify
provider callbacks. They do not establish coverage of other hosts or routes.

On 2026-11-04, a read-only repeatable-read query of the active EPay database
found 121 successful merchant callback log rows and 123 PAID orders. The latest
callback log was 2026-11-03 12:45:54 +08:00 and the latest PAID order was
2026-11-03 12:45:52 +08:00, both before the candidate maintenance cutoff.
Two PAID orders still had notifyStatus PENDING; their latest update was
2026-10-24 07:07:39 +08:00. No callback log or PAID order was found at or after
the cutoff. This is database evidence only: it does not verify provider
delivery, main-site ledger posting, or callback processing on another system.

The same read-only check inspected those two PAID orders. Both belonged to
currently bound merchants, had notifyCount 0, no notifyLastAt value, and no
NotifyLog rows. They therefore show no recorded notification attempt rather
than a failed retry sequence. No notification was sent or replayed; identifiers
were omitted from the report.

On 2026-11-03 a separate attempt to restore this backup on the production host
used a no-network MySQL container with a 384 MiB memory limit and tmpfs data
directory. Docker events recorded an OOM kill before readiness, so no restore
or audit was performed. The temporary container was removed and the existing
main-site process was still running when checked afterward. This result does
not determine a safe memory limit or establish that production was unaffected
by the resource pressure. Do not repeat on the production host without an
independent resource and availability assessment; prefer a separate host.

On 2026-11-03, read-only inspection of the configured jump host found an
active 16 GiB swapfile on the ext4 root filesystem, with almost all swap in
use. The visible block-device tree showed no device-mapper encryption layer.
The host core pattern delegated to Apport, and the inspected login shell had
a zero core-size limit; neither observation proves the behavior of Docker
containers or the encryption and confidentiality of underlying storage. No
backup was transferred or restored there. Container swap restrictions alone
would not establish confidentiality for the host-side transfer process.

A subsequent synthetic-only check on the jump host used the existing Ubuntu
base image with host MariaDB binaries mounted read-only, a private tmpfs data
directory, no network, a 768 MiB memory limit, zero container swap, zero core
limit, dropped capabilities and a non-root UID. A one-row synthetic database
was created, queried and shut down; its container was removed. This verifies
only that those container constraints worked for the fixture. MariaDB 10.11
is not MySQL 8.4, the production backup was not transferred, and protection of
the host-side transfer process, image provenance, compatibility and full
financial reconciliation remain unverified. A MySQL 8.4 image pull timed out.

Later on 2026-11-03 the public MySQL image was streamed from the production
host to the jump host without exporting any container or database. Its image
ID matched the source. A synthetic one-row MySQL 8.4 database then ran in a
temporary, network-disabled, read-only-root container with tmpfs database
storage, a 1.5 GiB memory limit, zero container swap and zero core limit. The
fixture passed and the container was removed. This is not independent image
provenance, backup restoration or production-data verification.

A separate non-sensitive transient service probe on the production host found
cgroup v1. Despite requesting MemoryMax=64M and MemorySwapMax=0, the observed
memory and combined memory-plus-swap limits were both effectively unlimited;
the core-size limit was zero. Thus this probe did not establish protection for
a production-side backup encryption or capture process. No production backup
was read during the probe and no service or routing was restarted or changed.

On 2026-11-03, a synthetic end-to-end transfer was followed by a restore of
the SHA-256-checked 2026-10-31 EPay backup on the jump host. A short-lived
recipient MySQL 8.4 container generated an ephemeral RSA key and certificate
inside tmpfs. A source container mounted only the historical backup read-only,
checked its digest and encrypted it with CMS AES-256-GCM to that certificate.
Only ciphertext crossed the SSH streams. The recipient decrypted to tmpfs,
verified the same digest before restoring, and ran aggregate SQL. Both
containers had no network, read-only root filesystems, swap disabled and zero
core limits; the recipient was removed after the test. Aggregate results:
530 orders, zero missing external merchant order numbers and zero duplicate
external order-number groups within a merchant using binary comparison. The
main-site process was still running afterward. This is an old EPay backup,
not a current coordinated snapshot, merchant-ownership determination, channel
settlement verification, main-site data recovery or financial reconciliation.

The backup `/www/backup/epay-migration-20261031/epay_starmc-20261031-223005.sql.gz`
had SHA-256 `4007f403809a483c41102ac3ed7a32d915e42eccee4deb05808bbd398236b401`
when checked on 2026-11-01. It was restored to a disposable MySQL 8.4
container with no network or published ports and a tmpfs database directory.
Read-only aggregate SQL reported zero unknown order statuses, zero paid orders
with zero amount, zero invoices and zero invoice applications lacking an order
with the same merchant, and 76 orders without a merchant binding. Order IDs
were compared byte-for-byte because the restored tables use different
collations. The container was removed and its absence verified.

This was SQL on the old backup, not a run of the JavaScript cross-system
auditor, a coordinated current snapshot, provider verification, or financial
reconciliation. It does not determine the owner of those 76 orders, validate
invoice amounts or prove whether provider settlement occurred.

## Encrypted channel configuration rehearsal

On 2026-11-01 the same verified backup was restored in a disposable MySQL 8.4
container with no external network or published ports and a tmpfs database.
With Node 24.22.1 and an isolated read-only account, the snapshot check
verified 11 source tables, its authenticated manifest, and the structural
in-memory migration, including encryption and recovery of channel configuration.
The check explicitly reported assumed fees and timezone and
`financiallyReconciled: false`; it is not a persistent import, provider
settlement check, ownership determination, or financial reconciliation.
The disposable container and transferred temporary files were removed and
their absence verified. Production data and routing were not changed.

## Application Database Rehearsal

On 2026-11-02 the same backup was restored into an isolated, network-disabled
MySQL container using tmpfs storage. A SELECT-only account provided the source
snapshot. The candidate's actual application migrations and transaction path
imported 211 historical main-site orders and 50 ledger entries from the old
disk file; both sets were verified after closing and reopening the database.
The wrong master key was rejected. The source contained 530 EPay orders, 96
notification records, 22 invoices and one invoice application. Source hashes
were unchanged after the rehearsal, and the temporary container and files were
removed. Fee rates and timezone remained assumptions, and the main-site file
was known stale. The sources were not coordinated; this is not a financial
reconciliation, live-state recovery, production migration or cutover approval.

## Live WeChat Status Check

On 2026-11-03, a read-only production MySQL transaction identified two
unbound WeChat orders recorded locally as PENDING. Signed read-only queries
to the WeChat production API returned one SUCCESS and one NOTPAY. The
responses passed signature, timestamp, platform key identifier, merchant ID,
App ID, order number, currency and exact amount checks; the SUCCESS response
also passed transaction identifier format validation.

No orders, balances, ledger entries or callbacks were changed. These checks
do not establish either order's merchant ownership, whether the successful
payment was posted to the main-site ledger, or a coordinated cross-system
cutoff. Preserve the original identifiers and block automatic attribution,
compensation and production cutover until the outstanding evidence and
reconciliation gates are satisfied.

## Historical Paid Timestamps

On 2026-11-03, a read-only aggregate inspection of the stale main-site
`store.json` found 45 orders in `paid`, `refunded`, or `refund_processing`
states. All had a nonempty `paidAt` value that JavaScript `Date.parse` could
parse. This was not the stricter candidate import validation, did not examine
timestamp semantics or provider settlement, and did not capture current
in-memory state or a coordinated cross-system cutoff. No records were changed.

Later on 2026-11-03, the current candidate `auditMainPayments` was bundled
locally and streamed to Node over SSH; the stale production disk file was read
on the server and only aggregate counts were returned. For its 211 orders the
audit reported zero invalid paid timestamps, paid orders without a posting,
duplicate paid postings, mismatched paid posting amounts, orphan paid posting
references or missing order-merchant references. This is a strict candidate
audit of one stale disk file, not an isolated restored copy, a live memory
capture, provider settlement verification, or a complete financial
reconciliation. It did not modify production records.
