import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { readAuthenticatedEPaySnapshot } from "./authenticated-snapshot.ts";
import { parseSourceTimestamp } from "./source-timestamp.ts";
import { SOURCE_TABLES, type SnapshotOptions } from "./snapshot.ts";

type Mapping = {
  source: keyof typeof SOURCE_TABLES;
  table: string;
  key: string;
  dates: Readonly<Record<string, string>>;
  select?: (row: Record<string, unknown>) => boolean;
};
const CREATED_UPDATED = { createdAt: "created_at", updatedAt: "updated_at" };
const MAPPINGS: readonly Mapping[] = [
  { source: "Merchant", table: "epay_merchant_accounts", key: "merchant_id", dates: CREATED_UPDATED },
  { source: "Merchant", table: "epay_merchant_secrets", key: "merchant_id", dates: { updatedAt: "updated_at" } },
  { source: "MerchantBinding", table: "epay_merchant_bindings", key: "binding_id", dates: CREATED_UPDATED },
  { source: "PayType", table: "epay_pay_types", key: "type_id", dates: CREATED_UPDATED },
  { source: "Channel", table: "epay_channels", key: "channel_id", dates: CREATED_UPDATED },
  { source: "Order", table: "epay_orders", key: "trade_no", dates: { ...CREATED_UPDATED, paidAt: "paid_at", notifyLastAt: "notify_last_at" } },
  { source: "NotifyLog", table: "epay_notify_logs", key: "notify_id", dates: { createdAt: "created_at" } },
  { source: "Invoice", table: "epay_invoices", key: "invoice_id", dates: { ...CREATED_UPDATED, issuedAt: "issued_at", chargedAt: "charged_at" } },
  { source: "InvoiceApplication", table: "epay_invoice_applications", key: "application_id", dates: { ...CREATED_UPDATED, issuedAt: "issued_at" } },
  { source: "Config", table: "epay_config_values", key: "config_key", dates: { updatedAt: "updated_at" }, select: row => row.value === null || row.value === "" },
  { source: "Config", table: "epay_config_secrets", key: "config_key", dates: { updatedAt: "updated_at" }, select: row => row.value !== null && row.value !== "" },
];
const REPAIR_KEY = "epay_import_timestamp_repair";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_, item: unknown) => typeof item === "bigint" ? item.toString() : item)).digest("hex");

export type TimestampRepairOptions = Omit<SnapshotOptions, "source"> & {
  snapshotId: string;
  evidenceSha256: string;
};
type Change = { table: string; key: string; id: SQLInputValue; column: string; before: number; after: number };

function requireCandidate(db: DatabaseSync, snapshotId: string): void {
  if (db.prepare("SELECT 1 FROM system_metadata WHERE key='epay_cutover'").get()) throw new Error("timestamp repair is limited to an uncut candidate");
  const stored = db.prepare("SELECT value FROM system_metadata WHERE key='epay_candidate_import'").get();
  const marker = stored && JSON.parse(String(stored.value)) as { snapshotId?: unknown; acceptingOrders?: unknown; sourceOffsetMinutes?: unknown };
  if (!marker || marker.snapshotId !== snapshotId || marker.acceptingOrders !== false) throw new Error("timestamp repair import provenance mismatch");
  if (marker.sourceOffsetMinutes !== undefined && marker.sourceOffsetMinutes !== 480 && marker.sourceOffsetMinutes !== 0) throw new Error("timestamp repair source offset mismatch");
}

function epoch(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "bigint" && typeof value !== "number") throw new Error("timestamp repair invalid target date");
  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer < 0) throw new Error("timestamp repair invalid target date");
  return integer;
}

