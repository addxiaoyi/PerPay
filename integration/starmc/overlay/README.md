# Main-site payment durability overlay

This candidate is based on the production-matched StarMC payment router, not the unrelated root prototype. `manifest.json` records the source hashes supplied by the production inspection and the candidate hash. Deployment is a separate operation from installing or building PerPay. This versioned integration never modifies the running main-site service.

## Change

- The internal paid bridge, WeChat payment callback, merchant order API, and signed EPay order bridge wait for the existing `flushSaveSyncAndPg` durable store write before returning success.
- A failed or missing durable writer returns HTTP 503. A repeated payment notification flushes again, including when the previous attempt already changed memory, so a failed write cannot be mistaken for a successful acknowledgement.
- Repeated merchant order numbers must retain the original amount, payment channel, notification URL, and return URL. Changed requests return HTTP 409 without rotating access tokens or changing the saved order.
- The payment ledger, confirmation event, and merchant callback task remain in the same persisted JSON snapshot. The change does not modify balances outside those existing confirmation paths.
- Ordinary scheduled saves write and fsync their private temporary file asynchronously, then publish it atomically after the existing external-modification checks. The final conflict check and rename remain adjacent synchronous metadata operations. Directory fsync also uses asynchronous I/O on POSIX.
- A dirty generation records mutations that arrive while the previous snapshot is being written. A later generation is saved again; failed writes preserve dirty state, log their failure, and can recover on a subsequent mutation or explicit flush. They do not create an unbounded automatic retry loop.
- Financial flushes wait for an in-flight ordinary write before persisting the latest state, so an older snapshot cannot overwrite a newer payment commit. Compact JSON reduces serialization/output overhead without changing JSON values. JSON serialization itself is still synchronous; this patch does not claim to eliminate every event-loop delay.
- A shared revision barrier keeps uncommitted payment mutations out of signed migration snapshots, financial reads, dependent mutations and worker deliveries. A failed commit stays blocked until a later durable commit succeeds. An older delayed success can only advance its captured revision, so it cannot release a newer failed write. Invalid/conflicting requests do not retain a revision or block subsequent reads.
- Workers recheck the barrier before selecting tasks, before dispatch, and after asynchronous continuations. Pausing for a financial commit does not consume a delivery attempt. A late channel-creation response cannot change a paid/refunded order back to pending. Financial HTTP response values are captured before awaiting persistence so an older successful request cannot expose a later failed mutation.

## Installation boundary

1. Verify all `baseline` SHA-256 values in `manifest.json` against the stopped/retained production source. A drifted source requires a fresh review; do not overwrite it with this candidate.
2. Preserve the existing payment router and server source in the deployment rollback directory.
3. Install `src/modules/payment/routes.js`, `src/persist.js`, and apply the unique `server-injection.json` replacement to `src/server.js`. The server already imports `flushSaveSyncAndPg`; the patch only supplies `flushSave: flushSaveSyncAndPg` to `registerPaymentRoutes`.
4. Check all three JavaScript files with the production Node binary before restarting the normal application service. Retain the current data directory, bridge key, and financial records.
5. Verify normal readiness, source synchronization, and the private financial integrity audit. Do not generate a production payment, refund, or notification merely to verify deployment.

Rollback restores the three source files and restarts the normal service. It never restores an older financial database or store snapshot over new transactions.

## Repeatable isolated verification

From the PerPay repository root:

```powershell
npm run test:starmc
```

The self-contained runner copies the attested router and the support files in `integration/starmc/support/src` into a temporary directory, uses fixture-only credentials, runs loopback HTTP requests, and disables all outbound requests in child services. It never starts the production server or opens production data. Set `STARPAY_MAIN_SOURCE_DIR` to the unmodified production-matched source directory to reproduce the original failure; the injected disk-write failure incorrectly returns 201 before this patch.

The original eleven payment checks cover six concurrent confirmations, a real child-process kill after commit but before acknowledgement, restart/replay, durable-write failure, absent writer configuration, forged bridge credentials, amount/channel mismatch, late notifications after refund, durable order creation/retry, changed order parameters, signed EPay requests, and RSA/AES-GCM WeChat notifications. Eight additional checks cover financial snapshot/read/mutation barriers, worker dispatch barriers, persistent failure/retry, out-of-order commit completion, DNS and HTTP continuation barriers, late channel projection, and response snapshots.

Eight persistence checks cover asynchronous ordinary I/O, concurrent dirty generations, financial flush ordering, asynchronous fsync failure, retry recovery, external-modification protection, exclusive temporary-file creation, and restart loading. The original eighteen persistence regressions were also copied into an isolated directory and run against the candidate persistence file: sixteen passed and two POSIX-only checks were skipped on Windows. Windows alone uses the snapshot factory's supported test-secret injection because that filesystem cannot represent POSIX 0600 permissions; Linux uses the actual secret-file reader. Final acceptance requires the independent Linux reviewer to rerun the full candidate and its separate durability regressions.

These checks validate StarMC's existing payment ledger and notification outbox. They do not prove that an independently hosted merchant website has committed its own business order or dispatched exactly one shipment. The receiving application source for the referenced `studio.0st.top` merchant was not present in this workspace; it still requires its own transactional callback/fulfillment acceptance.
