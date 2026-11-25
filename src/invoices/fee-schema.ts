import { TAX_INVOICE_SCHEMA_SQL } from "./schema.ts";

const requests = TAX_INVOICE_SCHEMA_SQL.slice(TAX_INVOICE_SCHEMA_SQL.indexOf("  CREATE TABLE epay_tax_invoice_requests"), TAX_INVOICE_SCHEMA_SQL.indexOf("  CREATE INDEX"))
  .replaceAll("epay_tax_invoice_requests", "epay_fee_invoice_requests")
  .replace("CHECK(payment_type='wxpay')", "CHECK(payment_type IN ('wxpay','alipay'))");
const guards = TAX_INVOICE_SCHEMA_SQL.slice(TAX_INVOICE_SCHEMA_SQL.indexOf("  CREATE TRIGGER epay_tax_invoice_immutable"), TAX_INVOICE_SCHEMA_SQL.indexOf("  CREATE TRIGGER epay_tax_invoice_refund_guard"))
  .replaceAll("epay_tax_invoice_", "epay_fee_invoice_");

export const FEE_INVOICE_SCHEMA_SQL = `
  CREATE TABLE epay_fee_invoice_buyers (
    merchant_id INTEGER PRIMARY KEY REFERENCES epay_merchant_accounts(merchant_id),
    buyer_type TEXT NOT NULL CHECK(buyer_type IN ('INDIVIDUAL','ORGANIZATION')),
    title TEXT NOT NULL, tax_id TEXT NOT NULL, email TEXT NOT NULL,
    auto_invoice INTEGER NOT NULL CHECK(auto_invoice IN (0,1)),
    version INTEGER NOT NULL CHECK(version>=1), updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL CHECK(updated_at>=0)
  ) STRICT;
  ${requests}
  CREATE UNIQUE INDEX epay_fee_invoice_order ON epay_fee_invoice_requests(trade_no);
  CREATE INDEX epay_fee_invoice_pending ON epay_fee_invoice_requests(updated_at,invoice_id) WHERE status IN ('UNKNOWN','PROCESSING','REVERSING');
  ${guards}
  CREATE TRIGGER epay_fee_invoice_identity BEFORE INSERT ON epay_fee_invoice_requests
    WHEN NEW.attempt<>1 OR NEW.application_no<>NEW.request_no OR NOT EXISTS(
      SELECT 1 FROM epay_orders o JOIN (
        SELECT trade_no,merchant_id,fee_cents FROM epay_alipay_confirmations
        UNION ALL SELECT trade_no,merchant_id,fee_cents FROM epay_wechat_confirmations
      ) c ON c.trade_no=o.trade_no AND c.merchant_id=o.merchant_id
      WHERE o.trade_no=NEW.trade_no AND o.merchant_id=NEW.merchant_id AND o.status='PAID' AND c.fee_cents=NEW.amount_cents)
    BEGIN SELECT RAISE(ABORT,'fee invoice requires recorded payment fee'); END;
  CREATE TRIGGER epay_fee_invoice_refund_guard BEFORE INSERT ON epay_fee_invoice_requests
    WHEN EXISTS(SELECT 1 FROM epay_native_refunds WHERE trade_no=NEW.trade_no AND status NOT IN ('REJECTED','CLOSED'))
    BEGIN SELECT RAISE(ABORT,'fee invoice conflicts with refund'); END;
  CREATE TRIGGER epay_fee_refund_invoice_guard BEFORE INSERT ON epay_native_refunds
    WHEN EXISTS(SELECT 1 FROM epay_fee_invoice_requests WHERE trade_no=NEW.trade_no AND status NOT IN ('FAILED','REVERSED'))
    BEGIN SELECT RAISE(ABORT,'refund requires fee invoice reconciliation or red cancellation'); END;
  CREATE TABLE epay_fee_invoice_provider_receipts (
    request_no TEXT PRIMARY KEY REFERENCES epay_fee_invoice_requests(request_no),
    provider TEXT NOT NULL CHECK(provider='fa-piao'),
    invoice_no TEXT NOT NULL UNIQUE CHECK(length(invoice_no)=20 AND invoice_no NOT GLOB '*[^0-9]*'),
    created_at INTEGER NOT NULL CHECK(created_at>=0)
  ) STRICT;
  CREATE TRIGGER epay_fee_receipt_immutable BEFORE UPDATE ON epay_fee_invoice_provider_receipts
    BEGIN SELECT RAISE(ABORT,'invoice receipt is immutable'); END;
  CREATE TRIGGER epay_fee_receipt_no_delete BEFORE DELETE ON epay_fee_invoice_provider_receipts
    BEGIN SELECT RAISE(ABORT,'invoice receipt is immutable'); END;
  CREATE TRIGGER epay_fee_receipt_number_guard BEFORE INSERT ON epay_fee_invoice_provider_receipts
    WHEN EXISTS(SELECT 1 FROM epay_tax_invoice_provider_receipts WHERE invoice_no=NEW.invoice_no)
    BEGIN SELECT RAISE(ABORT,'invoice number already used'); END;
  CREATE TRIGGER epay_tax_receipt_number_guard BEFORE INSERT ON epay_tax_invoice_provider_receipts
    WHEN EXISTS(SELECT 1 FROM epay_fee_invoice_provider_receipts WHERE invoice_no=NEW.invoice_no)
    BEGIN SELECT RAISE(ABORT,'invoice number already used'); END;
`;
