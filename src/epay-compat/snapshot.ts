import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { RuntimeSecretCipher } from "../settings/crypto.ts";

export const SOURCE_TABLES = {
  Merchant: "id",
  AdminSession: "id",
  MerchantBinding: "id",
  MerchantInvoiceConfig: "merchantId",
  PayType: "id",
  Channel: "id",
  Order: "tradeNo",
  NotifyLog: "id",
  Invoice: "id",
  InvoiceApplication: "id",
  Config: "key",
} as const;

export const SNAPSHOT_MANIFEST_TABLE = "__manifest__";

export interface SnapshotSource {
  query(sql: string): Promise<[unknown, unknown]>;
}

export interface SnapshotDatabase {
  read<T>(operation: (database: DatabaseSync) => T): T;
  write<T>(operation: (database: DatabaseSync) => T): T;
}

export interface SnapshotOptions {
  source: SnapshotSource;
  database: SnapshotDatabase;
  masterKey: Uint8Array;
  instanceId: string;
  sourceName: string;
  requireColumnMetadata?: boolean;
}

export function readSourceColumns(fields: unknown, table: string): string[] {
  if (!Array.isArray(fields) || fields.length === 0) throw new Error(`source column metadata missing for ${table}`);
  const columns = fields.map((field) => {
    if (!field || typeof field !== "object" || typeof field.name !== "string" || !field.name) throw new Error(`invalid source column metadata for ${table}`);
    return field.name as string;
  });
  if (new Set(columns).size !== columns.length) throw new Error(`duplicate source columns for ${table}`);
  return columns;
}

export async function captureEPaySnapshot(options: SnapshotOptions): Promise<{ snapshotId: string; counts: Record<string, number> }> {
  if (!options.sourceName.trim() || options.sourceName.length > 128) throw new Error("invalid snapshot source name");
  const snapshotId = randomUUID();
  const cipher = new RuntimeSecretCipher(options.masterKey, options.instanceId);
  const tables: Array<{ name: string; rows: unknown[] }> = [];
  const counts: Record<string, number> = {};
  const columns: Record<string, string[]> = {};
  let transactionOpen = false;

  try {
    await options.source.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await options.source.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    transactionOpen = true;
    for (const [name, primaryKey] of Object.entries(SOURCE_TABLES)) {
      const [rows, fields] = await options.source.query(`SELECT * FROM \`${name}\` ORDER BY \`${primaryKey}\``);
      if (!Array.isArray(rows)) throw new Error(`snapshot source did not return rows for ${name}`);
      if (options.requireColumnMetadata) {
        columns[name] = readSourceColumns(fields, name);
        if (!columns[name].includes(primaryKey)) throw new Error(`source primary key column missing for ${name}`);
      }
      const ids = new Set<string>();
      for (const row of rows) {
        if (options.requireColumnMetadata && row && typeof row === "object" && !Array.isArray(row)) {
          const names = Object.keys(row);
          if (names.length !== columns[name]!.length || columns[name]!.some((column) => !Object.hasOwn(row, column))) throw new Error(`snapshot row columns mismatch for ${name}`);
        }
        const key = row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>)[primaryKey] : undefined;
        if ((typeof key !== "string" || !key) && (typeof key !== "number" || !Number.isSafeInteger(key))) throw new Error(`snapshot source primary key is invalid in ${name}`);
        const id = String(key);
        if (ids.has(id)) throw new Error(`snapshot source primary key is duplicated in ${name}`);
        ids.add(id);
      }
      tables.push({ name, rows });
      counts[name] = rows.length;
    }
    await options.source.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { await options.source.query("ROLLBACK"); } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "EPay snapshot and source rollback failed");
      }
    }
    throw error;
  }

  options.database.write((db) => {
    db.prepare("INSERT INTO epay_snapshot_runs VALUES (?, ?, ?, ?)").run(snapshotId, options.sourceName, Date.now(), JSON.stringify(counts));
    const insert = db.prepare("INSERT INTO epay_snapshot_rows VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const table of tables) {
      table.rows.forEach((row, index) => {
        const payload = JSON.stringify(row);
        if (payload === undefined) throw new Error(`cannot serialize snapshot row in ${table.name}`);
        const encrypted = cipher.encrypt(`epay:snapshot:${snapshotId}:${table.name}:${index}`, 1, payload);
        insert.run(snapshotId, table.name, index, encrypted.cipherVersion, encrypted.nonce, encrypted.ciphertext, encrypted.authenticationTag);
      });
    }
    const manifest = JSON.stringify(options.requireColumnMetadata
      ? { version: 2, snapshotId, sourceName: options.sourceName, counts, columns }
      : { version: 1, snapshotId, sourceName: options.sourceName, counts });
    const sealed = cipher.encrypt(`epay:snapshot:${snapshotId}:${SNAPSHOT_MANIFEST_TABLE}:0`, 1, manifest);
    insert.run(snapshotId, SNAPSHOT_MANIFEST_TABLE, 0, sealed.cipherVersion, sealed.nonce, sealed.ciphertext, sealed.authenticationTag);
  });
  return { snapshotId, counts };
}
