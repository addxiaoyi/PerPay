export const ALIPAY_WEB_SCHEMA_SQL = `
  CREATE TABLE epay_alipay_web_orders (
    trade_no TEXT PRIMARY KEY REFERENCES epay_alipay_intents(trade_no),
    product TEXT NOT NULL CHECK(product IN ('pc','wap')),
    created_at INTEGER NOT NULL CHECK(created_at>=0)
  ) STRICT;
  CREATE TABLE epay_alipay_web_links (
    trade_no TEXT PRIMARY KEY REFERENCES epay_alipay_web_orders(trade_no),
    attempt_id TEXT NOT NULL UNIQUE,
    nonce BLOB NOT NULL CHECK(length(nonce)=12),
    ciphertext BLOB NOT NULL CHECK(length(ciphertext)>0),
    authentication_tag BLOB NOT NULL CHECK(length(authentication_tag)=16),
    created_at INTEGER NOT NULL CHECK(created_at>=0)
  ) STRICT;
  CREATE TRIGGER epay_alipay_web_mode_no_update BEFORE UPDATE ON epay_alipay_web_orders BEGIN SELECT RAISE(ABORT,'Alipay web mode is immutable'); END;
  CREATE TRIGGER epay_alipay_web_mode_no_delete BEFORE DELETE ON epay_alipay_web_orders BEGIN SELECT RAISE(ABORT,'Alipay web mode is immutable'); END;
  CREATE TRIGGER epay_alipay_web_link_no_update BEFORE UPDATE ON epay_alipay_web_links BEGIN SELECT RAISE(ABORT,'Alipay web link is immutable'); END;
  CREATE TRIGGER epay_alipay_web_link_no_delete BEFORE DELETE ON epay_alipay_web_links BEGIN SELECT RAISE(ABORT,'Alipay web link is immutable'); END;
`;
