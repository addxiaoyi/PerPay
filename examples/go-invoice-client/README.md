# StarPAY tax invoice Go client

This standalone module implements the existing merchant automation contract. It
does not connect an API site's payment database, collect buyer details, authorize a
seller, or deploy an invoicing service. No real credentials or invoices are used by
its tests.

Use it from the business backend, never from browser code. Configure the main-site
merchant ID and HMAC API credentials. An EasyPay `pid` and MD5 key are different
credentials and will not authenticate these endpoints.

```go
client, err := invoiceclient.New(invoiceclient.Config{
    BaseURL: "https://star-web.top/pay/epay/tax-invoices/",
    MerchantID: merchantID,
    APIID: apiID,
    Secret: apiSecret,
})
if err != nil {
    return err
}

// Load this exact request from your durable application record. Obtain tradeNo
// from a verified StarPAY payment mapping, not a browser-supplied order number.
invoice, err := client.Create(ctx, savedApplication)
if err != nil {
    // Keep the record and request ID; a timeout is not evidence that no invoice
    // was issued. Do not create a second application with another ID.
    return err
}
if invoice.Status == "UNKNOWN" || invoice.Status == "PROCESSING" {
    // Save invoice.ID and poll Query on a bounded schedule until resolved.
    return savePending(invoice)
}
```

`Create` signs the exact JSON bytes and fixes the purpose and merchant identity in
the signed body. It makes one HTTP request and accepts 202 as unresolved only.
`Query` reads the original StarPAY record. `Files` returns a fresh HTTPS download
URL after the server has rechecked the invoice; the URL is short lived and is not
a permanent invoice address.

The client enforces HTTPS, a maximum one-minute timeout, no redirects, bounded
JSON requests and responses, and merchant/order/request identity checks. Errors
never include the returned body or buyer details. A custom transport is intended
for explicit certificate trust or test servers; production must retain TLS
verification.

HTTP 5xx and 408 errors preserve `ErrUncertain` alongside `APIError`. An upstream
failure can happen after issuance, so retain the original application even when
the response includes a machine-readable error code.

Before integrating, the business application still needs its own authenticated
buyer form, immutable application record, payment ownership check, refund lock,
and background status synchronization. Never enable automatic creation merely
because a balance recharge was paid. The approved invoice timing and actual
seller authorization must be in place.

Run the isolated tests with Go 1.24 or later:

```sh
go test ./...
go vet ./...
```

The public nginx deployment must explicitly route
`/pay/epay/tax-invoices/{applications,query,files}` to PerPay. The production
configuration inspected on 2026-11-21 still sends the unmatched `/pay/` prefix to
the legacy service; this client has not been enabled against production.
