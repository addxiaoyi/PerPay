export const EPAY_LIVE_BALANCE_SCHEMA_SQL = `
  CREATE TABLE epay_balance_openings (
    merchant_id INTEGER PRIMARY KEY REFERENCES epay_merchant_accounts(merchant_id),
    snapshot_id TEXT NOT NULL CHECK(length(snapshot_id) BETWEEN 1 AND 128),
    available_cents INTEGER NOT NULL CHECK(available_cents BETWEEN -9007199254740991 AND 9007199254740991),
    frozen_cents INTEGER NOT NULL CHECK(frozen_cents BETWEEN -9007199254740991 AND 9007199254740991),
    historical_extra_cents INTEGER NOT NULL CHECK(historical_extra_cents BETWEEN -9007199254740991 AND 9007199254740991),
    source_report_sha256 TEXT NOT NULL CHECK(length(source_report_sha256)=64),
    plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64),
    opened_at INTEGER NOT NULL CHECK(opened_at BETWEEN 0 AND 9007199254740991)
  ) STRICT;
  CREATE TABLE epay_live_balances (
    merchant_id INTEGER PRIMARY KEY REFERENCES epay_balance_openings(merchant_id),
    available_cents INTEGER NOT NULL CHECK(available_cents BETWEEN -9007199254740991 AND 9007199254740991),
    frozen_cents INTEGER NOT NULL CHECK(frozen_cents BETWEEN -9007199254740991 AND 9007199254740991),
    version INTEGER NOT NULL CHECK(version BETWEEN 0 AND 9007199254740991)
  ) STRICT;
  CREATE TABLE epay_balance_adjustments (
    request_id TEXT PRIMARY KEY CHECK(length(request_id) BETWEEN 16 AND 80),
    entry_id TEXT NOT NULL UNIQUE REFERENCES epay_balance_ledger(entry_id),
    merchant_id INTEGER NOT NULL REFERENCES epay_live_balances(merchant_id),
    actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 128),
    reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 512),
    delta_cents INTEGER NOT NULL CHECK(delta_cents BETWEEN -9007199254740991 AND 9007199254740991 AND delta_cents<>0),
    expected_version INTEGER NOT NULL CHECK(expected_version BETWEEN 0 AND 9007199254740991),
    balance_after_cents INTEGER NOT NULL CHECK(balance_after_cents BETWEEN -9007199254740991 AND 9007199254740991),
    created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991)
  ) STRICT;
  CREATE TRIGGER epay_balance_openings_no_update BEFORE UPDATE ON epay_balance_openings BEGIN SELECT RAISE(ABORT,'balance opening is immutable'); END;
  CREATE TRIGGER epay_balance_openings_no_delete BEFORE DELETE ON epay_balance_openings BEGIN SELECT RAISE(ABORT,'balance opening is immutable'); END;
  CREATE TRIGGER epay_live_balances_no_delete BEFORE DELETE ON epay_live_balances BEGIN SELECT RAISE(ABORT,'live balance cannot be deleted'); END;
  CREATE TRIGGER epay_adjustments_no_update BEFORE UPDATE ON epay_balance_adjustments BEGIN SELECT RAISE(ABORT,'balance adjustment is immutable'); END;
  CREATE TRIGGER epay_adjustments_no_delete BEFORE DELETE ON epay_balance_adjustments BEGIN SELECT RAISE(ABORT,'balance adjustment is immutable'); END;
  CREATE TRIGGER epay_opened_ledger_no_update BEFORE UPDATE ON epay_balance_ledger
    WHEN EXISTS(SELECT 1 FROM epay_balance_openings WHERE merchant_id IN (OLD.merchant_id,NEW.merchant_id))
    BEGIN SELECT RAISE(ABORT,'opened merchant ledger is immutable'); END;
  CREATE TRIGGER epay_opened_ledger_no_delete BEFORE DELETE ON epay_balance_ledger
    WHEN EXISTS(SELECT 1 FROM epay_balance_openings WHERE merchant_id=OLD.merchant_id)
    BEGIN SELECT RAISE(ABORT,'opened merchant ledger is immutable'); END;
  CREATE TRIGGER epay_post_live_balance AFTER INSERT ON epay_balance_ledger
    WHEN EXISTS(SELECT 1 FROM epay_balance_openings WHERE merchant_id=NEW.merchant_id)
    BEGIN
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM epay_live_balances WHERE merchant_id=NEW.merchant_id)
        THEN RAISE(ABORT,'live merchant balance is missing') END;
      SELECT CASE WHEN NEW.occurred_at<(SELECT opened_at FROM epay_balance_openings WHERE merchant_id=NEW.merchant_id)
        THEN RAISE(ABORT,'ledger posting predates opening') END;
      UPDATE epay_live_balances SET available_cents=available_cents+NEW.available_delta_cents,
        frozen_cents=frozen_cents+NEW.frozen_delta_cents,version=version+1 WHERE merchant_id=NEW.merchant_id;
    END;
`;
