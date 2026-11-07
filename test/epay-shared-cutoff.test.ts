import assert from "node:assert/strict";
import { it } from "node:test";
import { SOURCE_TABLES, type SnapshotSource } from "../src/epay-compat/snapshot.ts";
import { captureSharedCutoff, capturedSnapshotSource } from "../src/epay-compat/shared-cutoff.ts";

it("keeps every legacy table read-locked while the authenticated main memory cutoff is captured", async () => {
  let locked = false, unlocked = 0, fail = false;
  const queries: string[] = [];
  const source: SnapshotSource = { async query(sql) {
    queries.push(sql);
    if (sql.startsWith("LOCK TABLES ")) { assert.equal(locked, false); locked = true; }
    if (sql === "UNLOCK TABLES") { assert.equal(locked, true); locked = false; unlocked++; }
    if (sql.includes("information_schema.TABLES")) return [Object.keys(SOURCE_TABLES).map(TABLE_NAME => ({ TABLE_NAME, ENGINE: "InnoDB" })), []];
    const table = /^SELECT \* FROM `([^`]+)` ORDER BY `([^`]+)`$/.exec(sql);
    if (!table) return [[], []];
    assert.equal(locked, true);
    if (fail) throw new Error("isolated source read failed");
    return [[{ [table[2]!]: table[1] === "Merchant" ? 1 : "source-id", privateValue: "keep-encrypted" }], [{ name: table[2] }, { name: "privateValue" }]];
  } };
  const main = async () => { assert.equal(locked, true); return { payment: { merchants: [] }, capturedAt: "2026-11-05T07:00:00.000Z", responseSha256: "a".repeat(64) }; };
  const capture = await captureSharedCutoff(source, main, () => Date.parse("2026-11-05T07:00:00.000Z"));
  assert.equal(locked, false); assert.equal(unlocked, 1);
  assert.equal(capture.sharedCutoff, true);
  assert.equal(capture.cutoff, "2026-11-05T07:00:00.000Z");
  assert.equal(Object.keys(capture.tables).length, 11);
  const replay = capturedSnapshotSource(capture);
  await replay.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
  assert.deepEqual((await replay.query("SELECT * FROM `Merchant` ORDER BY `id`"))[0], capture.tables.Merchant);
  await assert.rejects(replay.query("DELETE FROM Merchant"));
  assert.ok(!queries.includes("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY"));
  fail = true;
  await assert.rejects(captureSharedCutoff(source, main), /isolated source read failed/);
  assert.equal(locked, false); assert.equal(unlocked, 2);
  fail = false;
  await assert.rejects(captureSharedCutoff(source, async () => { throw new Error("main capture failed"); }), /main capture failed/);
  assert.equal(locked, false); assert.equal(unlocked, 3);
});
