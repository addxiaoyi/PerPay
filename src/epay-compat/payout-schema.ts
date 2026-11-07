export const EPAY_PAYOUT_SCHEMA_SQL = `
  CREATE TABLE epay_payout_accounts (
    account_id TEXT PRIMARY KEY CHECK(length(account_id)=36),
    request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 16 AND 80),
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    kind TEXT NOT NULL CHECK(kind IN ('bank','alipay','wechat')),
    masked_label TEXT NOT NULL, nonce BLOB NOT NULL CHECK(length(nonce)=12),
    ciphertext BLOB NOT NULL CHECK(length(ciphertext)>0), authentication_tag BLOB NOT NULL CHECK(length(authentication_tag)=16),
    status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED','REVOKED')),
    created_by TEXT NOT NULL, created_at INTEGER NOT NULL CHECK(created_at>=0),
    reviewed_by TEXT, reviewed_at INTEGER, review_reference TEXT,
    UNIQUE(merchant_id,request_id),
    CHECK((status='PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_reference IS NULL) OR
      (status<>'PENDING' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND review_reference IS NOT NULL AND length(reviewed_by)>0 AND reviewed_at>=created_at AND length(review_reference)>0))
  ) STRICT;
  CREATE INDEX epay_payout_accounts_merchant ON epay_payout_accounts(merchant_id,created_at,account_id);
  CREATE TRIGGER epay_payout_accounts_no_delete BEFORE DELETE ON epay_payout_accounts BEGIN SELECT RAISE(ABORT,'payout account history is immutable'); END;
  CREATE TRIGGER epay_payout_accounts_immutable BEFORE UPDATE ON epay_payout_accounts
    WHEN NEW.account_id IS NOT OLD.account_id OR NEW.request_id IS NOT OLD.request_id OR NEW.merchant_id IS NOT OLD.merchant_id
      OR NEW.kind IS NOT OLD.kind OR NEW.masked_label IS NOT OLD.masked_label OR NEW.nonce IS NOT OLD.nonce
      OR NEW.ciphertext IS NOT OLD.ciphertext OR NEW.authentication_tag IS NOT OLD.authentication_tag
      OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
      OR NOT ((OLD.status='PENDING' AND NEW.status IN ('APPROVED','REJECTED')) OR (OLD.status='APPROVED' AND NEW.status='REVOKED'))
    BEGIN SELECT RAISE(ABORT,'invalid payout account transition'); END;
  CREATE TABLE epay_payouts (
    settlement_id TEXT PRIMARY KEY REFERENCES epay_native_settlements(settlement_id),
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    account_id TEXT NOT NULL REFERENCES epay_payout_accounts(account_id),
    channel TEXT NOT NULL CHECK(channel IN ('bank','alipay','wechat')),
    out_no TEXT NOT NULL UNIQUE CHECK(length(out_no)=32 AND out_no NOT GLOB '*[^a-f0-9]*'),
    amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 9007199254740991),
    status TEXT NOT NULL CHECK(status IN ('PENDING','READY','UNKNOWN','PROCESSING','WAIT_USER_CONFIRM','SUCCEEDED','FAILED','REJECTED')),
    payer TEXT, approved_by TEXT, approved_at INTEGER, approval_reference TEXT,
    submitted_at INTEGER, provider_id TEXT, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
    lease_token TEXT, lease_until INTEGER, next_at INTEGER NOT NULL,
    last_error TEXT, response_sha256 TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
    CHECK((lease_token IS NULL AND lease_until IS NULL) OR (length(lease_token)=36 AND lease_until>updated_at)),
    CHECK(status IN ('PENDING','REJECTED') OR (payer IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND length(payer)>0 AND length(approved_by)>0 AND approved_at>=created_at)),
    CHECK(submitted_at IS NULL OR submitted_at>=created_at),
    CHECK(lease_token IS NULL OR (status='UNKNOWN' AND submitted_at IS NOT NULL)),
    CHECK(status NOT IN ('SUCCEEDED','FAILED') OR (provider_id IS NOT NULL AND response_sha256 IS NOT NULL AND length(provider_id)>0 AND length(response_sha256)=64))
  ) STRICT;
  CREATE INDEX epay_payouts_due ON epay_payouts(status,next_at,lease_until);
  CREATE INDEX epay_payouts_limits ON epay_payouts(channel,payer,approved_at);
  CREATE UNIQUE INDEX epay_payouts_provider ON epay_payouts(channel,payer,provider_id) WHERE provider_id IS NOT NULL;
  CREATE TRIGGER epay_payouts_no_delete BEFORE DELETE ON epay_payouts BEGIN SELECT RAISE(ABORT,'payout history is immutable'); END;
  CREATE TRIGGER epay_payouts_identity BEFORE UPDATE ON epay_payouts
    WHEN NEW.settlement_id IS NOT OLD.settlement_id OR NEW.merchant_id IS NOT OLD.merchant_id OR NEW.account_id IS NOT OLD.account_id
      OR NEW.channel IS NOT OLD.channel OR NEW.out_no IS NOT OLD.out_no OR NEW.amount_cents IS NOT OLD.amount_cents OR NEW.created_at IS NOT OLD.created_at
      OR NEW.updated_at<OLD.updated_at OR OLD.status IN ('SUCCEEDED','FAILED','REJECTED')
      OR (OLD.payer IS NOT NULL AND NEW.payer IS NOT OLD.payer)
      OR (OLD.approved_by IS NOT NULL AND (NEW.approved_by IS NOT OLD.approved_by OR NEW.approved_at IS NOT OLD.approved_at OR NEW.approval_reference IS NOT OLD.approval_reference))
      OR (OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS NOT OLD.submitted_at)
      OR (OLD.provider_id IS NOT NULL AND NEW.provider_id IS NOT OLD.provider_id)
      OR NOT ((OLD.status='PENDING' AND NEW.status IN ('READY','REJECTED')) OR (OLD.status='READY' AND NEW.status IN ('UNKNOWN','REJECTED')) OR
        (OLD.status IN ('UNKNOWN','PROCESSING','WAIT_USER_CONFIRM') AND NEW.status IN ('UNKNOWN','PROCESSING','WAIT_USER_CONFIRM','SUCCEEDED','FAILED')))
    BEGIN SELECT RAISE(ABORT,'payout identity or terminal state is immutable'); END;
  CREATE TABLE epay_payout_attempts (
    token TEXT PRIMARY KEY CHECK(length(token)=36), settlement_id TEXT NOT NULL REFERENCES epay_payouts(settlement_id),
    action TEXT NOT NULL CHECK(action IN ('SUBMIT','QUERY')), started_at INTEGER NOT NULL,
    finished_at INTEGER, outcome TEXT NOT NULL CHECK(outcome IN ('STARTED','EXPIRED','UNKNOWN','PROCESSING','WAIT_USER_CONFIRM','SUCCEEDED','FAILED')),
    error_code TEXT, response_sha256 TEXT,
    CHECK(finished_at IS NULL OR finished_at>=started_at)
  ) STRICT;
  CREATE TRIGGER epay_payout_attempts_no_delete BEFORE DELETE ON epay_payout_attempts BEGIN SELECT RAISE(ABORT,'payout attempt history is immutable'); END;
  CREATE TRIGGER epay_payout_attempts_immutable BEFORE UPDATE ON epay_payout_attempts
    WHEN OLD.outcome<>'STARTED' OR NEW.token IS NOT OLD.token OR NEW.settlement_id IS NOT OLD.settlement_id
      OR NEW.action IS NOT OLD.action OR NEW.started_at IS NOT OLD.started_at OR NEW.outcome='STARTED'
    BEGIN SELECT RAISE(ABORT,'payout attempt is immutable'); END;
`;
