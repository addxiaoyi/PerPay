export const TOPUP_SCHEMA_SQL = `
  CREATE TABLE epay_balance_topups (
    trade_no TEXT PRIMARY KEY REFERENCES epay_orders(trade_no),merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    request_id TEXT NOT NULL,actor_id TEXT NOT NULL,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),created_at INTEGER NOT NULL CHECK(created_at>=0),
    UNIQUE(merchant_id,request_id)
  ) STRICT;
  CREATE TRIGGER epay_balance_topup_identity BEFORE INSERT ON epay_balance_topups
    WHEN NOT EXISTS(SELECT 1 FROM epay_orders o WHERE o.trade_no=NEW.trade_no AND o.merchant_id=NEW.merchant_id AND o.money_cents=NEW.amount_cents AND o.status='PENDING')
    BEGIN SELECT RAISE(ABORT,'topup differs from owned order'); END;
  CREATE TRIGGER epay_balance_topup_immutable BEFORE UPDATE ON epay_balance_topups BEGIN SELECT RAISE(ABORT,'topup is immutable'); END;
  CREATE TRIGGER epay_balance_topup_no_delete BEFORE DELETE ON epay_balance_topups BEGIN SELECT RAISE(ABORT,'topup history is immutable'); END;
`;
