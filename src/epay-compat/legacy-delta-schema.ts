export const EPAY_LEGACY_DELTA_SCHEMA_SQL = `
  CREATE TABLE epay_legacy_sync_runs (
    sequence INTEGER PRIMARY KEY CHECK(sequence>0),
    previous_sha256 TEXT NOT NULL CHECK(length(previous_sha256)=64),
    source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
    response_sha256 TEXT NOT NULL CHECK(length(response_sha256)=64),
    captured_at INTEGER NOT NULL CHECK(captured_at>=0),
    applied_at INTEGER NOT NULL CHECK(applied_at>=captured_at),
    posted_entries INTEGER NOT NULL CHECK(posted_entries>=0),
    nonce BLOB NOT NULL CHECK(length(nonce)=12),
    ciphertext BLOB NOT NULL CHECK(length(ciphertext)>0),
    authentication_tag BLOB NOT NULL CHECK(length(authentication_tag)=16)
  ) STRICT;
  CREATE TRIGGER epay_legacy_sync_no_update BEFORE UPDATE ON epay_legacy_sync_runs
    BEGIN SELECT RAISE(ABORT,'legacy synchronization history is immutable'); END;
  CREATE TRIGGER epay_legacy_sync_no_delete BEFORE DELETE ON epay_legacy_sync_runs
    BEGIN SELECT RAISE(ABORT,'legacy synchronization history is immutable'); END;
  CREATE TRIGGER epay_legacy_sync_sequence BEFORE INSERT ON epay_legacy_sync_runs
    BEGIN
      SELECT CASE WHEN NEW.sequence<>coalesce((SELECT max(sequence)+1 FROM epay_legacy_sync_runs),1)
        THEN RAISE(ABORT,'legacy synchronization sequence differs') END;
      SELECT CASE WHEN NEW.sequence>1 AND NOT EXISTS(SELECT 1 FROM epay_legacy_sync_runs
        WHERE sequence=NEW.sequence-1 AND source_sha256=NEW.previous_sha256 AND captured_at<=NEW.captured_at)
        THEN RAISE(ABORT,'legacy synchronization cursor differs') END;
    END;
`;
