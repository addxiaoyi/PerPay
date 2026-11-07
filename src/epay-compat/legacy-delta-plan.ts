import { SOURCE_TABLES } from "./snapshot.ts";
import { compareMigrationRows } from "./source-drift.ts";

export type LegacyRow = Record<string, unknown>;
export type LegacyKind = keyof typeof SOURCE_TABLES;
export type LegacyTables = Record<LegacyKind, LegacyRow[]>;
export type LegacyColumns = Record<LegacyKind, string[]>;
const mutable = {
  Order: new Set(["status", "apiTradeNo", "realMoney", "getMoney", "paidAt", "updatedAt", "notifyStatus", "notifyCount", "notifyLastAt", "buyer", "buyerEmail", "providerResult"]),
  NotifyLog: new Set(["responseCode", "responseBody", "status", "error"]),
  Invoice: new Set(["status", "externalId", "receiptPdfPath", "providerMessage", "updatedAt", "issuedAt", "chargedAt"]),
  InvoiceApplication: new Set(["status", "updatedAt", "invoiceNo", "invoiceUrl", "issuedAt", "errorCode", "errorMessage", "emailSent", "emailError"]),
};
const transitions: Record<string, ReadonlySet<string>> = {
  PENDING: new Set(["PENDING", "PAID", "FROZEN", "CLOSED"]),
  PAID: new Set(["PAID", "REFUNDED", "FROZEN"]),
  FROZEN: new Set(["FROZEN", "PAID", "REFUNDED", "CLOSED"]),
  REFUNDED: new Set(["REFUNDED"]), CLOSED: new Set(["CLOSED"]),
};

export function validateLegacyTables(tables: LegacyTables): void {
  if (!tables || typeof tables !== "object" || Array.isArray(tables) || Object.keys(tables).length !== Object.keys(SOURCE_TABLES).length) throw new Error("legacy synchronization source tables differ");
  for (const [kind, primary] of Object.entries(SOURCE_TABLES) as Array<[LegacyKind, string]>) {
    if (!Array.isArray(tables[kind])) throw new Error("legacy synchronization source collection is missing");
    compareMigrationRows(tables[kind], tables[kind], primary);
  }
}

export function validateLegacyColumns(tables: LegacyTables, columns: LegacyColumns): void {
  if (!columns || Object.keys(columns).length !== Object.keys(SOURCE_TABLES).length) throw new Error("legacy synchronization source schema is missing");
  for (const [kind, primary] of Object.entries(SOURCE_TABLES) as Array<[LegacyKind, string]>) {
    const names = columns[kind];
    if (!Array.isArray(names) || new Set(names).size !== names.length || !names.includes(primary) || names.some(name => typeof name !== "string" || !name)) throw new Error("legacy synchronization source columns differ");
    if (tables[kind].some(row => Object.keys(row).length !== names.length || names.some(name => !Object.hasOwn(row, name)))) throw new Error("legacy synchronization row columns differ");
  }
}

export function planLegacyDelta(before: LegacyTables, after: LegacyTables) {
  validateLegacyTables(before); validateLegacyTables(after);
  const changes = [] as Array<{ kind: keyof typeof mutable; id: string; before: LegacyRow | undefined; after: LegacyRow }>;
  for (const [kind, primary] of Object.entries(SOURCE_TABLES) as Array<[LegacyKind, string]>) {
    const diff = compareMigrationRows(before[kind], after[kind], primary);
    // Administrator sessions remain evidence only; they never authorize PerPay requests.
    if (kind === "AdminSession") continue;
    if (diff.removed.length) throw new Error(`legacy synchronization removed a ${kind} record`);
    if (!Object.hasOwn(mutable, kind)) {
      if (diff.added.length || diff.changed.length) throw new Error(`legacy synchronization configuration changed: ${kind}`);
      continue;
    }
    const collection = kind as keyof typeof mutable;
    if (kind === "Order" && diff.added.length) throw new Error("legacy synchronization cannot admit new orders after cutoff");
    const oldRows = new Map(before[kind].map(row => [String(row[primary]), row]));
    const newRows = new Map(after[kind].map(row => [String(row[primary]), row]));
    for (const change of diff.changed) {
      if (change.columns.some(column => !mutable[collection].has(column))) throw new Error(`legacy synchronization immutable ${kind} field changed`);
      const old = oldRows.get(change.id)!, next = newRows.get(change.id)!;
      if (kind === "Order") {
        if (!transitions[String(old.status)]?.has(String(next.status))) throw new Error("legacy synchronization order transition is invalid");
        for (const key of ["apiTradeNo", "realMoney", "getMoney", "paidAt"]) {
          if (old[key] != null && old[key] !== "" && old[key] !== next[key]) throw new Error("legacy synchronization payment identity changed");
        }
        if (!Number.isSafeInteger(next.notifyCount) || Number(next.notifyCount) < Number(old.notifyCount)) throw new Error("legacy synchronization notification count regressed");
      }
      changes.push({ kind: collection, id: change.id, before: old, after: next });
    }
    for (const id of diff.added) changes.push({ kind: collection, id, before: undefined, after: newRows.get(id)! });
  }
  const orders = new Map(after.Order.map(row => [String(row.tradeNo), row]));
  for (const kind of ["NotifyLog", "Invoice", "InvoiceApplication"] as const) for (const row of after[kind]) {
    const order = orders.get(String(row.tradeNo));
    if (!order || (kind !== "NotifyLog" && (row.merchantId !== order.merchantId || (kind === "InvoiceApplication" && row.outTradeNo !== order.outTradeNo)))) throw new Error("legacy synchronization order ownership differs");
  }
  return changes;
}
