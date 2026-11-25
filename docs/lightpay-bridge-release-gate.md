# LightPay bridge release gate

Status: blocked. This is a release and rollback procedure, not evidence that a change has been deployed or that payment routing works.

On 2026-11-03 a two-process synthetic test exposed a same-merchant race in
the earlier candidate: simultaneous first attempts could return 201 and 422.
The local candidate now inserts with `ON CONFLICT(id) DO NOTHING`, then checks
the stored merchant and amount before calling the mock provider. Five runs
each exercised 50 same-merchant races and 20 cross-merchant races without
reproducing that failure. Live read-only schema inspection confirmed `id` is
the orders primary key, and PHP reported SQLite 3.26.0. The revised candidate
has more changes than the earlier two-line patch; a fresh full comparison,
failure recovery review and independent validation are required. These tests
do not prove provider-side idempotency, same-order response equivalence,
PHP-FPM concurrency or production safety. Nothing was deployed.

On 2026-11-03 the production file still had SHA-256
`a552beab782b833164ddd046b0f89ce73897a5c6868c96db1ca7b09973e1cb4e`,
owner `root:root`, mode `644`, and passed `php -l`. The public bridge URL
returned 404, and the inspected Nginx configuration did not contain a
`project.php` reference. The main-site on-disk source uses that URL by default;
the process startup environment did not contain a nonempty override. Runtime
environment changes and the executing code version have not been proven.

The local candidate was separately tested on the server with two independent
PHP development servers, temporary SQLite on tmpfs and a mock provider. In
20 cross-merchant races for newly created identical order IDs, only the stored
merchant received a successful response; subsequent mismatched retries were
rejected. Temporary files and test processes were removed. This finite test
does not prove same-merchant concurrent idempotency, real PHP-FPM behavior,
provider behavior, existing-order ownership or production routing. No
production source, database or routing was changed.

On 2026-11-02 the live file retained the previously recorded SHA-256, owner,
mode and successful PHP syntax check. A fresh search of the active Nginx
configuration found no `project.php` reference. The candidate was tested in a
temporary server-side directory using synthetic SQLite rows and the fixture
payment provider: the cross-merchant, amount, missing-merchant and invalid
authentication cases passed. The test directory was removed. The test used
the server's Node 22 SQLite test harness, not the supported PerPay runtime;
it does not validate live routing, actual provider behavior or authorization to
deploy the bridge.

On 2026-11-01 a read-only SSH check returned live `project.php` SHA-256
`a552beab782b833164ddd046b0f89ce73897a5c6868c96db1ca7b09973e1cb4e`,
mode `644`, owner and group `root`, and a successful `php -l`. Removing the
merchant-check line from the local candidate in memory produced SHA-256
`fc1820393630178b53042ef1b18476c715e2fa11619b14f78e55aa3da6ffb5bf`.
An in-memory comparison identified the second intended change: the candidate
also selects `merchant_id`. Removing both changes made the candidate identical
to the live file byte for byte. This comparison is time-sensitive and must be
repeated immediately before release; it is not a routing or rollback test.

## Findings

- The original candidate copied from `/www/wwwroot/lightpay/api/project.php` added a stored-merchant identity check before reusing an order. The revised local candidate also changes insertion order to address a concurrent creation race. Recheck the entire diff immediately before any release.
- The active Nginx configuration inspected has no exact `/pay/api/project.php` location. Both anonymous GET and a credential-free empty POST to that public path returned 404. This does not prove the state of any particular real payment or rule out an application-level environment override.
- The currently read payment routes default to that public path, and the process environment read did not contain a nonempty gateway URL override. Runtime configuration and all request paths must still be checked before treating this as the complete production route.
- The previous isolated test used a mock payment provider and temporary SQLite. It covered valid retry, mismatched merchant, mismatched amount, missing stored merchant and invalid bridge authentication without making a real provider request.

## Before release

1. Identify the active application instance, its complete effective gateway configuration, request routing, PHP-FPM pool and OPcache behavior. Determine whether this LightPay bridge is needed for new or in-flight orders and identify affected orders without sending payments, refunds or callbacks.
2. Do not independently restore an old Nginx location: first review authentication, source restrictions, coexistence with EPay and compatibility for in-flight orders. Test any routing changes in isolation with a mock provider.
3. Confirm all historical orders with missing merchant IDs and decide how to handle retries: the candidate intentionally rejects them rather than guessing an owner. Confirm merchant and callback identity, idempotency, amount and concurrent-creation tests; do not infer settlement from HTTP responses.
4. Immediately before release, compare the exact deployed PHP file against the candidate baseline. Stop if it changed. Back up the live file outside the web root, record its hash, owner, group, mode and any relevant service configuration; verify the backup is readable and matches the original. Do not copy secrets into logs or the repository.
5. Stage the candidate in the same filesystem with matching permissions, run PHP syntax and isolated integration tests, and document the expected hash. Agree on the maintenance window, monitoring owner and rollback trigger before touching the live file.

## Controlled deployment and rollback

1. If the route, tests and in-flight ownership checks pass, atomically replace only the intended PHP file. Verify its hash and permissions. Apply an OPcache refresh only after identifying the actual FPM pool and understanding the impact; do not restart unrelated services.
2. Check routing and authentication with non-paying, invalid test requests. Do not issue a valid payment, refund, merchant callback or balance adjustment as a smoke test. Monitor real orders, provider-confirmed state, ledger and callbacks independently; request or page success alone is not settlement evidence.
3. On regression, stop new affected orders, preserve new data and logs, and atomically restore the verified original file with its permissions. Revert routing or OPcache changes separately if made, then verify the previous route and reconcile every in-flight or post-change order by its owner. Never restore an old database over newer financial records.
4. If ownership, backup restoration, routing, or financial reconciliation remains uncertain, keep the release blocked and escalate rather than attempting an automatic merge or cutover.
