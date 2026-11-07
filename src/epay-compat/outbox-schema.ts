export const EPAY_OUTBOX_SCHEMA_SQL = `
  CREATE TABLE epay_callback_jobs (
    trade_no TEXT PRIMARY KEY REFERENCES epay_orders(trade_no),
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'LEASED', 'SUCCEEDED', 'FAILED')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
    lease_token TEXT,
    lease_until INTEGER,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    CHECK ((status = 'LEASED' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR
           (status != 'LEASED' AND lease_token IS NULL AND lease_until IS NULL))
  ) STRICT;
  CREATE INDEX epay_callback_jobs_due_idx ON epay_callback_jobs(status, next_attempt_at);
  CREATE TABLE epay_callback_attempts (
    attempt_id TEXT PRIMARY KEY,
    trade_no TEXT NOT NULL REFERENCES epay_callback_jobs(trade_no),
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    outcome TEXT NOT NULL CHECK (outcome IN ('STARTED', 'SUCCESS', 'RETRY', 'FAILED', 'EXPIRED')),
    http_status INTEGER CHECK (http_status BETWEEN 100 AND 599),
    error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 64),
    UNIQUE(trade_no, attempt_number)
  ) STRICT;
`;
