export const TAX_INVOICE_SCHEMA_SQL = `
  CREATE TABLE epay_tax_invoice_profiles (
    merchant_id INTEGER PRIMARY KEY REFERENCES epay_merchant_accounts(merchant_id),
    sub_mch_id TEXT NOT NULL UNIQUE,
    seller_name TEXT NOT NULL,
    seller_tax_id TEXT NOT NULL,
    billing_person_id TEXT NOT NULL,
    item_name TEXT NOT NULL,
    tax_code TEXT NOT NULL,
    tax_rate_bps INTEGER NOT NULL CHECK(tax_rate_bps BETWEEN 0 AND 2500),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    authorized INTEGER NOT NULL CHECK(authorized IN (0,1)),
    authorization_checked_at INTEGER NOT NULL CHECK(authorization_checked_at>=0),
    version INTEGER NOT NULL CHECK(version>=1),
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL CHECK(updated_at>=0),
    CHECK(enabled=0 OR authorized=1)
  ) STRICT;
  CREATE TABLE epay_tax_invoice_requests (
    invoice_id TEXT PRIMARY KEY CHECK(length(invoice_id)=36),
    request_no TEXT NOT NULL UNIQUE CHECK(length(request_no)=32),
    application_no TEXT NOT NULL CHECK(length(application_no)=32),
    attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 5),
    request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 16 AND 80),
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    trade_no TEXT NOT NULL REFERENCES epay_orders(trade_no),
    amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 9007199254740991),
    payment_type TEXT NOT NULL CHECK(payment_type='wxpay'),
    provider_trade_no TEXT NOT NULL,
    profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
    buyer_type TEXT NOT NULL CHECK(buyer_type IN ('INDIVIDUAL','ORGANIZATION')),
    title TEXT NOT NULL,
    tax_id TEXT NOT NULL,
    email TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('UNKNOWN','PROCESSING','ISSUED','FAILED','REVERSING','REVERSED')),
    invoice_no TEXT,
    error_code TEXT,
    created_at INTEGER NOT NULL CHECK(created_at>=0),
    updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
    UNIQUE(merchant_id,request_id),
    UNIQUE(trade_no,attempt),
    CHECK(status<>'ISSUED' OR invoice_no IS NOT NULL),
    CHECK(status IN ('ISSUED','REVERSING','REVERSED') OR invoice_no IS NULL)
  ) STRICT;
  CREATE INDEX epay_tax_invoice_merchant_created ON epay_tax_invoice_requests(merchant_id,created_at DESC,invoice_id);
  CREATE INDEX epay_tax_invoice_pending_query ON epay_tax_invoice_requests(updated_at,invoice_id)
    WHERE status IN ('UNKNOWN','PROCESSING','REVERSING');
  CREATE UNIQUE INDEX epay_tax_invoice_active_order ON epay_tax_invoice_requests(trade_no) WHERE status NOT IN ('FAILED','REVERSED');
  CREATE TRIGGER epay_tax_invoice_attempt_guard BEFORE INSERT ON epay_tax_invoice_requests
    WHEN (NEW.attempt=1 AND (NEW.application_no<>NEW.request_no OR EXISTS(SELECT 1 FROM epay_tax_invoice_requests WHERE trade_no=NEW.trade_no)))
      OR (NEW.attempt>1 AND NOT EXISTS(SELECT 1 FROM epay_tax_invoice_requests p WHERE p.trade_no=NEW.trade_no
        AND p.merchant_id=NEW.merchant_id AND p.attempt=NEW.attempt-1 AND p.application_no=NEW.application_no AND p.status='FAILED'))
    BEGIN SELECT RAISE(ABORT,'invalid invoice attempt sequence'); END;
  CREATE TRIGGER epay_tax_invoice_identity BEFORE INSERT ON epay_tax_invoice_requests
    WHEN NOT EXISTS(SELECT 1 FROM epay_orders o WHERE o.trade_no=NEW.trade_no AND o.merchant_id=NEW.merchant_id
      AND o.status='PAID' AND o.money_cents=NEW.amount_cents)
    BEGIN SELECT RAISE(ABORT,'invoice order identity mismatch'); END;
  CREATE TRIGGER epay_tax_invoice_immutable BEFORE UPDATE ON epay_tax_invoice_requests
    WHEN NEW.invoice_id IS NOT OLD.invoice_id OR NEW.request_no IS NOT OLD.request_no OR NEW.request_id IS NOT OLD.request_id
      OR NEW.application_no IS NOT OLD.application_no OR NEW.attempt IS NOT OLD.attempt
      OR NEW.merchant_id IS NOT OLD.merchant_id OR NEW.trade_no IS NOT OLD.trade_no OR NEW.amount_cents IS NOT OLD.amount_cents
      OR NEW.payment_type IS NOT OLD.payment_type OR NEW.provider_trade_no IS NOT OLD.provider_trade_no OR NEW.buyer_type IS NOT OLD.buyer_type
      OR NEW.profile_json IS NOT OLD.profile_json OR NEW.title IS NOT OLD.title OR NEW.tax_id IS NOT OLD.tax_id
      OR NEW.email IS NOT OLD.email OR NEW.requested_by IS NOT OLD.requested_by OR NEW.created_at IS NOT OLD.created_at
      OR NEW.updated_at<OLD.updated_at
    BEGIN SELECT RAISE(ABORT,'invoice identity is immutable'); END;
  CREATE TRIGGER epay_tax_invoice_terminal BEFORE UPDATE ON epay_tax_invoice_requests
    WHEN (OLD.status='ISSUED' AND (NEW.status NOT IN ('ISSUED','REVERSING','REVERSED') OR NEW.invoice_no IS NOT OLD.invoice_no))
      OR (OLD.status='REVERSING' AND (NEW.status NOT IN ('ISSUED','REVERSING','REVERSED') OR NEW.invoice_no IS NOT OLD.invoice_no))
      OR (OLD.status IN ('FAILED','REVERSED') AND NEW.status<>OLD.status)
    BEGIN SELECT RAISE(ABORT,'invoice is terminal'); END;
  CREATE TRIGGER epay_tax_invoice_no_delete BEFORE DELETE ON epay_tax_invoice_requests
    BEGIN SELECT RAISE(ABORT,'invoice history is immutable'); END;
  CREATE TRIGGER epay_tax_invoice_refund_guard BEFORE INSERT ON epay_tax_invoice_requests
    WHEN EXISTS(SELECT 1 FROM epay_native_refunds WHERE trade_no=NEW.trade_no AND status NOT IN ('REJECTED','CLOSED'))
    BEGIN SELECT RAISE(ABORT,'invoice conflicts with refund'); END;
  CREATE TRIGGER epay_tax_invoice_legacy_guard BEFORE INSERT ON epay_tax_invoice_requests
    WHEN EXISTS(SELECT 1 FROM epay_invoices WHERE trade_no=NEW.trade_no)
      OR EXISTS(SELECT 1 FROM epay_invoice_applications WHERE trade_no=NEW.trade_no)
    BEGIN SELECT RAISE(ABORT,'invoice conflicts with legacy invoice'); END;
  CREATE TRIGGER epay_legacy_invoice_tax_guard BEFORE INSERT ON epay_invoices
    WHEN EXISTS(SELECT 1 FROM epay_tax_invoice_requests WHERE trade_no=NEW.trade_no)
    BEGIN SELECT RAISE(ABORT,'legacy invoice conflicts with tax invoice'); END;
  CREATE TRIGGER epay_legacy_invoice_application_tax_guard BEFORE INSERT ON epay_invoice_applications
    WHEN EXISTS(SELECT 1 FROM epay_tax_invoice_requests WHERE trade_no=NEW.trade_no)
    BEGIN SELECT RAISE(ABORT,'legacy invoice application conflicts with tax invoice'); END;
  CREATE TRIGGER epay_tax_refund_invoice_guard BEFORE INSERT ON epay_native_refunds
    WHEN EXISTS(SELECT 1 FROM epay_tax_invoice_requests WHERE trade_no=NEW.trade_no AND status NOT IN ('FAILED','REVERSED'))
    BEGIN SELECT RAISE(ABORT,'refund requires invoice reconciliation or red cancellation'); END;
`;

