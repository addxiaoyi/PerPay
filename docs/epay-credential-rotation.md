# EPay database credential rotation

## Verified snapshot reader - 2026-11-06

The production synchronizer now reads `/etc/helstera/perpay-snapshot.json`
(0600) using `perpay_snapshot_20261105` with only SELECT and LOCK TABLES on the
EPay database. SHOW GRANTS, a real SELECT and a denied zero-row UPDATE verified
the privilege boundary. The running synchronization service succeeded with the
new account, with the previous configuration temporarily restored, and again
with the new account. Evidence is
`/root/perpay-recovery-20261106-rc5/reader-rollback.json`.

The panel's supported configuration reader is required to obtain its stored
administrator credential; raw SQLite values are not usable login passwords.
No credential was printed or placed in command arguments. The original EPay
writer accounts were not rotated; that remains separate work.

## WeChat merchant signing keys (isolated implementation)

The query prototype stores merchant signing keys encrypted with the runtime master key, binds ciphertext to its key ID, and checks merchant identity, validity and revocation before signing and again in the payment-confirmation transaction. Registration only checks that the supplied RSA key pair matches; it does not establish that a certificate, serial number or merchant identity is authentic. The registration and query functions are not production routes. Verify provenance through the provider and enforce administrator authorization before exposing them.

Rotation requires registering the independently verified replacement, testing it in isolation and coordinating validity overlap before revoking the old key. Revocation prevents later confirmation using that key, but cannot recall an already transmitted request. Securely back up and restore the master key with the corresponding instance ID; loss or mismatch makes encrypted credentials unavailable. Synthetic database-file checks do not prove that keys never appear in memory, WAL files, backups, logs or crash dumps.

This is an operational plan, not a record of a completed rotation. Do not place credentials in shell history, process arguments, logs, or this document.

On 2026-10-31, a read-only PM2 environment inventory on the payment host found 19 online `epay-*` processes with `DATABASE_URL` identical to `epay-next-submit-303`. This includes the retry and reconciliation processes. Root's crontab also runs `/usr/local/sbin/epay-reconcile.sh` every minute; a static inspection found an HTTP call and no direct reference to `DATABASE_URL`, `DB_PASSWORD`, or `mysql`. Downstream credentials still need verification. This is not a complete consumer inventory: configuration files, other scheduled jobs, other hosts, and processes without that environment variable still need examination. No credentials were changed and no rollback was executed.

Further read-only inspection on 2026-10-31 identified the cron target as `https://star-web.top/pay/api/internal/reconcile`. The script sets an `x-reconcile-secret` header and does not reference `RECONCILE_SECRET` by name, an environment file, or PM2. This is a static observation, not proof of how the header value is managed. The local EPay source for that route checks the header against the server's `RECONCILE_SECRET`, then uses Prisma for order and configuration reads and writes, invokes provider queries, and retries merchant callbacks. The live routing, live code version, effective secret equality, and the database account used by the actual upstream process have not been verified. Do not invoke this endpoint as a health check: it can mutate orders and send callbacks.

On 2026-11-01 a disposable, network-isolated MySQL 8.4 container with a tmpfs data directory was used to test the dual-account rollback concept. Separate synthetic old and new SELECT-only accounts could read a test row, the new account could not insert, invalid credentials failed, and the old account still read successfully afterward. The container was removed. This exercise did not test the production deployment mechanism, application connections, production credentials, or a rollback of an active production service.

1. Identify the actual MySQL endpoint and account used by each live EPay process, scheduled reconciliation and retry job, deployment script, backup, and any other client. Inspect environment variable names and account identities without printing passwords. The EPay code can use `DATABASE_URL`, or `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`, and `DB_NAME` when that URL is absent.
2. Record the current routing and process configuration, verify a restorable backup, and identify the exact rollback commands for each active process. The host currently has multiple online EPay PM2 processes; determine which serve traffic or run background jobs before making changes.
3. Provision a separate database account with the minimum privileges needed by the existing application. Preserve the old account while both accounts are active. Verify connectivity and required privileges from an isolated process without creating orders or changing financial records.
4. Update secrets in the authoritative deployment secret store and start a candidate instance with the new account. Check readiness and read-only merchant and order queries, then switch traffic using the existing deployment procedure. Update background jobs and each remaining active client in a controlled sequence. Do not assume changing an environment file updates already running PM2 processes.
5. Verify application health, order reads, callback and reconciliation job operation, and database access logs for every client. Keep the old account available for rollback until all consumers are confirmed on the new account and the observation window has passed.
6. Revoke and retire the old account only after confirming no legitimate clients use it. If a client fails, restore its previous configuration and traffic target before investigating.

For migration snapshots, use a separate account restricted to the required source tables and `SELECT` privileges. A read-only transaction alone does not make a privileged account read-only. Validate the account against an isolated restore before connecting it to production.
