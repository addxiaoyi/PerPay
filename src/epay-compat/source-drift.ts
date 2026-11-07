import { createHash } from "node:crypto";

type SourceRow = Record<string, unknown>;

export function canonicalSource(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalSource).join(",")}]`;
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("migration source contains a non-JSON value");
  }
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalSource((value as SourceRow)[key])}`).join(",")}}`;
}

function indexRows(rows: readonly SourceRow[], primaryKey: string): Map<string, SourceRow> {
  const indexed = new Map<string, SourceRow>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("invalid migration source row");
    const id = row[primaryKey];
    if ((typeof id !== "string" || !id) && (typeof id !== "number" || !Number.isSafeInteger(id))) {
      throw new Error("migration source has an invalid primary key");
    }
    const key = String(id);
    if (indexed.has(key)) throw new Error("migration source has a duplicate primary key");
    canonicalSource(row);
    indexed.set(key, row);
  }
  return indexed;
}

function digestRows(rows: Map<string, SourceRow>): string {
  const sorted = [...rows].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return createHash("sha256").update(canonicalSource(sorted)).digest("hex");
}

// Reports identities and changed column names, never values containing channel credentials.
export function compareMigrationRows(baseline: readonly SourceRow[], current: readonly SourceRow[], primaryKey: string) {
  const before = indexRows(baseline, primaryKey), after = indexRows(current, primaryKey);
  const added: string[] = [], removed: string[] = [];
  const changed: Array<{ id: string; columns: string[] }> = [];
  for (const [id, row] of before) {
    const next = after.get(id);
    if (!next) { removed.push(id); continue; }
    const columns = [...new Set([...Object.keys(row), ...Object.keys(next)])].sort().filter(key =>
      !Object.hasOwn(row, key) || !Object.hasOwn(next, key) || canonicalSource(row[key]) !== canonicalSource(next[key]));
    if (columns.length) changed.push({ id, columns });
  }
  for (const id of after.keys()) if (!before.has(id)) added.push(id);
  return { baselineCount: before.size, currentCount: after.size, baselineSha256: digestRows(before), currentSha256: digestRows(after), added: added.sort(), removed: removed.sort(), changed };
}
