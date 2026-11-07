export const EPAY_REFUND_SCHEMA_SQL = `
  CREATE TABLE epay_native_refunds (
    refund_no TEXT PRIMARY KEY CHECK(length(refund_no) BETWEEN 16 AND 64),
    request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 16 AND 80),
    trade_no TEXT NOT NULL REFERENCES epay_orders(trade_no),
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    provider TEXT NOT NULL CHECK(provider IN ('alipay','wxpay')),
    provider_account TEXT NOT NULL,
    provider_trade_no TEXT NOT NULL,
    total_cents INTEGER NOT NULL CHECK(total_cents BETWEEN 1 AND 9007199254740991),
    amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND total_cents),
    debit_cents INTEGER NOT NULL CHECK(debit_cents BETWEEN 0 AND amount_cents),
    reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 300),
    requested_by TEXT NOT NULL,
    approved_by TEXT,
    status TEXT NOT NULL CHECK(status IN ('REQUESTED','READY','PROCESSING','UNKNOWN','SUCCEEDED','REJECTED','CLOSED')),
    provider_refund_no TEXT,
    submitted_at INTEGER,
    next_attempt_at INTEGER NOT NULL CHECK(next_attempt_at>=0),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
    lease_token TEXT,
    lease_until INTEGER,
    response_sha256 TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL CHECK(created_at>=0),
    updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
    UNIQUE(merchant_id,request_id),
    UNIQUE(provider,provider_account,provider_refund_no),
    CHECK((lease_token IS NULL)=(lease_until IS NULL))
  ) STRICT;
  CREATE UNIQUE INDEX epay_native_refund_active ON epay_native_refunds(trade_no)
    WHERE status IN ('REQUESTED','READY','PROCESSING','UNKNOWN');
  CREATE INDEX epay_native_refund_due ON epay_native_refunds(status,next_attempt_at);
  CREATE TRIGGER epay_native_refunds_identity BEFORE UPDATE OF
    refund_no,request_id,trade_no,merchant_id,provider,provider_account,provider_trade_no,total_cents,amount_cents,debit_cents,reason,requested_by,created_at
    ON epay_native_refunds BEGIN SELECT RAISE(ABORT,'refund identity is immutable'); END;
  CREATE TRIGGER epay_native_refunds_no_delete BEFORE DELETE ON epay_native_refunds
    BEGIN SELECT RAISE(ABORT,'refund history is immutable'); END;
  CREATE TRIGGER epay_native_refunds_terminal BEFORE UPDATE ON epay_native_refunds
    WHEN OLD.status IN ('SUCCEEDED','REJECTED','CLOSED') BEGIN SELECT RAISE(ABORT,'refund is terminal'); END;
  CREATE TRIGGER epay_native_refunds_transition BEFORE UPDATE ON epay_native_refunds
    WHEN NEW.updated_at<OLD.updated_at OR NOT (
      (OLD.status='REQUESTED' AND NEW.status IN ('READY','REJECTED')) OR
      (OLD.status IN ('READY','PROCESSING','UNKNOWN') AND NEW.status IN ('UNKNOWN','PROCESSING','SUCCEEDED','CLOSED')))
    BEGIN SELECT RAISE(ABORT,'invalid refund state transition'); END;
  CREATE TABLE epay_native_refund_attempts (
    attempt_id TEXT PRIMARY KEY,
    refund_no TEXT NOT NULL REFERENCES epay_native_refunds(refund_no),
    action TEXT NOT NULL CHECK(action IN ('SUBMIT','QUERY')),
    started_at INTEGER NOT NULL CHECK(started_at>=0),
    finished_at INTEGER,
    outcome TEXT NOT NULL CHECK(outcome IN ('STARTED','SUCCEEDED','PROCESSING','CLOSED','UNKNOWN','EXPIRED')),
    response_sha256 TEXT,
    error_code TEXT
  ) STRICT;
  CREATE TRIGGER epay_native_refund_attempts_no_delete BEFORE DELETE ON epay_native_refund_attempts
    BEGIN SELECT RAISE(ABORT,'refund attempts cannot be deleted'); END;
  CREATE VIEW epay_order_states AS
    SELECT o.trade_no,o.out_trade_no,o.api_trade_no,o.merchant_id,o.type_id,o.channel_id,o.type_code,o.channel_code,o.name,
      o.money_cents,o.real_money_cents,o.get_money_cents,o.notify_url,o.return_url,o.param,o.domain,o.ip,o.device,o.buyer,
      o.pay_url,o.qr_code,o.url_scheme,o.provider_result_json,o.status AS payment_status,
      CASE WHEN o.status<>'PAID' THEN o.status
        WHEN coalesce(r.refunded_cents,0)>=o.money_cents AND o.money_cents>0 THEN 'REFUNDED'
        WHEN r.processing=1 THEN 'REFUND_PROCESSING'
        WHEN r.refunded_cents>0 THEN 'PARTIAL_REFUND' ELSE o.status END AS status,
      coalesce(r.refunded_cents,0) AS refunded_cents,
      o.notify_status,o.notify_count,o.notify_last_at,o.created_at,o.paid_at,o.updated_at,o.buyer_email
    FROM epay_orders o LEFT JOIN (
      SELECT trade_no,sum(CASE WHEN status='SUCCEEDED' THEN amount_cents ELSE 0 END) refunded_cents,
        max(CASE WHEN status IN ('READY','PROCESSING','UNKNOWN') THEN 1 ELSE 0 END) processing
      FROM epay_native_refunds GROUP BY trade_no
    ) r ON r.trade_no=o.trade_no;
`;
