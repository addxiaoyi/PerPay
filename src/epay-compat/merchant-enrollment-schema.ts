export const EPAY_MERCHANT_ENROLLMENT_SCHEMA_SQL = `
  CREATE TABLE epay_merchant_creation_requests (
    request_id TEXT PRIMARY KEY CHECK(length(request_id)=36),
    user_id TEXT NOT NULL UNIQUE CHECK(length(user_id) BETWEEN 1 AND 128),
    display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80),
    callback_url TEXT NOT NULL CHECK(length(callback_url) BETWEEN 1 AND 2048),
    actor_id TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at>=0)
  ) STRICT;
  CREATE TABLE epay_merchant_enrollments (
    main_merchant_id TEXT PRIMARY KEY REFERENCES epay_merchant_bindings(main_merchant_id),
    main_api_id TEXT NOT NULL UNIQUE,
    epay_merchant_id INTEGER NOT NULL UNIQUE REFERENCES epay_merchant_accounts(merchant_id),
    request_id TEXT NOT NULL UNIQUE REFERENCES epay_merchant_creation_requests(request_id),
    user_id TEXT NOT NULL UNIQUE,
    source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
    enrolled_at INTEGER NOT NULL CHECK(enrolled_at>=0)
  ) STRICT;
  CREATE TRIGGER epay_creation_request_no_update BEFORE UPDATE ON epay_merchant_creation_requests BEGIN SELECT RAISE(ABORT,'merchant creation request is immutable'); END;
  CREATE TRIGGER epay_creation_request_no_delete BEFORE DELETE ON epay_merchant_creation_requests BEGIN SELECT RAISE(ABORT,'merchant creation request is immutable'); END;
  CREATE TRIGGER epay_enrollment_no_update BEFORE UPDATE ON epay_merchant_enrollments BEGIN SELECT RAISE(ABORT,'merchant enrollment is immutable'); END;
  CREATE TRIGGER epay_enrollment_no_delete BEFORE DELETE ON epay_merchant_enrollments BEGIN SELECT RAISE(ABORT,'merchant enrollment is immutable'); END;
`;
