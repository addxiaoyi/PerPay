export const EPAY_MERCHANT_KEY_SCHEMA_SQL = `
  CREATE TABLE epay_merchant_key_versions (
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    secret_version INTEGER NOT NULL CHECK(secret_version>=1),
    cipher_version INTEGER NOT NULL CHECK(cipher_version=1),
    nonce BLOB NOT NULL CHECK(length(nonce)=12),
    ciphertext BLOB NOT NULL CHECK(length(ciphertext)>0),
    authentication_tag BLOB NOT NULL CHECK(length(authentication_tag)=16),
    secret_fingerprint TEXT NOT NULL CHECK(length(secret_fingerprint)=64),
    created_at INTEGER NOT NULL CHECK(created_at>=0),
    PRIMARY KEY(merchant_id,secret_version)
  ) STRICT;
  INSERT INTO epay_merchant_key_versions SELECT merchant_id,secret_version,cipher_version,nonce,ciphertext,authentication_tag,secret_fingerprint,updated_at FROM epay_merchant_secrets;
  CREATE TABLE epay_order_key_versions (
    trade_no TEXT PRIMARY KEY REFERENCES epay_orders(trade_no),
    merchant_id INTEGER NOT NULL,
    secret_version INTEGER NOT NULL,
    FOREIGN KEY(merchant_id,secret_version) REFERENCES epay_merchant_key_versions(merchant_id,secret_version)
  ) STRICT;
  INSERT INTO epay_order_key_versions
    SELECT o.trade_no,o.merchant_id,s.secret_version FROM epay_orders o JOIN epay_merchant_secrets s ON s.merchant_id=o.merchant_id
    WHERE EXISTS(SELECT 1 FROM epay_alipay_intents i WHERE i.trade_no=o.trade_no) OR EXISTS(SELECT 1 FROM epay_wechat_intents i WHERE i.trade_no=o.trade_no);
  CREATE TRIGGER epay_order_key_identity BEFORE INSERT ON epay_order_key_versions
    WHEN NOT EXISTS(SELECT 1 FROM epay_orders o WHERE o.trade_no=NEW.trade_no AND o.merchant_id=NEW.merchant_id)
    BEGIN SELECT RAISE(ABORT,'order key merchant differs'); END;
  CREATE TRIGGER epay_order_keys_no_update BEFORE UPDATE ON epay_order_key_versions BEGIN SELECT RAISE(ABORT,'order signing key is immutable'); END;
  CREATE TRIGGER epay_order_keys_no_delete BEFORE DELETE ON epay_order_key_versions BEGIN SELECT RAISE(ABORT,'order signing key is immutable'); END;
  CREATE TRIGGER epay_merchant_key_history_no_update BEFORE UPDATE ON epay_merchant_key_versions BEGIN SELECT RAISE(ABORT,'merchant key history is immutable'); END;
  CREATE TRIGGER epay_merchant_key_history_no_delete BEFORE DELETE ON epay_merchant_key_versions BEGIN SELECT RAISE(ABORT,'merchant key history is immutable'); END;
  CREATE TABLE epay_merchant_key_rotations (
    merchant_id INTEGER NOT NULL,
    request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 16 AND 80),
    actor_id TEXT NOT NULL,
    previous_version INTEGER NOT NULL,
    next_version INTEGER NOT NULL CHECK(next_version=previous_version+1),
    occurred_at INTEGER NOT NULL CHECK(occurred_at>=0),
    PRIMARY KEY(merchant_id,request_id),
    FOREIGN KEY(merchant_id,next_version) REFERENCES epay_merchant_key_versions(merchant_id,secret_version)
  ) STRICT;
  CREATE TRIGGER epay_key_rotations_no_update BEFORE UPDATE ON epay_merchant_key_rotations BEGIN SELECT RAISE(ABORT,'key rotation is immutable'); END;
  CREATE TRIGGER epay_key_rotations_no_delete BEFORE DELETE ON epay_merchant_key_rotations BEGIN SELECT RAISE(ABORT,'key rotation is immutable'); END;
`;
