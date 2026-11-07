export const EPAY_PAYOUT_RECOVERY_SCHEMA_SQL = `
  CREATE TABLE epay_wechat_payout_oauth (
    state_hash TEXT PRIMARY KEY CHECK(length(state_hash)=64), merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    owner_id TEXT NOT NULL, cookie_hash TEXT NOT NULL CHECK(length(cookie_hash)=64), app_id TEXT NOT NULL,
    nonce BLOB NOT NULL CHECK(length(nonce)=12), ciphertext BLOB NOT NULL, authentication_tag BLOB NOT NULL CHECK(length(authentication_tag)=16),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER,
    CHECK(expires_at>created_at AND (consumed_at IS NULL OR consumed_at>=created_at))
  ) STRICT;
  CREATE TRIGGER epay_wechat_payout_oauth_no_delete BEFORE DELETE ON epay_wechat_payout_oauth BEGIN SELECT RAISE(ABORT,'OAuth history is immutable'); END;
  CREATE TRIGGER epay_wechat_payout_oauth_identity BEFORE UPDATE ON epay_wechat_payout_oauth
    WHEN NEW.state_hash IS NOT OLD.state_hash OR NEW.merchant_id IS NOT OLD.merchant_id OR NEW.owner_id IS NOT OLD.owner_id
      OR NEW.cookie_hash IS NOT OLD.cookie_hash OR NEW.app_id IS NOT OLD.app_id OR NEW.nonce IS NOT OLD.nonce OR NEW.ciphertext IS NOT OLD.ciphertext OR NEW.authentication_tag IS NOT OLD.authentication_tag
      OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
    BEGIN SELECT RAISE(ABORT,'OAuth request can only be consumed once'); END;
  CREATE TABLE epay_wechat_payout_identities (
    account_id TEXT PRIMARY KEY REFERENCES epay_payout_accounts(account_id), owner_id TEXT NOT NULL,
    app_id TEXT NOT NULL, state_hash TEXT NOT NULL UNIQUE REFERENCES epay_wechat_payout_oauth(state_hash), verified_at INTEGER NOT NULL
  ) STRICT;
  CREATE TRIGGER epay_wechat_payout_identity_no_update BEFORE UPDATE ON epay_wechat_payout_identities BEGIN SELECT RAISE(ABORT,'recipient identity is immutable'); END;
  CREATE TRIGGER epay_wechat_payout_identity_no_delete BEFORE DELETE ON epay_wechat_payout_identities BEGIN SELECT RAISE(ABORT,'recipient identity is immutable'); END;
  CREATE TABLE epay_wechat_payout_authorizations (
    account_id TEXT NOT NULL REFERENCES epay_payout_accounts(account_id),
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    owner_id TEXT NOT NULL, out_no TEXT PRIMARY KEY CHECK(length(out_no)=32),
    payer TEXT NOT NULL, app_id TEXT NOT NULL, scene_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('REQUESTED','UNKNOWN','WAIT_USER_CONFIRM','TAKING_EFFECT','CLOSED')),
    submitted_at INTEGER, verified_at INTEGER, expires_at INTEGER NOT NULL,
    lease_token TEXT, lease_until INTEGER, nonce BLOB, ciphertext BLOB, authentication_tag BLOB,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
    CHECK((lease_token IS NULL AND lease_until IS NULL) OR (length(lease_token)=36 AND lease_until>updated_at)),
    CHECK((nonce IS NULL AND ciphertext IS NULL AND authentication_tag IS NULL) OR (length(nonce)=12 AND length(ciphertext)>0 AND length(authentication_tag)=16))
  ) STRICT;
  CREATE UNIQUE INDEX epay_wechat_payout_auth_active ON epay_wechat_payout_authorizations(account_id) WHERE state<>'CLOSED';
  CREATE TRIGGER epay_wechat_payout_auth_no_delete BEFORE DELETE ON epay_wechat_payout_authorizations BEGIN SELECT RAISE(ABORT,'authorization history is immutable'); END;
  CREATE TRIGGER epay_wechat_payout_auth_identity BEFORE UPDATE ON epay_wechat_payout_authorizations
    WHEN NEW.account_id IS NOT OLD.account_id OR NEW.merchant_id IS NOT OLD.merchant_id OR NEW.owner_id IS NOT OLD.owner_id
      OR NEW.out_no IS NOT OLD.out_no OR NEW.payer IS NOT OLD.payer OR NEW.app_id IS NOT OLD.app_id OR NEW.scene_id IS NOT OLD.scene_id
      OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.updated_at<OLD.updated_at
      OR (OLD.state='CLOSED' AND NEW.state<>'CLOSED')
    BEGIN SELECT RAISE(ABORT,'invalid authorization transition'); END;
  CREATE TABLE epay_payout_returns (
    settlement_id TEXT PRIMARY KEY REFERENCES epay_payouts(settlement_id),
    channel TEXT NOT NULL, payer TEXT NOT NULL, provider_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK(amount_cents>0), response_sha256 TEXT NOT NULL CHECK(length(response_sha256)=64),
    observed_at INTEGER NOT NULL, posted_at INTEGER NOT NULL, entry_id TEXT NOT NULL UNIQUE REFERENCES epay_balance_ledger(entry_id),
    UNIQUE(channel,payer,provider_id)
  ) STRICT;
  CREATE TRIGGER epay_payout_returns_no_update BEFORE UPDATE ON epay_payout_returns BEGIN SELECT RAISE(ABORT,'payout return is immutable'); END;
  CREATE TRIGGER epay_payout_returns_no_delete BEFORE DELETE ON epay_payout_returns BEGIN SELECT RAISE(ABORT,'payout return is immutable'); END;
  CREATE TABLE epay_payout_reconciliations (
    run_id TEXT PRIMARY KEY, business_day TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
    status TEXT NOT NULL CHECK(status IN ('RUNNING','COMPLETE','ATTENTION')),
    expected_count INTEGER NOT NULL CHECK(expected_count>=0), checked_count INTEGER NOT NULL DEFAULT 0,
    issue_count INTEGER NOT NULL DEFAULT 0, scope TEXT NOT NULL CHECK(scope='known_payout_queries'), statement_matched INTEGER NOT NULL DEFAULT 0 CHECK(statement_matched=0)
  ) STRICT;
  CREATE TABLE epay_payout_reconciliation_rows (
    run_id TEXT NOT NULL REFERENCES epay_payout_reconciliations(run_id), settlement_id TEXT NOT NULL REFERENCES epay_payouts(settlement_id),
    status TEXT NOT NULL, issue TEXT, response_sha256 TEXT, observed_at INTEGER NOT NULL,
    PRIMARY KEY(run_id,settlement_id)
  ) STRICT;
  CREATE TRIGGER epay_payout_reconcile_rows_no_update BEFORE UPDATE ON epay_payout_reconciliation_rows BEGIN SELECT RAISE(ABORT,'reconciliation evidence is immutable'); END;
  CREATE TRIGGER epay_payout_reconcile_rows_no_delete BEFORE DELETE ON epay_payout_reconciliation_rows BEGIN SELECT RAISE(ABORT,'reconciliation evidence is immutable'); END;
  CREATE TABLE epay_payout_statements (
    statement_id TEXT PRIMARY KEY, business_day TEXT NOT NULL, channel TEXT NOT NULL, payer TEXT NOT NULL,
    source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64), normalized_sha256 TEXT NOT NULL CHECK(length(normalized_sha256)=64),
    actor_id TEXT NOT NULL, imported_at INTEGER NOT NULL, row_count INTEGER NOT NULL, issue_count INTEGER NOT NULL,
    UNIQUE(business_day,channel,payer,source_sha256)
  ) STRICT;
  CREATE TABLE epay_payout_statement_rows (
    statement_id TEXT NOT NULL REFERENCES epay_payout_statements(statement_id), ordinal INTEGER NOT NULL,
    settlement_id TEXT REFERENCES epay_payouts(settlement_id), entry_reference TEXT NOT NULL, kind TEXT NOT NULL,
    amount_cents INTEGER NOT NULL, issue TEXT, PRIMARY KEY(statement_id,ordinal)
  ) STRICT;
  CREATE TRIGGER epay_payout_statements_no_update BEFORE UPDATE ON epay_payout_statements BEGIN SELECT RAISE(ABORT,'statement evidence is immutable'); END;
  CREATE TRIGGER epay_payout_statements_no_delete BEFORE DELETE ON epay_payout_statements BEGIN SELECT RAISE(ABORT,'statement evidence is immutable'); END;
  CREATE TRIGGER epay_payout_statement_rows_no_update BEFORE UPDATE ON epay_payout_statement_rows BEGIN SELECT RAISE(ABORT,'statement evidence is immutable'); END;
  CREATE TRIGGER epay_payout_statement_rows_no_delete BEFORE DELETE ON epay_payout_statement_rows BEGIN SELECT RAISE(ABORT,'statement evidence is immutable'); END;
`;