// The authenticated archive proves each original value; current configuration dates are not shifted.
export function planImportedTimestampRepair(db: DatabaseSync, options: TimestampRepairOptions) {
  requireCandidate(db, options.snapshotId);
  if (!/^[a-f0-9]{64}$/.test(options.evidenceSha256)) throw new Error("timestamp repair requires an independent UTC audit digest");
  const snapshot = readAuthenticatedEPaySnapshot({ ...options, requireColumnMetadata: true }, options.snapshotId);
  const changes: Change[] = [];
  const tables: Record<string, { rows: number; values: number; changes: number; nulls: number }> = {};
  for (const mapping of MAPPINGS) {
    const stats = { rows: 0, values: 0, changes: 0, nulls: 0 };
    tables[mapping.table] = stats;
    for (const source of snapshot.tables[mapping.source]) {
      if (mapping.select && !mapping.select(source)) continue;
      const id = source[SOURCE_TABLES[mapping.source]];
      if (typeof id !== "string" && typeof id !== "number") throw new Error("timestamp repair invalid source identifier");
      const target = db.prepare(`SELECT ${Object.values(mapping.dates).join(",")} FROM ${mapping.table} WHERE ${mapping.key}=?`).get(id);
      if (!target) throw new Error(`timestamp repair missing imported record in ${mapping.table}`);
      stats.rows++;
      for (const [field, column] of Object.entries(mapping.dates)) {
        if (!Object.hasOwn(source, field)) throw new Error(`timestamp repair missing source field in ${mapping.source}`);
        const current = epoch(target[column]);
        if (source[field] === null) {
          if (current !== null) throw new Error(`timestamp repair null mismatch in ${mapping.table}.${column}`);
          stats.nulls++;
          continue;
        }
        const before = parseSourceTimestamp(source[field], 480);
        const after = parseSourceTimestamp(source[field], 0);
        stats.values++;
        if (current === after) continue;
        if (current !== before) throw new Error(`timestamp repair changed target date in ${mapping.table}.${column}`);
        changes.push({ table: mapping.table, key: mapping.key, id, column, before, after });
        stats.changes++;
      }
    }
  }
  const sourceDigest = hash(snapshot.tables);
  const planSha256 = hash({ snapshotId: options.snapshotId, evidence: options.evidenceSha256, sourceDigest, changes });
  return { changes, summary: { snapshotId: options.snapshotId, sourceDigest, evidenceSha256: options.evidenceSha256, planSha256, tables, changedValues: changes.length } };
}

export function timestampRepairInvariants(db: DatabaseSync): string {
  const tableNames = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'epay_*' ORDER BY name").all();
  const records = tableNames.map(({ name }) => {
    if (typeof name !== "string" || !/^epay_[a-z0-9_]+$/.test(name)) throw new Error("timestamp repair invalid protected table");
    const dates = new Set(MAPPINGS.filter(mapping => mapping.table === name).flatMap(mapping => Object.values(mapping.dates)));
    const select = db.prepare(`SELECT * FROM ${name}`);
    select.setReadBigInts(true);
    return { name, rows: select.all().map(row => hash(Object.fromEntries(Object.entries(row).filter(([column]) => !dates.has(column))))).sort() };
  });
  return hash(records);
}

export function repairImportedTimestamps(db: DatabaseSync, options: TimestampRepairOptions, expectedPlanSha256: string, now = Date.now()) {
  if (!db.isTransaction) throw new Error("timestamp repair requires a transaction");
  db.exec("SAVEPOINT epay_timestamp_repair");
  try {
    const plan = planImportedTimestampRepair(db, options);
    if (plan.summary.planSha256 !== expectedPlanSha256) throw new Error("timestamp repair plan changed");
    const invariant = timestampRepairInvariants(db);
    const records = new Map<string, Change[]>();
    for (const change of plan.changes) {
      const key = JSON.stringify([change.table, change.id]);
      records.set(key, [...(records.get(key) ?? []), change]);
    }
    for (const columns of records.values()) {
      const record = columns[0]!;
      // Dates in one row move together so chronology constraints remain valid.
      const updated = db.prepare(`UPDATE ${record.table} SET ${columns.map(field => `${field.column}=?`).join(",")} WHERE ${record.key}=? AND ${columns.map(field => `${field.column}=?`).join(" AND ")}`)
        .run(...columns.map(field => field.after), record.id, ...columns.map(field => field.before));
      if (Number(updated.changes) !== 1) throw new Error("timestamp repair lost a source record");
    }
    if (timestampRepairInvariants(db) !== invariant) throw new Error("timestamp repair changed protected non-date fields");
    if (planImportedTimestampRepair(db, options).changes.length !== 0) throw new Error("timestamp repair verification failed");
    if (plan.changes.length) {
      if (db.prepare("SELECT 1 FROM system_metadata WHERE key=?").get(REPAIR_KEY)) throw new Error("timestamp repair already recorded with conflicting state");
      db.prepare("INSERT INTO system_metadata(key,value,updated_at) VALUES(?,?,?)")
        .run(REPAIR_KEY, JSON.stringify({ ...plan.summary, protectedStateSha256: invariant, sourceOffsetMinutes: 0, repairedAt: now }), now);
    }
    db.exec("RELEASE SAVEPOINT epay_timestamp_repair");
    return { ...plan.summary, protectedStateSha256: invariant, nonDateFieldsUnchanged: true as const };
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT epay_timestamp_repair");
    db.exec("RELEASE SAVEPOINT epay_timestamp_repair");
    throw error;
  }
}
