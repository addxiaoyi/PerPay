# fa-piao merchant invoicing

The fa-piao adapter uses the existing merchant invoice routes and signed business API. It supports confirmed Alipay and WeChat payments; amount, merchant ownership, refund conflicts and duplicate application guards remain enforced by PerPay. Only ordinary blue electronic invoices (`82`) with a positive, finance-confirmed tax rate are supported initially. Red cancellation and zero-rate/exempt treatment need a separate implementation and validation.

## Configuration

Keep the credential JSON outside the release package, with mode `0600` on Linux and access limited to the application user on Windows. Never place credentials in frontend code, source control or diagnostic output. Files ending in `.private.json` and local `.env.*` files are ignored by this checkout.

```json
{
  "appKey": "REPLACE_WITH_APP_KEY",
  "appSecret": "REPLACE_WITH_APP_SECRET",
  "accountId": "1000",
  "sellerTaxId": "REPLACE_WITH_SELLER_TAX_ID",
  "sellerName": "REPLACE_WITH_LEGAL_SELLER_NAME",
  "username": "REPLACE_WITH_BILLING_PHONE",
  "plan": "6"
}
```

For preparation, set these variables alongside the existing deployment configuration:

```dotenv
PERPAY_TAX_INVOICE_PROVIDER=fa-piao
PERPAY_TAX_INVOICE_FAPIAO_CREDENTIAL_FILE=/run/secrets/fa-piao.private.json
PERPAY_TAX_INVOICE_ENABLED=false
PERPAY_TAX_INVOICE_AUTO_SYNC_ENABLED=false
PERPAY_EPAY_INVOICE_ENABLED=false
```

Startup validates the credential file but makes no remote requests in this mode. Administrators can save a disabled invoice profile through the existing console; issuance, authorization probes and background queries remain off. Use the fa-piao enterprise ID for the account field and the registered billing phone for the billing-person field. This does not require a WeChat service-provider identity.

Before activation, supply the confirmed `sellerAddressPhone` and `sellerBankAccount` fields in the private JSON, select the actual tax classification and rate in the merchant profile, confirm fa-piao service validity and the server's outbound IP whitelist. Set both issuance variables to `true` only after those checks. The provider itself and the HTTP routes independently block issuance while disabled. No tax password or automatic SMS forwarding is stored or enabled by this adapter.

## Protocol and recovery

Signing follows the publisher's [Python SDK](https://github.com/fapiaoapi/invoice-sdk-python/blob/master/tax/invoice/utils/signature.py): uppercase HMAC-SHA256 of method, path, nonce, seconds timestamp and AppKey. Requests use HTTPS, prohibit redirects, bound reply sizes and time out. Tokens are coalesced in memory for 15 minutes; a 401 invalidates the cache for the next call but never replays an invoice submission.

The application ID is persisted before submission and sent as `fpqqlsh`. A successful response's invoice number is stored in an immutable receipt before querying its seller, buyer and total. Only a matching verified receipt becomes `ISSUED` or downloadable. SMS/face requirements remain unresolved states and cannot trigger automatic reissuance.

The [public v5 documentation](https://www.fa-piao.com/doc.html) does not document a lookup by `fpqqlsh`. If a timeout loses the invoice number, this integration returns `UNKNOWN / fapiao_reconcile_required`; an operator must find the original invoice at the provider and reconcile it. It never invents a query endpoint or generates a new application to retry an uncertain invoice. Externally performed red cancellations also require operator reconciliation in this initial adapter.

In source candidate rc.15, an administrator can use **核对并回填原发票号** on an unresolved application while issuance is off. Find the original `fpqqlsh` at the provider and retain an evidence reference. Enter its 20-digit invoice number, preview the invoice, and explicitly confirm that it belongs to the original application and is a valid unreversed blue invoice. The API checks seller, buyer, total and tax details but cannot independently prove that application linkage or external reversal state. A reference must identify retrievable provider evidence, not a guessed association based only on equal amounts.

The merchant-scoped routes are `POST /:id/reconcile/preview` and `POST /:id/reconcile/confirm` under the existing console tax-invoice mount. Both require administrator identity, same origin and CSRF. Preview makes no database writes. The five-minute review is bound to operator and immutable request state; confirmation rechecks details and saves receipt, status and audit in one transaction. A reused invoice number, changed snapshot, terminal request, expired token or failed provider query saves nothing. Never call the issuance route to recover a timeout.

Schema 70 preserves migration 69 and migrates existing request history unchanged. Take a database backup before upgrading; rollback requires restoring that backup before starting rc.13 or an earlier version. Existing WeChat snapshots remain tagged as WeChat and are rejected by the fa-piao adapter instead of being queried under the new account.

Once collection has resumed, do not overwrite the active database with a pre-upgrade backup: it may discard later payment or accounting records. Quiesce writers and reconcile all post-cutover records before planning a schema downgrade. Same-schema code rollback retains the current database.

## StarMC deployment verification, 2026-11-22

The source candidate was deployed to `star-web.top` as rc.14 / schema 70. Public payment health and readiness returned 200; the signed application, query and file endpoints returned `503 / invoice_disabled`. Both invoice execution switches and automatic synchronization remain disabled. Credentials are provisioned separately in the payment user's private secrets directory.

The ECS public IPv4 is `121.196.161.249`, matching the currently configured fa-piao whitelist. A read-only provider authorization probe reached fa-piao and returned service expiration; no invoice was submitted. The independent external IP probe was unavailable. Seller bank information, invoice address/phone and finance-confirmed classification/rate remain to be supplied.

The upgrade and rollback rehearsal preserved 133 business tables. The pre-existing aged pending-payment alert remains active; its monitor criterion was not changed and no backlog order was marked paid or closed. Accounting records were compared before restoring prior payment admission. Full evidence is under `artifacts/fa-piao-deployment-20261122/deployment-summary.json`.

## Local verification

```sh
node --experimental-strip-types --test test/invoice-fa-piao.test.ts
npx vitest run --config web/vite.config.ts web/test/fa-piao-invoices.test.tsx
```

These are synthetic checks, not evidence of a live invoice or provider account authorization.

For the ignored local `.env.fa-piao` overlay and `fa-piao.private.json` prepared in this checkout, run:

```sh
node --env-file=.env.fa-piao --experimental-strip-types scripts/verify-fa-piao-off.ts
```

This validates the actual private file and runtime selection without touching a database or making network requests. To load the overlay with the existing local environment after deployment preparation, use `node --env-file=.env --env-file=.env.fa-piao dist/main.js`. Do not copy the private file into release artifacts; provision it separately for the application user.
