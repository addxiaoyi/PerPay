import assert from "node:assert/strict";
import { it } from "node:test";
import { canonicalSource, compareMigrationRows } from "../src/epay-compat/source-drift.ts";

it("compares every column without depending on row or object key ordering", () => {
  const before = [{ id: "a", amount: "100.00", nested: { b: 2, a: 1 } }, { id: "b", status: "PENDING" }];
  const same = compareMigrationRows(before, [{ status: "PENDING", id: "b" }, { nested: { a: 1, b: 2 }, amount: "100.00", id: "a" }], "id");
  assert.deepEqual(same.changed, []);
  assert.equal(same.baselineSha256, same.currentSha256);
  const changed = compareMigrationRows(before, [{ id: "a", amount: "100.01", nested: { a: 1, b: 2 } }, { id: "c", secret: "do-not-print" }], "id");
  assert.deepEqual(changed.added, ["c"]);
  assert.deepEqual(changed.removed, ["b"]);
  assert.deepEqual(changed.changed, [{ id: "a", columns: ["amount"] }]);
  assert.ok(!JSON.stringify(changed).includes("do-not-print"));
});

it("detects removed fields, decimal precision, type differences and duplicate identities", () => {
  const changes = compareMigrationRows([{ id: 1, money: "99999999999999.99", optional: null }], [{ id: "1", money: "99999999999999.98" }], "id");
  assert.deepEqual(changes.changed[0]?.columns, ["id", "money", "optional"]);
  assert.throws(() => compareMigrationRows([{ id: 1 }, { id: "1" }], [], "id"), /duplicate/);
  assert.throws(() => compareMigrationRows([{ id: Number.MAX_SAFE_INTEGER + 1 }], [], "id"), /primary key/);
  for (const value of [undefined, NaN, Infinity, new Date(), { id: undefined }, 1n]) {
    assert.throws(() => canonicalSource(value), /non-JSON/);
  }
});
