// Persist channel identity and submission fences across ordinary application restarts.
export const ALIPAY_SUBMISSION_SCHEMA_SQL = `
  CREATE TABLE epay_alipay_bindings (
    client_id TEXT PRIMARY KEY REFERENCES sites(client_id),
    app_id TEXT NOT NULL, seller_id TEXT NOT NULL, platform_public_key TEXT NOT NULL,
    signing_key_fingerprint TEXT NOT NULL CHECK(length(signing_key_fingerprint)=64 AND signing_key_fingerprint NOT GLOB '*[^0-9a-f]*')
  ) STRICT;
  CREATE TRIGGER epay_alipay_bindings_no_update BEFORE UPDATE ON epay_alipay_bindings BEGIN SELECT RAISE(ABORT,'Alipay binding is immutable'); END;
  CREATE TRIGGER epay_alipay_bindings_no_delete BEFORE DELETE ON epay_alipay_bindings BEGIN SELECT RAISE(ABORT,'Alipay binding is immutable'); END;
  CREATE TABLE epay_alipay_orders (
    trade_no TEXT PRIMARY KEY REFERENCES epay_alipay_intents(trade_no),
    client_id TEXT NOT NULL REFERENCES epay_alipay_bindings(client_id)
  ) STRICT;
  CREATE TRIGGER epay_alipay_orders_no_update BEFORE UPDATE ON epay_alipay_orders BEGIN SELECT RAISE(ABORT,'Alipay order binding is immutable'); END;
  CREATE TRIGGER epay_alipay_orders_no_delete BEFORE DELETE ON epay_alipay_orders BEGIN SELECT RAISE(ABORT,'Alipay order binding is immutable'); END;
  CREATE TABLE epay_alipay_requests (
    trade_no TEXT PRIMARY KEY REFERENCES epay_alipay_orders(trade_no),
    request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64),
    fee_rate_bps INTEGER NOT NULL CHECK(fee_rate_bps BETWEEN 0 AND 5000)
  ) STRICT;
  CREATE TRIGGER epay_alipay_requests_no_update BEFORE UPDATE ON epay_alipay_requests BEGIN SELECT RAISE(ABORT,'Alipay request is immutable'); END;
  CREATE TRIGGER epay_alipay_requests_no_delete BEFORE DELETE ON epay_alipay_requests BEGIN SELECT RAISE(ABORT,'Alipay request is immutable'); END;
  CREATE TABLE epay_alipay_submissions (
    trade_no TEXT PRIMARY KEY REFERENCES epay_alipay_orders(trade_no),
    attempt_id TEXT NOT NULL UNIQUE CHECK(length(attempt_id)=36),
    state TEXT NOT NULL CHECK(state IN ('IN_FLIGHT','UNCERTAIN','SETTLED')),
    lease_token TEXT CHECK(lease_token IS NULL OR length(lease_token)=36),
    lease_until INTEGER,
    started_at INTEGER NOT NULL CHECK(started_at>=0),
    updated_at INTEGER NOT NULL CHECK(updated_at>=started_at),
    CHECK((state='IN_FLIGHT' AND lease_token IS NOT NULL AND lease_until>started_at) OR (state IN ('UNCERTAIN','SETTLED') AND lease_token IS NULL AND lease_until IS NULL))
  ) STRICT;
  CREATE TRIGGER epay_alipay_submissions_no_delete BEFORE DELETE ON epay_alipay_submissions BEGIN SELECT RAISE(ABORT,'Alipay submission is immutable'); END;
  CREATE TRIGGER epay_alipay_submissions_transition BEFORE UPDATE ON epay_alipay_submissions
    WHEN NEW.trade_no<>OLD.trade_no OR NEW.attempt_id<>OLD.attempt_id OR NEW.started_at<>OLD.started_at OR NEW.updated_at<OLD.updated_at OR NOT ((OLD.state='IN_FLIGHT' AND NEW.state IN ('UNCERTAIN','SETTLED')) OR (OLD.state='UNCERTAIN' AND NEW.state='SETTLED'))
    BEGIN SELECT RAISE(ABORT,'invalid Alipay submission transition'); END;
  CREATE TABLE epay_alipay_prepay (
    trade_no TEXT PRIMARY KEY REFERENCES epay_alipay_submissions(trade_no),
    attempt_id TEXT NOT NULL UNIQUE,
    nonce BLOB NOT NULL CHECK(length(nonce)=12),
    ciphertext BLOB NOT NULL CHECK(length(ciphertext)>0),
    authentication_tag BLOB NOT NULL CHECK(length(authentication_tag)=16),
    received_at INTEGER NOT NULL CHECK(received_at>=0)
  ) STRICT;
  CREATE TRIGGER epay_alipay_prepay_no_update BEFORE UPDATE ON epay_alipay_prepay BEGIN SELECT RAISE(ABORT,'Alipay prepay result is immutable'); END;
  CREATE TRIGGER epay_alipay_prepay_no_delete BEFORE DELETE ON epay_alipay_prepay BEGIN SELECT RAISE(ABORT,'Alipay prepay result is immutable'); END;
`;
