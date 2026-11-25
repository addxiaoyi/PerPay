import { FEE_INVOICE_SCHEMA_SQL } from "../invoices/fee-schema.ts";

const feeTable = FEE_INVOICE_SCHEMA_SQL.slice(FEE_INVOICE_SCHEMA_SQL.indexOf("  CREATE TABLE epay_fee_invoice_requests"), FEE_INVOICE_SCHEMA_SQL.indexOf("  CREATE UNIQUE INDEX epay_fee_invoice_order"));
const feeGuards = FEE_INVOICE_SCHEMA_SQL.slice(FEE_INVOICE_SCHEMA_SQL.indexOf("  CREATE UNIQUE INDEX epay_fee_invoice_order"));
const dropFeeTriggers = [...feeGuards.matchAll(/CREATE TRIGGER ([a-z_]+)/g)].map(match => `DROP TRIGGER ${match[1]};`).join("\n");
const receiptTable = feeGuards.slice(feeGuards.indexOf("  CREATE TABLE epay_fee_invoice_provider_receipts"), feeGuards.indexOf("  CREATE TRIGGER epay_fee_receipt_immutable"));

export const BALANCE_PAYMENT_SCHEMA_SQL = `
  CREATE TABLE epay_invoice_subscription_receipts (
    receipt_id TEXT PRIMARY KEY, merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    request_id TEXT NOT NULL, actor_id TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents=10000),
    starts_at INTEGER NOT NULL, valid_until INTEGER NOT NULL, ledger_entry_id TEXT NOT NULL UNIQUE REFERENCES epay_balance_ledger(entry_id),
    expected_balance_version INTEGER NOT NULL, expected_valid_until INTEGER NOT NULL, created_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL CHECK(duration_ms=31536000000),
    UNIQUE(merchant_id,request_id), CHECK(valid_until=starts_at+duration_ms AND starts_at>=created_at)
  ) STRICT;
  CREATE TABLE epay_invoice_subscriptions (
    merchant_id INTEGER PRIMARY KEY REFERENCES epay_merchant_accounts(merchant_id),
    valid_until INTEGER NOT NULL CHECK(valid_until>0),version INTEGER NOT NULL CHECK(version>0),
    last_receipt_id TEXT NOT NULL REFERENCES epay_invoice_subscription_receipts(receipt_id)
  ) STRICT;
  CREATE TRIGGER epay_invoice_subscription_receipt_no_update BEFORE UPDATE ON epay_invoice_subscription_receipts BEGIN SELECT RAISE(ABORT,'subscription receipt is immutable'); END;
  CREATE TRIGGER epay_invoice_subscription_receipt_no_delete BEFORE DELETE ON epay_invoice_subscription_receipts BEGIN SELECT RAISE(ABORT,'subscription receipt is immutable'); END;
  CREATE TRIGGER epay_invoice_subscription_receipt_payment BEFORE INSERT ON epay_invoice_subscription_receipts
    WHEN NOT EXISTS(SELECT 1 FROM epay_balance_ledger l WHERE l.entry_id=NEW.ledger_entry_id AND l.merchant_id=NEW.merchant_id
      AND l.entry_type='invoice_subscription' AND l.source='perpay_epay' AND l.available_delta_cents=-10000 AND l.frozen_delta_cents=0)
    BEGIN SELECT RAISE(ABORT,'subscription receipt requires exact annual debit'); END;
  CREATE TRIGGER epay_invoice_subscription_guard BEFORE INSERT ON epay_invoice_subscriptions
    WHEN NOT EXISTS(SELECT 1 FROM epay_invoice_subscription_receipts r WHERE r.receipt_id=NEW.last_receipt_id AND r.merchant_id=NEW.merchant_id AND r.valid_until=NEW.valid_until)
    BEGIN SELECT RAISE(ABORT,'subscription requires a paid receipt'); END;
  CREATE TRIGGER epay_invoice_subscription_update_guard BEFORE UPDATE ON epay_invoice_subscriptions
    WHEN NEW.merchant_id<>OLD.merchant_id OR NEW.version<>OLD.version+1 OR NEW.valid_until<=OLD.valid_until OR NOT EXISTS(
      SELECT 1 FROM epay_invoice_subscription_receipts r WHERE r.receipt_id=NEW.last_receipt_id AND r.merchant_id=NEW.merchant_id AND r.valid_until=NEW.valid_until)
    BEGIN SELECT RAISE(ABORT,'subscription extension requires a paid receipt'); END;
  CREATE TRIGGER epay_invoice_subscription_no_delete BEFORE DELETE ON epay_invoice_subscriptions BEGIN SELECT RAISE(ABORT,'subscription history is immutable'); END;
  CREATE TABLE epay_balance_orders (
    trade_no TEXT PRIMARY KEY REFERENCES epay_orders(trade_no),order_id TEXT NOT NULL UNIQUE,main_merchant_id TEXT NOT NULL,main_api_id TEXT NOT NULL,
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),fee_cents INTEGER NOT NULL CHECK(fee_cents>=0),
    request_fingerprint TEXT NOT NULL,callback_id TEXT NOT NULL,nonce BLOB NOT NULL,ciphertext BLOB NOT NULL,authentication_tag BLOB NOT NULL,
    expires_at INTEGER NOT NULL CHECK(expires_at>0),created_at INTEGER NOT NULL CHECK(created_at>=0)
  ) STRICT;
  CREATE TRIGGER epay_balance_order_no_update BEFORE UPDATE ON epay_balance_orders BEGIN SELECT RAISE(ABORT,'balance payment contract is immutable'); END;
  CREATE TRIGGER epay_balance_order_no_delete BEFORE DELETE ON epay_balance_orders BEGIN SELECT RAISE(ABORT,'balance payment contract is immutable'); END;
  CREATE TABLE epay_balance_confirmations (
    trade_no TEXT PRIMARY KEY REFERENCES epay_balance_orders(trade_no),provider_trade_no TEXT NOT NULL UNIQUE,
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),payer_merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    actor_id TEXT NOT NULL,request_id TEXT NOT NULL,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),fee_cents INTEGER NOT NULL CHECK(fee_cents>=0 AND fee_cents<=amount_cents),
    confirmed_at INTEGER NOT NULL CHECK(confirmed_at>=0),
    payer_entry_id TEXT NOT NULL UNIQUE REFERENCES epay_balance_ledger(entry_id) DEFERRABLE INITIALLY DEFERRED,
    receiver_entry_id TEXT NOT NULL UNIQUE REFERENCES epay_balance_ledger(entry_id) DEFERRABLE INITIALLY DEFERRED,
    CHECK(merchant_id<>payer_merchant_id),UNIQUE(payer_merchant_id,request_id)
  ) STRICT;
  CREATE TRIGGER epay_balance_confirmation_no_update BEFORE UPDATE ON epay_balance_confirmations BEGIN SELECT RAISE(ABORT,'balance payment confirmation is immutable'); END;
  CREATE TRIGGER epay_balance_confirmation_no_delete BEFORE DELETE ON epay_balance_confirmations BEGIN SELECT RAISE(ABORT,'balance payment confirmation is immutable'); END;
  CREATE TABLE epay_balance_refunds (
    trade_no TEXT PRIMARY KEY REFERENCES epay_balance_confirmations(trade_no),merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),request_id TEXT NOT NULL,actor_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK(amount_cents>0),refunded_at INTEGER NOT NULL CHECK(refunded_at>=0),
    payer_entry_id TEXT NOT NULL UNIQUE REFERENCES epay_balance_ledger(entry_id) DEFERRABLE INITIALLY DEFERRED,
    receiver_entry_id TEXT NOT NULL UNIQUE REFERENCES epay_balance_ledger(entry_id) DEFERRABLE INITIALLY DEFERRED,UNIQUE(merchant_id,request_id)
  ) STRICT;
  CREATE TRIGGER epay_balance_refund_no_update BEFORE UPDATE ON epay_balance_refunds BEGIN SELECT RAISE(ABORT,'balance refund is immutable'); END;
  CREATE TRIGGER epay_balance_refund_no_delete BEFORE DELETE ON epay_balance_refunds BEGIN SELECT RAISE(ABORT,'balance refund is immutable'); END;
  CREATE TRIGGER epay_balance_order_identity BEFORE INSERT ON epay_balance_orders
    WHEN NOT EXISTS(SELECT 1 FROM epay_orders o WHERE o.trade_no=NEW.trade_no AND o.merchant_id=NEW.merchant_id AND o.type_code='balance' AND o.status='PENDING' AND o.money_cents>=NEW.fee_cents)
    BEGIN SELECT RAISE(ABORT,'balance order identity differs'); END;
  CREATE TRIGGER epay_balance_order_immutable BEFORE UPDATE ON epay_orders
    WHEN EXISTS(SELECT 1 FROM epay_balance_orders b WHERE b.trade_no=OLD.trade_no) AND
      (NEW.trade_no IS NOT OLD.trade_no OR NEW.out_trade_no IS NOT OLD.out_trade_no OR NEW.merchant_id IS NOT OLD.merchant_id
       OR NEW.money_cents IS NOT OLD.money_cents OR NEW.type_code IS NOT OLD.type_code OR NEW.notify_url IS NOT OLD.notify_url OR NEW.return_url IS NOT OLD.return_url OR NEW.name IS NOT OLD.name)
    BEGIN SELECT RAISE(ABORT,'balance order details are immutable'); END;
  CREATE TRIGGER epay_balance_confirmation_identity BEFORE INSERT ON epay_balance_confirmations
    WHEN NOT EXISTS(SELECT 1 FROM epay_orders o JOIN epay_balance_orders b ON b.trade_no=o.trade_no
      WHERE o.trade_no=NEW.trade_no AND o.status='PENDING' AND o.merchant_id=NEW.merchant_id AND o.money_cents=NEW.amount_cents AND b.fee_cents=NEW.fee_cents)
    BEGIN SELECT RAISE(ABORT,'balance confirmation differs from order'); END;

  ${dropFeeTriggers}
  ${feeTable.replaceAll("epay_fee_invoice_requests", "epay_fee_invoice_requests_v3").replace("IN ('wxpay','alipay')", "IN ('wxpay','alipay','balance')")}
  INSERT INTO epay_fee_invoice_requests_v3 SELECT * FROM epay_fee_invoice_requests;
  ${receiptTable.replaceAll("epay_fee_invoice_provider_receipts", "epay_fee_invoice_provider_receipts_v3").replaceAll("epay_fee_invoice_requests", "epay_fee_invoice_requests_v3")}
  INSERT INTO epay_fee_invoice_provider_receipts_v3 SELECT * FROM epay_fee_invoice_provider_receipts;
  DROP TABLE epay_fee_invoice_provider_receipts;
  DROP TABLE epay_fee_invoice_requests;
  ALTER TABLE epay_fee_invoice_requests_v3 RENAME TO epay_fee_invoice_requests;
  ALTER TABLE epay_fee_invoice_provider_receipts_v3 RENAME TO epay_fee_invoice_provider_receipts;
  ${feeGuards.replace(receiptTable, "").replace("UNION ALL SELECT trade_no,merchant_id,fee_cents FROM epay_wechat_confirmations", "UNION ALL SELECT trade_no,merchant_id,fee_cents FROM epay_wechat_confirmations UNION ALL SELECT trade_no,merchant_id,fee_cents FROM epay_balance_confirmations")}
`;