// Preserve migration 69 verbatim; migration 70 rebuilds its constrained request table without changing history.
const requestDefinition = TAX_INVOICE_SCHEMA_SQL.slice(TAX_INVOICE_SCHEMA_SQL.indexOf("  CREATE TABLE epay_tax_invoice_requests"), TAX_INVOICE_SCHEMA_SQL.indexOf("  CREATE INDEX"))
  .replace("CREATE TABLE epay_tax_invoice_requests", "CREATE TABLE epay_tax_invoice_requests_v2")
  .replace("CHECK(payment_type='wxpay')", "CHECK(payment_type IN ('wxpay','alipay'))");
const requestGuards = TAX_INVOICE_SCHEMA_SQL.slice(TAX_INVOICE_SCHEMA_SQL.indexOf("  CREATE INDEX"));
const dropGuards = [...TAX_INVOICE_SCHEMA_SQL.matchAll(/CREATE TRIGGER ([a-z_]+)/g)].map(match => `DROP TRIGGER ${match[1]};`).join("\n");
export const FA_PIAO_SCHEMA_SQL = `
  ALTER TABLE epay_tax_invoice_profiles ADD COLUMN provider TEXT NOT NULL DEFAULT 'wechat' CHECK(provider IN ('wechat','fa-piao'));
  ${dropGuards}
  ${requestDefinition}
  INSERT INTO epay_tax_invoice_requests_v2 SELECT * FROM epay_tax_invoice_requests;
  DROP TABLE epay_tax_invoice_requests;
  ALTER TABLE epay_tax_invoice_requests_v2 RENAME TO epay_tax_invoice_requests;
  ${requestGuards}
  CREATE TABLE epay_tax_invoice_provider_receipts (
    request_no TEXT PRIMARY KEY REFERENCES epay_tax_invoice_requests(request_no),
    provider TEXT NOT NULL CHECK(provider='fa-piao'),
    invoice_no TEXT NOT NULL CHECK(length(invoice_no)=20 AND invoice_no NOT GLOB '*[^0-9]*'),
    created_at INTEGER NOT NULL CHECK(created_at>=0)
  ) STRICT;
  CREATE TRIGGER epay_tax_receipt_immutable BEFORE UPDATE ON epay_tax_invoice_provider_receipts
    BEGIN SELECT RAISE(ABORT,'invoice receipt is immutable'); END;
  CREATE TRIGGER epay_tax_receipt_no_delete BEFORE DELETE ON epay_tax_invoice_provider_receipts
    BEGIN SELECT RAISE(ABORT,'invoice receipt is immutable'); END;
`;

export const INVOICE_RECONCILIATION_SCHEMA_SQL = `
  CREATE UNIQUE INDEX epay_tax_receipt_invoice_number ON epay_tax_invoice_provider_receipts(invoice_no);
`;
