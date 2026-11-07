/**
 * Tables for the legacy EPay contract.
 *
 * These records remain separate from PerPay's normalized reconciliation
 * ledger until the compatibility API has passed a shadow comparison.
 */
export const EPAY_COMPATIBILITY_SCHEMA_SQL = `
  CREATE TABLE epay_merchant_accounts (
    merchant_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
    balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    fee_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (fee_rate_bps BETWEEN 0 AND 5000),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
  ) STRICT;

  CREATE INDEX epay_merchant_accounts_enabled_idx
    ON epay_merchant_accounts(enabled, merchant_id);

  CREATE TABLE epay_merchant_bindings (
    binding_id TEXT PRIMARY KEY CHECK (length(binding_id) BETWEEN 1 AND 64),
    main_api_id TEXT NOT NULL UNIQUE CHECK (length(main_api_id) BETWEEN 1 AND 80),
    main_merchant_id TEXT NOT NULL UNIQUE CHECK (length(main_merchant_id) BETWEEN 1 AND 80),
    epay_merchant_id INTEGER NOT NULL UNIQUE REFERENCES epay_merchant_accounts(merchant_id),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
  ) STRICT;

  CREATE TABLE epay_merchant_secrets (
    merchant_id INTEGER PRIMARY KEY REFERENCES epay_merchant_accounts(merchant_id),
    secret_version INTEGER NOT NULL CHECK (secret_version >= 1),
    cipher_version INTEGER NOT NULL CHECK (cipher_version = 1),
    nonce BLOB NOT NULL CHECK (typeof(nonce) = 'blob' AND length(nonce) = 12),
    ciphertext BLOB NOT NULL CHECK (typeof(ciphertext) = 'blob' AND length(ciphertext) >= 1),
    authentication_tag BLOB NOT NULL CHECK (typeof(authentication_tag) = 'blob' AND length(authentication_tag) = 16),
    secret_fingerprint TEXT NOT NULL CHECK (length(secret_fingerprint) = 64),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT;

  CREATE TABLE epay_pay_types (
    type_id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 30),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 30),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    sort_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
  ) STRICT;

  CREATE TABLE epay_channels (
    channel_id INTEGER PRIMARY KEY,
    type_id INTEGER REFERENCES epay_pay_types(type_id),
    provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 30),
    code TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 40),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    product TEXT NOT NULL CHECK (length(product) BETWEEN 1 AND 40),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    rate_bps INTEGER NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
    pay_min_cents INTEGER CHECK (pay_min_cents IS NULL OR pay_min_cents >= 0),
    pay_max_cents INTEGER CHECK (pay_max_cents IS NULL OR pay_max_cents >= 0),
    config_json TEXT CHECK (config_json IS NULL OR json_valid(config_json)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
  ) STRICT;

  CREATE INDEX epay_channels_type_enabled_idx ON epay_channels(type_id, enabled);

  CREATE TABLE epay_orders (
    trade_no TEXT PRIMARY KEY CHECK (length(trade_no) BETWEEN 1 AND 64),
    out_trade_no TEXT NOT NULL CHECK (length(out_trade_no) BETWEEN 1 AND 150),
    api_trade_no TEXT,
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    type_id INTEGER REFERENCES epay_pay_types(type_id),
    channel_id INTEGER REFERENCES epay_channels(channel_id),
    type_code TEXT,
    channel_code TEXT,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 127),
    money_cents INTEGER NOT NULL CHECK (money_cents >= 0),
    real_money_cents INTEGER,
    get_money_cents INTEGER,
    notify_url TEXT NOT NULL,
    return_url TEXT,
    param TEXT,
    domain TEXT,
    ip TEXT,
    device TEXT,
    buyer TEXT,
    pay_url TEXT,
    qr_code TEXT,
    url_scheme TEXT,
    provider_result_json TEXT CHECK (provider_result_json IS NULL OR json_valid(provider_result_json)),
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'PAID', 'REFUNDED', 'FROZEN', 'CLOSED')),
    notify_status TEXT NOT NULL CHECK (notify_status IN ('PENDING', 'SUCCESS', 'FAILED')),
    notify_count INTEGER NOT NULL CHECK (notify_count >= 0),
    notify_last_at INTEGER,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    paid_at INTEGER,
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    buyer_email TEXT,
    UNIQUE (merchant_id, out_trade_no)
  ) STRICT;

  CREATE INDEX epay_orders_merchant_created_idx ON epay_orders(merchant_id, created_at DESC, trade_no DESC);
  CREATE INDEX epay_orders_status_created_idx ON epay_orders(status, created_at DESC, trade_no DESC);
  CREATE INDEX epay_orders_merchant_status_idx ON epay_orders(merchant_id, status, created_at DESC);

  CREATE TABLE epay_notify_logs (
    notify_id INTEGER PRIMARY KEY,
    trade_no TEXT NOT NULL REFERENCES epay_orders(trade_no),
    url TEXT NOT NULL,
    params_json TEXT NOT NULL CHECK (json_valid(params_json)),
    response_code INTEGER,
    response_body TEXT,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
    error TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0)
  ) STRICT;

  CREATE INDEX epay_notify_logs_order_created_idx ON epay_notify_logs(trade_no, created_at);

  CREATE TABLE epay_invoices (
    invoice_id TEXT PRIMARY KEY CHECK (length(invoice_id) BETWEEN 1 AND 64),
    trade_no TEXT NOT NULL,
    kind TEXT NOT NULL,
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    title TEXT NOT NULL,
    tax_id TEXT,
    email TEXT,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    status TEXT NOT NULL,
    provider TEXT NOT NULL,
    external_id TEXT,
    receipt_pdf_path TEXT,
    provider_message TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    issued_at INTEGER,
    service_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (service_fee_cents >= 0),
    charged_at INTEGER
  ) STRICT;

  CREATE INDEX epay_invoices_merchant_created_idx ON epay_invoices(merchant_id, created_at DESC);

  CREATE TABLE epay_invoice_applications (
    application_id TEXT PRIMARY KEY CHECK (length(application_id) BETWEEN 1 AND 64),
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    trade_no TEXT NOT NULL,
    out_trade_no TEXT NOT NULL,
    title TEXT NOT NULL,
    tax_id TEXT NOT NULL,
    email TEXT NOT NULL,
    fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    invoice_no TEXT,
    invoice_url TEXT,
    issued_at INTEGER,
    error_code TEXT,
    error_message TEXT,
    email_sent INTEGER NOT NULL CHECK (email_sent IN (0, 1)),
    email_error TEXT,
    UNIQUE (merchant_id, trade_no)
  ) STRICT;

  CREATE INDEX epay_invoice_applications_merchant_status_idx
    ON epay_invoice_applications(merchant_id, status, created_at DESC);

  CREATE TABLE epay_balance_ledger (
    entry_id TEXT PRIMARY KEY CHECK (length(entry_id) BETWEEN 1 AND 128),
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    entry_type TEXT NOT NULL CHECK (length(entry_type) BETWEEN 1 AND 64),
    available_delta_cents INTEGER NOT NULL,
    frozen_delta_cents INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    actor_id TEXT,
    occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
    source TEXT NOT NULL DEFAULT 'legacy_epay'
  ) STRICT;

  CREATE INDEX epay_balance_ledger_merchant_time_idx
    ON epay_balance_ledger(merchant_id, occurred_at DESC, entry_id DESC);

  CREATE TABLE epay_config_values (
    config_key TEXT PRIMARY KEY CHECK (length(config_key) BETWEEN 1 AND 128),
    config_value TEXT,
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT;

  CREATE TABLE epay_config_secrets (
    config_key TEXT PRIMARY KEY CHECK (length(config_key) BETWEEN 1 AND 128),
    secret_version INTEGER NOT NULL CHECK (secret_version >= 1),
    cipher_version INTEGER NOT NULL CHECK (cipher_version = 1),
    nonce BLOB NOT NULL CHECK (typeof(nonce) = 'blob' AND length(nonce) = 12),
    ciphertext BLOB NOT NULL CHECK (typeof(ciphertext) = 'blob' AND length(ciphertext) >= 1),
    authentication_tag BLOB NOT NULL CHECK (typeof(authentication_tag) = 'blob' AND length(authentication_tag) = 16),
    secret_fingerprint TEXT NOT NULL CHECK (length(secret_fingerprint) = 64),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT;

  CREATE TABLE epay_compat_import_runs (
    import_id TEXT PRIMARY KEY CHECK (length(import_id) = 36),
    source_name TEXT NOT NULL CHECK (length(source_name) BETWEEN 1 AND 128),
    source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint) = 64),
    imported_at INTEGER NOT NULL CHECK (imported_at >= 0),
    counts_json TEXT NOT NULL CHECK (json_valid(counts_json)),
    UNIQUE (source_name, source_fingerprint)
  ) STRICT;

  CREATE TABLE epay_snapshot_runs (
    snapshot_id TEXT PRIMARY KEY,
    source_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    counts_json TEXT NOT NULL CHECK (json_valid(counts_json))
  ) STRICT;

  CREATE TABLE epay_snapshot_rows (
    snapshot_id TEXT NOT NULL REFERENCES epay_snapshot_runs(snapshot_id),
    source_table TEXT NOT NULL,
    row_index INTEGER NOT NULL CHECK (row_index >= 0),
    cipher_version INTEGER NOT NULL,
    nonce BLOB NOT NULL,
    ciphertext BLOB NOT NULL,
    authentication_tag BLOB NOT NULL,
    PRIMARY KEY (snapshot_id, source_table, row_index)
  ) STRICT;
`;
