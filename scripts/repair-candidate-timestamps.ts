import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { planImportedTimestampRepair, repairImportedTimestamps, timestampRepairInvariants } from "../src/epay-compat/imported-timestamp-repair.ts";

const CANDIDATE = "/var/lib/perpay-candidate-20261104d";
const RECOVERY = "/root/perpay-recovery-20261104";
let stage = "arguments";
async function run() {
  process.umask(0o077);
  const [mode, label, evidenceSha256] = process.argv.slice(2);
  if (!["prepare", "apply", "verify"].includes(mode ?? "") || !label || !/^[a-z0-9-]{1,80}$/.test(label) || !evidenceSha256 || !/^[a-f0-9]{64}$/.test(evidenceSha256)) throw new Error("invalid repair arguments");
  const planFile = join(RECOVERY, label + "-plan.json");
  const backupFile = join(RECOVERY, label + ".sqlite3");
  const state = execFileSync("systemctl", ["show", "perpay-candidate.service", "--property=ActiveState", "--value"], { encoding: "utf8" }).trim();
  const unit = readFileSync("/etc/systemd/system/perpay-candidate.service", "utf8");
  if (!unit.includes("PERPAY_EPAY_GATEWAY_MODE=maintenance") || !unit.includes("PERPAY_EPAY_CALLBACK_DELIVERY=false")) throw new Error("candidate maintenance configuration required");
  if (mode === "apply" && state !== "inactive") throw new Error("stop candidate before applying reviewed repair");
  const key = Buffer.from(readFileSync(join(CANDIDATE, "secrets/master-key"), "utf8").trim(), "hex");
  if (key.length !== 32) throw new Error("invalid candidate key");
  const snapshot = new DatabaseSync(join(CANDIDATE, "snapshot/snapshot.sqlite3"), { readOnly: true, readBigInts: true });
  const live = new DatabaseSync(join(CANDIDATE, "data/perpay.sqlite3"), { readOnly: mode !== "apply", readBigInts: true, enableForeignKeyConstraints: true });
  let temporary: string | undefined;
  try {
    snapshot.exec("BEGIN");
    const provenance = live.prepare("SELECT value FROM system_metadata WHERE key='epay_candidate_import'").get();
    if (!provenance) throw new Error("candidate import metadata missing");
    const { snapshotId } = JSON.parse(String(provenance.value)) as { snapshotId: string };
    const source = snapshot.prepare("SELECT source_name FROM epay_snapshot_runs WHERE snapshot_id=?").get(snapshotId);
    const instance = snapshot.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get();
    if (!source || !instance) throw new Error("candidate snapshot metadata missing");
    const options = { database: { read: <T>(fn: (db: DatabaseSync) => T) => fn(snapshot), write: <T>(): T => { throw new Error("snapshot is immutable"); } }, masterKey: key, instanceId: String(instance.value), sourceName: String(source.source_name), snapshotId, evidenceSha256, requireColumnMetadata: true };
    stage = "authenticated-plan";
    if (mode === "prepare") {
      if (existsSync(planFile) || existsSync(backupFile)) throw new Error("repair evidence must use a new label");
      if (statfsSync("/dev/shm").type !== 0x01021994) throw new Error("isolated rehearsal requires tmpfs");
      await backup(live, backupFile);
      const original = new DatabaseSync(backupFile, { readOnly: true, readBigInts: true });
      let plan;
      let invariant;
      try {
        plan = planImportedTimestampRepair(original, options);
        invariant = timestampRepairInvariants(original);
        if (original.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("backup integrity failed");
      } finally { original.close(); }
      temporary = mkdtempSync("/dev/shm/perpay-date-rehearsal-");
      const rehearsalPath = join(temporary, "candidate.sqlite3");
      copyFileSync(backupFile, rehearsalPath, constants.COPYFILE_EXCL);
      const rehearsal = new DatabaseSync(rehearsalPath, { readBigInts: true, enableForeignKeyConstraints: true });
      try {
        rehearsal.exec("BEGIN IMMEDIATE");
        repairImportedTimestamps(rehearsal, options, plan.summary.planSha256);
        rehearsal.exec("COMMIT");
      } catch (error) {
        if (rehearsal.isTransaction) rehearsal.exec("ROLLBACK");
        throw error;
      } finally { rehearsal.close(); }
      const reopened = new DatabaseSync(rehearsalPath, { readOnly: true, readBigInts: true });
      try {
        if (planImportedTimestampRepair(reopened, options).changes.length || timestampRepairInvariants(reopened) !== invariant || reopened.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || reopened.prepare("PRAGMA foreign_key_check").get()) throw new Error("isolated reopened verification failed");
      } finally { reopened.close(); }
      // Restore a second isolated file, never the running candidate database.
      const restoredPath = join(temporary, "restored.sqlite3");
      copyFileSync(backupFile, restoredPath, constants.COPYFILE_EXCL);
      const restored = new DatabaseSync(restoredPath, { readOnly: true, readBigInts: true });
      try {
        if (planImportedTimestampRepair(restored, options).summary.planSha256 !== plan.summary.planSha256 || timestampRepairInvariants(restored) !== invariant) throw new Error("isolated restore differs from original");
      } finally { restored.close(); }
      const report = { ...plan.summary, preparedAt: new Date().toISOString(), protectedStateSha256: invariant, backupSha256: createHash("sha256").update(readFileSync(backupFile)).digest("hex"), isolatedRehearsal: true, reopenedVerified: true, isolatedRestoreVerified: true, productionChanged: false };
      writeFileSync(planFile, JSON.stringify(report), { flag: "wx", mode: 0o600, flush: true });
      console.log(JSON.stringify(report));
    } else if (mode === "apply") {
      const review = JSON.parse(readFileSync(planFile, "utf8"));
      if (review.evidenceSha256 !== evidenceSha256 || !review.isolatedRestoreVerified || createHash("sha256").update(readFileSync(backupFile)).digest("hex") !== review.backupSha256) throw new Error("repair backup or review mismatch");
      stage = "candidate-transaction";
      live.exec("BEGIN IMMEDIATE");
      try {
        if (timestampRepairInvariants(live) !== review.protectedStateSha256) throw new Error("candidate changed since rehearsal");
        const report = repairImportedTimestamps(live, options, review.planSha256);
        if (live.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || live.prepare("PRAGMA foreign_key_check").get()) throw new Error("candidate integrity failed after repair");
        live.exec("COMMIT");
        const evidence = { ...report, appliedAt: new Date().toISOString(), productionRoutingChanged: false, paymentsCreated: 0 };
        writeFileSync(join(RECOVERY, label + "-applied.json"), JSON.stringify(evidence), { flag: "wx", mode: 0o600, flush: true });
        console.log(JSON.stringify(evidence));
      } catch (error) {
        if (live.isTransaction) live.exec("ROLLBACK");
        throw error;
      }
    } else {
      live.exec("BEGIN");
      const plan = planImportedTimestampRepair(live, options);
      console.log(JSON.stringify({ ...plan.summary, protectedStateSha256: timestampRepairInvariants(live), readOnly: true, integrity: live.prepare("PRAGMA integrity_check").get()?.integrity_check }));
    }
  } finally {
    if (live.isTransaction) live.exec("ROLLBACK");
    live.close(); snapshot.exec("ROLLBACK"); snapshot.close(); key.fill(0);
    if (temporary) rmSync(temporary, { recursive: true });
  }
}
run().catch(error => {
  console.error(JSON.stringify({ error: "candidate_timestamp_repair_failed", stage, detail: error instanceof Error && /^(timestamp repair|candidate changed|repair backup|stop candidate)/.test(error.message) ? error.message : "see isolated diagnostics" }));
  process.exitCode = 1;
});
