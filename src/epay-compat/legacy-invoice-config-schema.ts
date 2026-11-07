export const EPAY_LEGACY_INVOICE_CONFIG_SCHEMA_SQL = `
  CREATE TABLE epay_legacy_invoice_config_source (
    merchant_id INTEGER PRIMARY KEY REFERENCES epay_merchant_accounts(merchant_id),
    nonce BLOB NOT NULL CHECK(length(nonce)=12),
    ciphertext BLOB NOT NULL CHECK(length(ciphertext)>0),
    authentication_tag BLOB NOT NULL CHECK(length(authentication_tag)=16)
  ) STRICT;
`;
