import { createHash } from "node:crypto";
import type { AppDatabase } from "../database/database.ts";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import type { captureSharedCutoff } from "./shared-cutoff.ts";
import { applyMainPaymentDelta, readCurrentMainPayment } from "./main-delta-store.ts";
import { applyLegacyDelta, readLegacyCursor } from "./legacy-delta.ts";
import { canonicalSource } from "./source-drift.ts";

type Capture = Awaited<ReturnType<typeof captureSharedCutoff>>;
type Database = Pick<AppDatabase, "write">;

// Both source cursors and their postings advance together. Neither source owns native PerPay orders.
export function applySharedPaymentDelta(database: Database, cipher: RuntimeSecretCipher, capture: Capture, now: number) {
  const sourceSha256 = createHash("sha256").update(canonicalSource({ tables: capture.tables, columns: capture.columns, payment: capture.mainPayment })).digest("hex");
  if (capture.version !== 1 || capture.sharedCutoff !== true || sourceSha256 !== capture.sourceSha256) throw new Error("shared synchronization capture digest differs");
  return database.write(sql => {
    if (!sql.isTransaction) throw new Error("shared synchronization requires a transaction");
    const main = readCurrentMainPayment(sql, cipher), legacy = readLegacyCursor(sql, cipher);
    const mainRun = applyMainPaymentDelta(sql, cipher, { payment: capture.mainPayment, expectedSha256: main.sourceSha256, capturedAt: capture.cutoff, responseSha256: capture.mainResponseSha256, appliedAt: now });
    const legacyRun = applyLegacyDelta(sql, cipher, { tables: capture.tables, columns: capture.columns, expectedSha256: legacy.sourceSha256, capturedAt: Date.parse(capture.cutoff), appliedAt: now, responseSha256: capture.sourceSha256 });
    const status = { version: 1, ok: true, capturedAt: capture.cutoff, appliedAt: now, sourceSha256: capture.sourceSha256, mainSequence: mainRun.sequence, legacySequence: legacyRun.sequence };
    sql.prepare("INSERT INTO system_metadata(key,value,updated_at) VALUES('epay_source_sync',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(JSON.stringify(status), now);
    return { ...status, mainPostedEntries: mainRun.postedEntries, legacyPostedEntries: legacyRun.postedEntries, duplicate: mainRun.duplicate && legacyRun.duplicate };
  });
}

export function recordSourceSyncFailure(database: Database, now: number) {
  database.write(sql => {
    sql.prepare("INSERT INTO system_metadata(key,value,updated_at) VALUES('epay_source_sync',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .run(JSON.stringify({ version: 1, ok: false, failedAt: now, code: "legacy_source_sync_failed" }), now);
  });
}
