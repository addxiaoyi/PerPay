import type { DatabaseSync } from "node:sqlite";

export function hasVerifiedCutoverManifest(db: DatabaseSync): boolean {
  const imported = db.prepare("SELECT value FROM system_metadata WHERE key='epay_candidate_import'").get();
  const cutover = db.prepare("SELECT value FROM system_metadata WHERE key='epay_cutover'").get();
  if (!imported || !cutover) return false;
  const source: unknown = JSON.parse(String(imported.value));
  const manifest: unknown = JSON.parse(String(cutover.value));
  if (!source || typeof source !== "object" || Array.isArray(source) || !manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
  const capture = source as Record<string, unknown>;
  const review = manifest as Record<string, unknown>;
  return typeof capture.snapshotId === "string" && capture.snapshotId.length > 0 && capture.snapshotId.length <= 128 &&
    review.version === 1 && review.snapshotId === capture.snapshotId && review.sharedCutoff === true &&
    typeof review.cutoff === "string" && Number.isFinite(Date.parse(review.cutoff)) &&
    [review.reconciliationSha256, review.rollbackSha256, review.channelVerificationSha256]
      .every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash));
}
