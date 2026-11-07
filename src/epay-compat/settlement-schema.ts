export const EPAY_SETTLEMENT_SCHEMA_SQL = `
  CREATE TABLE epay_native_settlements (
    settlement_id TEXT PRIMARY KEY CHECK(length(settlement_id)=36),
    request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 16 AND 80),
    merchant_id INTEGER NOT NULL REFERENCES epay_balance_openings(merchant_id),
    amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 9007199254740991),
    note TEXT NOT NULL CHECK(length(note)<=300),
    status TEXT NOT NULL CHECK(status IN ('PENDING','PAID','REJECTED')),
    created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 128),
    reviewed_by TEXT,
    reference TEXT CHECK(reference IS NULL OR length(reference)<=200),
    created_at INTEGER NOT NULL CHECK(created_at>=0),
    reviewed_at INTEGER CHECK(reviewed_at IS NULL OR reviewed_at>=created_at),
    UNIQUE(merchant_id,request_id),
    CHECK((status='PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL AND reference IS NULL) OR
      (status<>'PENDING' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
    CHECK(status<>'PAID' OR length(reference)>0)
  ) STRICT;
  CREATE INDEX epay_native_settlements_merchant ON epay_native_settlements(merchant_id,created_at DESC,settlement_id);
  CREATE TRIGGER epay_native_settlements_no_delete BEFORE DELETE ON epay_native_settlements
    BEGIN SELECT RAISE(ABORT,'settlement history is immutable'); END;
  CREATE TRIGGER epay_native_settlements_immutable BEFORE UPDATE ON epay_native_settlements
    WHEN NEW.settlement_id IS NOT OLD.settlement_id OR NEW.request_id IS NOT OLD.request_id OR
      NEW.merchant_id IS NOT OLD.merchant_id OR NEW.amount_cents IS NOT OLD.amount_cents OR NEW.note IS NOT OLD.note OR
      NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at OR OLD.status<>'PENDING' OR
      NEW.status NOT IN ('PAID','REJECTED')
    BEGIN SELECT RAISE(ABORT,'settlement identity or terminal state is immutable'); END;
`;
