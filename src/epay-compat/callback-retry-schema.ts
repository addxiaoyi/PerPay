export const EPAY_CALLBACK_RETRY_SCHEMA_SQL = `
  ALTER TABLE epay_callback_jobs ADD COLUMN retry_base_attempts INTEGER NOT NULL DEFAULT 0 CHECK(retry_base_attempts>=0 AND retry_base_attempts<=attempts);
  ALTER TABLE epay_callback_jobs ADD COLUMN retry_base_gets INTEGER NOT NULL DEFAULT 0 CHECK(retry_base_gets>=0);
  CREATE TABLE epay_callback_retries (
    request_id TEXT NOT NULL,
    trade_no TEXT NOT NULL REFERENCES epay_callback_jobs(trade_no),
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    actor_id TEXT NOT NULL,
    base_attempts INTEGER NOT NULL CHECK(base_attempts>=0),
    base_gets INTEGER NOT NULL CHECK(base_gets>=0),
    requested_at INTEGER NOT NULL CHECK(requested_at>=0),
    PRIMARY KEY(trade_no,request_id)
  ) STRICT;
  CREATE TRIGGER epay_callback_retries_no_update BEFORE UPDATE ON epay_callback_retries BEGIN SELECT RAISE(ABORT,'callback retry history is immutable'); END;
  CREATE TRIGGER epay_callback_retries_no_delete BEFORE DELETE ON epay_callback_retries BEGIN SELECT RAISE(ABORT,'callback retry history is immutable'); END;
`;
