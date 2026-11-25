import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { captureReleaseContents, compareReleaseContents } from "./rehearse-release-restore.ts";

const [root, reconciliation, rollback, channels] = process.argv.slice(2);
if (process.env.EPAY_ISOLATED_TEST !== "1" || !root || !reconciliation || !rollback || !channels) throw new Error("isolated cutover rehearsal requires explicit paths");
process.umask(0o077);
const directory = mkdtempSync("/dev/shm/perpay-cutover-record-");
const source = new DatabaseSync(join(root, "data/perpay.sqlite3"), { readOnly: true });
try {
  source.exec("BEGIN");
  const before = captureReleaseContents(source);
  mkdirSync(join(directory, "data")); mkdirSync(join(directory, "secrets"));
  copyFileSync(join(root, "secrets/master-key"), join(directory, "secrets/master-key"));
  await backup(source, join(directory, "data/perpay.sqlite3"));
  const isolated = new DatabaseSync(join(directory, "data/perpay.sqlite3"));
  try { isolated.exec("DELETE FROM app_lease"); } finally { isolated.close(); }
  const report = join(directory, "cutover.json");
  execFileSync(process.execPath, ["--experimental-strip-types", "scripts/record-cutover.ts", directory, reconciliation, rollback, channels, report],
    { env: { ...process.env, PERPAY_RECORD_CUTOVER: "1" }, stdio: "pipe", timeout: 30000 });
  assert.equal(JSON.parse(readFileSync(report, "utf8")).recorded, true);
  const candidate = new DatabaseSync(join(directory, "data/perpay.sqlite3"), { readOnly: true });
  try {
    assert.equal(Number(candidate.prepare("SELECT count(*) n FROM sites WHERE json_extract(configuration,'$.accepting_orders')=1").get()?.n), 4);
    candidate.exec("BEGIN");
    const after = captureReleaseContents(candidate);
    assert.deepEqual(compareReleaseContents(before, after), ["audit_chain_state", "audit_events", "sites", "sqlite_sequence", "system_metadata"]);
    assert.equal(after.audit_events!.rows, before.audit_events!.rows + 5);
    assert.equal(Number(candidate.prepare("SELECT count(*) n FROM audit_events WHERE action='epay.cutover.recorded'").get()?.n), 1);
  } finally { candidate.close(); }
  assert.deepEqual(compareReleaseContents(before, captureReleaseContents(source)), []);
  console.log(JSON.stringify({ isolated: true, sitesOpened: 4, financialRecordsUnchanged: true, productionUnchanged: true }));
} finally { source.close(); rmSync(directory, { recursive: true }); }
