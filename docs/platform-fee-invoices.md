# Platform technical service fee invoices

This workflow invoices the merchant for the platform's recorded fee, not the customer for their purchase. Seller configuration is held in the private fa-piao credential file. Buyer information comes from each merchant's declared billing profile; a display username is not an invoice title and historical customer invoice applications are not merchant billing evidence.

## Closed preparation

Keep `PERPAY_TAX_INVOICE_ENABLED=false`, `PERPAY_TAX_INVOICE_AUTO_SYNC_ENABLED=false` and `PERPAY_EPAY_INVOICE_ENABLED=false`. Add `platformFees` in the private credential JSON with `itemName`, the 19-digit `taxCode`, `taxRateBps` (100 or 300), `enabled:false` and a millisecond `validUntil`. Never place this JSON in a release archive. Only the seller's public invoice details are returned to the console, without the billing login or API secrets.

The Shanghai tax bureau dictionary identifies `3040205000000000000` as information-system value-added services. The declared platform technical service is prepared under this code. Actual contract substance must continue to match the code. The tax bureau's [2026 announcement 4](https://fgk.chinatax.gov.cn/zcfgk/c100012/c5247426/content.html) requires eligible small-scale 3%-to-1% transactions to be invoiced at 1%. The [2026 announcement 10](https://fgk.chinatax.gov.cn/zcfgk/c102416/c5247434/content.html) keeps this reduction through 2027. A normal item-maintenance dropdown listing 3% does not mean that the 1% reduction is unavailable for actual invoices.

For ordinary 1% invoices the fa-piao API line tax rate is `sl:"0.01"`, with ordinary collection mode `zsfs:"0"`. Do not send a special `jazslxDm` for this policy: the [vendor document](https://www.fa-piao.com/doc.html) defines that field for used fixed assets, housing leases and used-goods dealers. The adapter computes net/tax amounts in cents without floating-point rounding. A configured 3% platform invoice sends the vendor's `slsm:"2"`; choosing 3% is an explicit configuration change, not an automatic fallback after a failed 1% request.

## Console and automatic execution

The existing merchant tax-invoice page switches to the platform fee workflow when `platformFees` is configured. The merchant owner saves the real buyer type/title/tax ID/email and selects automatic invoicing. This can be prepared while issuance is off. No buyer is synthesized from the display name, payout account, or end customer's invoice.

Buyer preparation is per merchant, not a platform activation prerequisite. The platform can be enabled once its seller configuration and provider authorization are ready even when no merchant has opted in yet. Missing or incomplete buyer profiles only keep those merchants out of the issuance queue. Merchants maintain their own information in the console.

Each merchant must purchase annual invoice service before new fee invoices are submitted. The fixed price is 100 yuan for 365 days, deducted from verified available merchant balance. An explicit owner/admin confirmation is required; there is no automatic renewal. Purchasing again extends from the later of now or the current expiry. Repeated request IDs recover the original receipt, and changed balance/expiry versions reject a concurrent duplicate purchase. In rc.19, a configured platform permits pre-purchase while real issuance is off, only with explicit acknowledgment that the term starts at purchase and invoices wait for activation. When issuance is on, new purchases still probe provider authorization before charging. Purchasing never enables issuance.

`GET/POST /subscription` under the fee-invoice mount uses a separate invoice-subscription CSRF purpose. Merchant buyer information can still be saved before purchasing. A missing/expired annual service prevents only that merchant's new fee requests; it does not prevent platform activation. The annual receipt is a subscription/balance record, not a newly issued tax invoice for the annual fee.

The fee console mount is `/pay/api/merchant/epay/fee-invoices` (the actual base path follows deployment configuration). Session/list are read-only; `POST /buyer` uses live merchant identity, same origin and CSRF. `POST /applications` accepts only `{tradeNo}`; amount, seller and tax cannot be supplied by the browser. Members cannot mutate.

When all gates are enabled, a minute worker checks up to twenty opted-in eligible payments. A verified native confirmation plus matching ledger posting is required, and its historical `fee_cents` is the gross invoice total. A request and audit are committed before contacting the issuer. Each payment has one durable fee application; concurrent calls or a restart recover it rather than replay issuance. Files are retrieved through the authenticated console after verification. Automatic email delivery is not enabled.

Local validation failures are deferred per payment without starving later candidates. Provider outages, expiry and authentication requirements pause the batch for five minutes initially, increasing to a maximum of thirty minutes. Queue checkpoints use validated runtime metadata and survive restarts. Existing uncertain requests are never rearmed by this cooldown. Automatic submission rechecks the merchant's opt-in in the reservation transaction.

`GET /readiness` returns merchant-scoped preparation gates and a verified fee preview covering up to two hundred recent candidates. `POST /provider-status` requires administrator identity, same origin and CSRF; it reads authorization without issuing an invoice or switching any execution gate. A successful fresh check clears provider cooldown only. Failed token acquisition is cached for sixty seconds to prevent repeated authorization traffic; an explicit fresh check after renewal bypasses that negative cache.

In platform-fee mode new customer full-payment applications are rejected with `invoice_fee_scope_required`. Existing application reads remain supported. The fee request still accepts only the original payment identifier, so browser-supplied amounts and tax rates cannot authorize a larger invoice.

For an operator preflight, run `node --experimental-strip-types scripts/check-fee-invoice-readiness.ts --database /absolute/path/perpay.sqlite3 --credentials /absolute/path/fa-piao.private.json --check-provider`. This script opens SQLite read-only, reports configuration/authentication/buyer prerequisites without their private values, and makes zero invoice submissions. Renewing the vendor service does not automatically activate issuance; inspect this report and the execution gates before activation.

## Uncertain results and refunds

The shared background query worker reads customer and fee invoices. Known provider numbers are saved before identity verification. Unknown numbers, timeouts and SMS/face requirements remain unresolved; administrators use the existing preview/confirm original-number flow and retain provider evidence. Never recover uncertainty by directly opening a second invoice at the provider.

Positive recorded fees are required. Refunded/actively refunding payments are excluded, and refunds against an issued or unresolved fee invoice require invoice reconciliation/red cancellation first. This candidate does not automate red cancellation. Pre-submission failures are recorded without automatic retry; the operator must verify the source state and resolve them.

Verified merchant-balance payments are supported alongside Alipay and WeChat fee sources. Their fee is read from the original internal payment confirmation, not recomputed from the current rate. Refunded balance payments are excluded. The same invoice-number uniqueness and immutable snapshots apply.
