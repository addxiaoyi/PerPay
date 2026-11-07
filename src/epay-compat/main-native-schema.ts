export const MAIN_NATIVE_ORDER_SCHEMA = `
  ALTER TABLE epay_callback_attempts ADD COLUMN wire_format TEXT
    CHECK(wire_format IN ('epay_form','epay_query','main_form','main_json'));
  CREATE TABLE epay_main_native_orders (
    trade_no TEXT PRIMARY KEY REFERENCES epay_orders(trade_no),
    order_id TEXT NOT NULL UNIQUE CHECK(length(order_id)=36),
    main_merchant_id TEXT NOT NULL REFERENCES epay_merchant_bindings(main_merchant_id),
    main_api_id TEXT NOT NULL CHECK(length(main_api_id) BETWEEN 1 AND 80),
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    channel TEXT NOT NULL CHECK(channel IN ('alipay_scan','wechat_native')),
    callback_protocol TEXT NOT NULL CHECK(callback_protocol='main_form_hmac_v1'),
    request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64),
    callback_id TEXT NOT NULL UNIQUE CHECK(length(callback_id)=36),
    nonce BLOB NOT NULL CHECK(length(nonce)=12),
    ciphertext BLOB NOT NULL CHECK(length(ciphertext)>0),
    authentication_tag BLOB NOT NULL CHECK(length(authentication_tag)=16),
    created_at INTEGER NOT NULL CHECK(created_at>=0)
  ) STRICT;
  CREATE INDEX epay_main_native_merchant ON epay_main_native_orders(main_merchant_id,created_at);
  CREATE TRIGGER epay_main_native_no_update BEFORE UPDATE ON epay_main_native_orders
    BEGIN SELECT RAISE(ABORT,'main order contract is immutable'); END;
  CREATE TRIGGER epay_main_native_no_delete BEFORE DELETE ON epay_main_native_orders
    BEGIN SELECT RAISE(ABORT,'main order contract is immutable'); END;
  CREATE TRIGGER epay_main_native_identity BEFORE INSERT ON epay_main_native_orders
    WHEN NOT EXISTS (SELECT 1 FROM epay_orders o JOIN epay_merchant_bindings b ON b.epay_merchant_id=o.merchant_id
      WHERE o.trade_no=NEW.trade_no AND o.merchant_id=NEW.merchant_id AND b.main_merchant_id=NEW.main_merchant_id
      AND b.main_api_id=NEW.main_api_id AND o.type_code=CASE NEW.channel WHEN 'alipay_scan' THEN 'alipay' ELSE 'wxpay' END)
    BEGIN SELECT RAISE(ABORT,'main order binding mismatch'); END;
`;
