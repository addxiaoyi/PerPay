import { createHash } from "node:crypto";
import { SOURCE_TABLES, readSourceColumns, type SnapshotSource } from "./snapshot.ts";
import { canonicalSource } from "./source-drift.ts";

type TableName = keyof typeof SOURCE_TABLES;
type Rows = Record<TableName, Array<Record<string, unknown>>>;
type Columns = Record<TableName, string[]>;
type MainCapture = { payment: unknown; capturedAt: string; responseSha256: string };
const MAX_LOCK_MILLISECONDS = 10_000;

// Use a dedicated connection. Starting a transaction after LOCK TABLES would release its locks.
export async function captureSharedCutoff(source: SnapshotSource, readMain: () => Promise<MainCapture>, clock = Date.now) {
  const names = Object.keys(SOURCE_TABLES) as TableName[];
  const [schema] = await source.query("SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()");
  if (!Array.isArray(schema) || schema.length !== names.length) throw new Error("shared cutoff source schema differs");
  const engines = new Map(schema.map(row => [row.TABLE_NAME, row.ENGINE]));
  if (engines.size !== names.length || names.some(name => engines.get(name)?.toUpperCase() !== "INNODB")) throw new Error("shared cutoff requires the exact InnoDB source schema");
  await source.query("SET SESSION time_zone = '+00:00'");
  await source.query("SET SESSION lock_wait_timeout = 3");
  await source.query("SET SESSION innodb_lock_wait_timeout = 3");
  await source.query("SET autocommit = 0");
  await source.query(`LOCK TABLES ${names.map(name => `\`${name}\` READ`).join(", ")}`);
  const lockedAt = clock(), tables = {} as Rows, columns = {} as Columns;
  let failure: unknown;
  try {
    for (const [name, primary] of Object.entries(SOURCE_TABLES) as Array<[TableName, string]>) {
      if (clock() - lockedAt > MAX_LOCK_MILLISECONDS) throw new Error("shared cutoff lock deadline exceeded");
      const [rows, fields] = await source.query(`SELECT * FROM \`${name}\` ORDER BY \`${primary}\``);
      if (!Array.isArray(rows) || rows.length > 2_000_000) throw new Error("shared cutoff source rows are invalid");
      columns[name] = readSourceColumns(fields, name);
      if (!columns[name].includes(primary) || rows.some(row => !row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== columns[name].length || columns[name].some(key => !Object.hasOwn(row, key)))) throw new Error("shared cutoff source columns differ");
      canonicalSource(rows);
      tables[name] = rows;
    }
    const main = await readMain(), capturedAt = Date.parse(main.capturedAt), endedAt = clock();
    if (!Number.isSafeInteger(capturedAt) || capturedAt < lockedAt || capturedAt > endedAt || endedAt - lockedAt > MAX_LOCK_MILLISECONDS || !/^[a-f0-9]{64}$/.test(main.responseSha256)) throw new Error("shared cutoff does not fall within the source lock window");
    const sourceSha256 = createHash("sha256").update(canonicalSource({ tables, columns, payment: main.payment })).digest("hex");
    return { version: 1 as const, sharedCutoff: true as const, cutoff: main.capturedAt, lockedAt, lockCompletedAt: endedAt, tables, columns, mainPayment: main.payment, mainResponseSha256: main.responseSha256, sourceSha256 };
  } catch (error) { failure = error; throw error; }
  finally {
    try { await source.query("UNLOCK TABLES"); }
    catch (error) { throw failure ? new AggregateError([failure, error], "shared cutoff failed and source locks could not be released") : error; }
  }
}

// Encrypt the already captured rows without reopening a live MySQL transaction.
export function capturedSnapshotSource(capture: Awaited<ReturnType<typeof captureSharedCutoff>>): SnapshotSource {
  let transaction = false;
  return { async query(sql) {
    if (sql === "SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ") return [[], []];
    if (sql === "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY" && !transaction) { transaction = true; return [[], []]; }
    if ((sql === "COMMIT" || sql === "ROLLBACK") && transaction) { transaction = false; return [[], []]; }
    for (const [name, primary] of Object.entries(SOURCE_TABLES) as Array<[TableName, string]>) {
      if (transaction && sql === `SELECT * FROM \`${name}\` ORDER BY \`${primary}\``) return [capture.tables[name], capture.columns[name].map(column => ({ name: column }))];
    }
    throw new Error("captured source accepts only the snapshot protocol");
  } };
}
