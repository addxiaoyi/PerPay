export const EPAY_CONFIRMATION_SCHEMA_SQL = `
  CREATE TABLE epay_alipay_intents (
    trade_no TEXT PRIMARY KEY REFERENCES epay_orders(trade_no),
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    app_id TEXT NOT NULL CHECK(length(app_id) BETWEEN 1 AND 128),
    seller_id TEXT NOT NULL CHECK(length(seller_id) BETWEEN 1 AND 128),
    platform_public_key TEXT NOT NULL CHECK(length(platform_public_key) BETWEEN 1 AND 8192),
    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
    fee_cents INTEGER NOT NULL CHECK(fee_cents >= 0 AND fee_cents <= amount_cents),
    created_at INTEGER NOT NULL CHECK(created_at >= 0)
  ) STRICT;
  CREATE TRIGGER epay_alipay_intents_immutable_update BEFORE UPDATE ON epay_alipay_intents
    BEGIN SELECT RAISE(ABORT, 'payment intent is immutable'); END;
  CREATE TRIGGER epay_alipay_intents_immutable_delete BEFORE DELETE ON epay_alipay_intents
    BEGIN SELECT RAISE(ABORT, 'payment intent is immutable'); END;

  CREATE TABLE epay_alipay_confirmations (
    trade_no TEXT PRIMARY KEY REFERENCES epay_alipay_intents(trade_no),
    provider_trade_no TEXT NOT NULL UNIQUE CHECK(length(provider_trade_no) BETWEEN 1 AND 128),
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
    fee_cents INTEGER NOT NULL CHECK(fee_cents >= 0 AND fee_cents <= amount_cents),
    confirmed_at INTEGER NOT NULL CHECK(confirmed_at >= 0)
  ) STRICT;
  CREATE TRIGGER epay_alipay_confirmations_immutable_update BEFORE UPDATE ON epay_alipay_confirmations
    BEGIN SELECT RAISE(ABORT, 'payment confirmation is immutable'); END;
  CREATE TRIGGER epay_alipay_confirmations_immutable_delete BEFORE DELETE ON epay_alipay_confirmations
    BEGIN SELECT RAISE(ABORT, 'payment confirmation is immutable'); END;
`;
