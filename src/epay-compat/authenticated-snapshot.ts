import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { SNAPSHOT_MANIFEST_TABLE, SOURCE_TABLES, type SnapshotOptions } from "./snapshot.ts";

type TableName = keyof typeof SOURCE_TABLES;
type SnapshotRow = Record<string, unknown>;
interface StoredRow {
  row_index: bigint | number;
  cipher_version: bigint | number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authentication_tag: Uint8Array;
}

export function readAuthenticatedEPaySnapshot(options: Omit<SnapshotOptions, "source">, snapshotId: string) {
  const cipher = new RuntimeSecretCipher(options.masterKey, options.instanceId);
  return options.database.read((db) => {
    const metadata = db.prepare("SELECT source_name, counts_json FROM epay_snapshot_runs WHERE snapshot_id = ?").get(snapshotId) as { source_name: string; counts_json: string } | undefined;
    if (!metadata) throw new Error("snapshot does not exist");
    if (metadata.source_name !== options.sourceName) throw new Error("snapshot source name mismatch");
    let counts: unknown;
    try { counts = JSON.parse(metadata.counts_json); } catch { throw new Error("snapshot counts are invalid"); }
    const names = Object.keys(SOURCE_TABLES) as TableName[];
    if (!counts || typeof counts !== "object" || Array.isArray(counts) || Object.keys(counts).length !== names.length || names.some((name) => !Number.isSafeInteger((counts as Record<string, unknown>)[name]) || Number((counts as Record<string, unknown>)[name]) < 0)) throw new Error("snapshot counts are invalid");
    const expected = counts as Record<TableName, number>;
    const sources = db.prepare("SELECT DISTINCT source_table FROM epay_snapshot_rows WHERE snapshot_id = ?").all(snapshotId) as Array<{ source_table: string }>;
    if (sources.some((row) => row.source_table !== SNAPSHOT_MANIFEST_TABLE && !Object.hasOwn(SOURCE_TABLES, row.source_table))) throw new Error("snapshot contains an unknown table");
    const select = db.prepare("SELECT row_index, cipher_version, nonce, ciphertext, authentication_tag FROM epay_snapshot_rows WHERE snapshot_id = ? AND source_table = ? ORDER BY row_index");
    const manifestRows = select.all(snapshotId, SNAPSHOT_MANIFEST_TABLE) as unknown as StoredRow[];
    if (manifestRows.length !== 1 || Number(manifestRows[0]!.row_index) !== 0 || Number(manifestRows[0]!.cipher_version) !== 1) throw new Error("snapshot is missing an authenticated manifest; recapture it");
    function decrypt(row: StoredRow, table: string, index: number): unknown {
      try {
        const plaintext = cipher.decrypt(`epay:snapshot:${snapshotId}:${table}:${index}`, 1, {
          cipherVersion: 1,
          nonce: Buffer.from(row.nonce),
          ciphertext: Buffer.from(row.ciphertext),
          authenticationTag: Buffer.from(row.authentication_tag),
        });
        try { return JSON.parse(plaintext.toString("utf8")); }
        finally { plaintext.fill(0); }
      } catch (cause) {
        throw new Error(table === SNAPSHOT_MANIFEST_TABLE ? "snapshot manifest authentication failed" : `snapshot row authentication failed for ${table}`, { cause });
      }
    }
    const manifest = decrypt(manifestRows[0]!, SNAPSHOT_MANIFEST_TABLE, 0);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("snapshot manifest is invalid");
    const authenticated = manifest as { version?: unknown; snapshotId?: unknown; sourceName?: unknown; counts?: unknown; columns?: unknown };
    if ((authenticated.version !== 1 && authenticated.version !== 2) || authenticated.snapshotId !== snapshotId || authenticated.sourceName !== metadata.source_name || !authenticated.counts || typeof authenticated.counts !== "object" || Array.isArray(authenticated.counts)) throw new Error("snapshot manifest metadata mismatch");
    if (options.requireColumnMetadata && authenticated.version !== 2) throw new Error("snapshot is missing authenticated column metadata; recapture it");
    let columns: Record<TableName, string[]> | null = null;
    if (authenticated.version === 2) {
      const raw = authenticated.columns;
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== names.length) throw new Error("snapshot manifest columns are invalid");
      columns = raw as Record<TableName, string[]>;
      for (const name of names) {
        const namesForTable = columns[name];
        if (!Array.isArray(namesForTable) || namesForTable.length === 0 || namesForTable.some((column) => typeof column !== "string" || !column) || new Set(namesForTable).size !== namesForTable.length || !namesForTable.includes(SOURCE_TABLES[name])) throw new Error(`snapshot manifest columns are invalid for ${name}`);
      }
    }
    const sealedCounts = authenticated.counts as Record<string, unknown>;
    if (Object.keys(sealedCounts).length !== names.length || names.some((name) => sealedCounts[name] !== expected[name])) throw new Error("snapshot manifest count mismatch");
    const tables = {} as Record<TableName, SnapshotRow[]>;
    for (const name of names) {
      const rows = select.all(snapshotId, name) as unknown as StoredRow[];
      if (rows.length !== expected[name]) throw new Error(`snapshot recorded count mismatch for ${name}`);
      const ids = new Set<string>();
      tables[name] = rows.map((row, index) => {
        if (Number(row.row_index) !== index || Number(row.cipher_version) !== 1) throw new Error(`snapshot row metadata mismatch for ${name}`);
        const value = decrypt(row, name, index);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`snapshot row is invalid for ${name}`);
        if (columns && (Object.keys(value).length !== columns[name].length || columns[name].some((column) => !Object.hasOwn(value, column)))) throw new Error(`snapshot row columns mismatch for ${name}`);
        const primaryKey = (value as SnapshotRow)[SOURCE_TABLES[name]];
        if ((typeof primaryKey !== "string" || !primaryKey) && (typeof primaryKey !== "number" || !Number.isSafeInteger(primaryKey))) throw new Error(`snapshot primary key is invalid for ${name}`);
        const id = String(primaryKey);
        if (ids.has(id)) throw new Error(`snapshot primary key is duplicated for ${name}`);
        ids.add(id);
        return value as SnapshotRow;
      });
    }
    return { counts: expected, tables, columns };
  });
}
