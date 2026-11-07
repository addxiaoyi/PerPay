import { createHash } from "node:crypto";

import { canonicalSource } from "./source-drift.ts";

type Row = Record<string, unknown>;
type CollectionName =
  | "merchants"
  | "orders"
  | "ledger"
  | "refunds"
  | "settlements"
  | "callbacks"
  | "syncJobs"
  | "paymentEvents"
  | "orderMirrors"
  | "accessTokens"
  | "invoiceApplications";

const COLLECTIONS: readonly CollectionName[] = [
  "merchants", "orders", "ledger", "refunds", "settlements", "callbacks",
  "syncJobs", "paymentEvents", "orderMirrors", "accessTokens", "invoiceApplications",
];

const KNOWN_FIELDS = new Set([
  ...COLLECTIONS,
  "channels", "balanceSummaryVersion", "balanceSummaries",
]);

const ORDER_FINANCIAL_FIELDS = new Set([
  "merchantId", "merchantOrderId", "amountCents", "platformFeeCents", "merchantNetCents",
  "createdAt", "channel", "feeRate",
]);

const REFUND_FINANCIAL_FIELDS = new Set(["merchantId", "orderId", "amountCents", "channel", "createdAt"]);
const INVOICE_FINANCIAL_FIELDS = new Set(["merchantId", "orderId", "feeCents", "createdAt"]);
const ACTIVITY_IDENTITY_FIELDS = new Set(["merchantId", "orderId", "event", "kind", "idempotencyKey", "payload"]);
const TOKEN_IDENTITY_FIELDS = new Set(["orderId", "scope", "tokenHash", "createdAt"]);

export interface MainDeltaIssue {
  readonly code:
    | "collection_missing"
    | "unknown_collection"
    | "configuration_changed"
    | "record_removed"
    | "immutable_record_changed"
    | "merchant_identity_changed"
    | "financial_order_changed"
    | "order_field_changed"
    | "trade_identity_changed"
    | "invalid_order_transition"
    | "financial_refund_changed"
    | "financial_invoice_changed"
    | "activity_identity_changed"
    | "token_identity_changed"
    | "orphan_record"
    | "merchant_order_mismatch"
    | "payment_amount_mismatch";
  readonly collection: string;
  readonly id: string;
  readonly fields?: readonly string[];
}

export interface MainDeltaCollection {
  readonly added: readonly Row[];
  readonly removed: readonly string[];
  readonly changed: ReadonlyArray<{ id: string; columns: readonly string[] }>;
}

export interface MainPaymentDelta {
  readonly version: 1;
  readonly safe: boolean;
  readonly baselineSha256: string;
  readonly currentSha256: string;
  readonly collections: Readonly<Record<CollectionName, MainDeltaCollection>>;
  readonly issues: readonly MainDeltaIssue[];
}

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function collectionRows(source: unknown, name: CollectionName): readonly Row[] {
  if (!isRow(source)) throw new Error("main payment snapshot is invalid");
  const value = source[name];
  if (!Array.isArray(value)) throw new Error(`main payment collection is missing: ${name}`);
  if (!value.every(isRow)) throw new Error(`main payment collection is invalid: ${name}`);
  return value;
}

function rowId(collection: CollectionName, row: Row): string {
  const value = row.id;
  if (typeof value !== "string" || !value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`main payment ${collection} record ID is invalid`);
  }
  return value;
}

function indexRows(collection: CollectionName, rows: readonly Row[]): Map<string, Row> {
  const indexed = new Map<string, Row>();
  for (const row of rows) {
    const id = rowId(collection, row);
    if (indexed.has(id)) throw new Error(`main payment ${collection} record ID is duplicated`);
    canonicalSource(row);
    indexed.set(id, row);
  }
  return indexed;
}

function digest(source: unknown): string {
  return createHash("sha256").update(canonicalSource(source)).digest("hex");
}

function changedColumns(before: Row, after: Row): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter(key => !Object.hasOwn(before, key) || !Object.hasOwn(after, key) || canonicalSource(before[key]) !== canonicalSource(after[key]));
}

function issue(code: MainDeltaIssue["code"], collection: string, id: string, fields?: readonly string[]): MainDeltaIssue {
  return fields?.length ? { code, collection, id, fields: [...fields] } : { code, collection, id };
}

function hasChanged(columns: readonly string[], fields: ReadonlySet<string>): string[] {
  return columns.filter(column => fields.has(column));
}

function validateOrderTransition(before: Row, after: Row, issues: MainDeltaIssue[], id: string): void {
  const previous = typeof before.status === "string" ? before.status : "";
  const next = typeof after.status === "string" ? after.status : "";
  const allowed = new Map([
    ["pending_sync", new Set(["pending_sync", "pending_payment", "failed", "closed", "expired", "paid"])],
    ["pending_payment", new Set(["pending_payment", "failed", "closed", "expired", "paid"])],
    ["paid", new Set(["paid", "refund_processing", "refunded"])],
    ["refund_processing", new Set(["refund_processing", "refunded"])],
    ["refunded", new Set(["refunded"])],
    ["failed", new Set(["failed"])],
    ["closed", new Set(["closed"])],
    ["expired", new Set(["expired", "paid"])],
  ]);
  if (!allowed.get(previous)?.has(next)) issues.push(issue("invalid_order_transition", "orders", id, ["status"]));
}

function validateRelationships(source: unknown, issues: MainDeltaIssue[]): void {
  if (!isRow(source)) return;
  const merchants = new Set(collectionRows(source, "merchants").map(rowId.bind(null, "merchants")));
  const orders = new Map(collectionRows(source, "orders").map(row => [rowId("orders", row), row]));

  for (const row of collectionRows(source, "orders")) {
    const id = rowId("orders", row);
    if (typeof row.merchantId !== "string" || !merchants.has(row.merchantId)) issues.push(issue("orphan_record", "orders", id, ["merchantId"]));
  }

  for (const row of collectionRows(source, "ledger")) {
    const id = rowId("ledger", row);
    if (typeof row.merchantId !== "string" || !merchants.has(row.merchantId)) {
      issues.push(issue("orphan_record", "ledger", id, ["merchantId"]));
      continue;
    }
    if (row.type === "payment_paid") {
      const orderId = row.orderId;
      const order = typeof orderId === "string" ? orders.get(orderId) : undefined;
      if (!order) {
        issues.push(issue("orphan_record", "ledger", id, ["orderId"]));
        continue;
      }
      if (order.merchantId !== row.merchantId) issues.push(issue("merchant_order_mismatch", "ledger", id, ["merchantId", "orderId"]));
      if (Number.isSafeInteger(row.grossCents) && Number.isSafeInteger(order.amountCents) && row.grossCents !== order.amountCents) issues.push(issue("payment_amount_mismatch", "ledger", id, ["grossCents", "amountCents"]));
    }
  }

  for (const collection of ["refunds", "callbacks", "syncJobs", "orderMirrors", "paymentEvents", "invoiceApplications"] as const) {
    for (const row of collectionRows(source, collection)) {
      const id = rowId(collection, row);
      const order = typeof row.orderId === "string" ? orders.get(row.orderId) : undefined;
      const merchantId = collection === "syncJobs" && row.merchantId == null ? order?.merchantId : row.merchantId;
      if (typeof merchantId !== "string" || !merchants.has(merchantId)) issues.push(issue("orphan_record", collection, id, ["merchantId"]));
      if (typeof row.orderId === "string") {
        if (!order) issues.push(issue("orphan_record", collection, id, ["orderId"]));
        else if (order.merchantId !== merchantId) issues.push(issue("merchant_order_mismatch", collection, id, ["merchantId", "orderId"]));
      }
    }
  }
}

function compareCollection(collection: CollectionName, baseline: unknown, current: unknown, issues: MainDeltaIssue[]): MainDeltaCollection {
  const before = indexRows(collection, collectionRows(baseline, collection));
  const after = indexRows(collection, collectionRows(current, collection));
  const added: Row[] = [];
  const removed: string[] = [];
  const changed: Array<{ id: string; columns: readonly string[] }> = [];

  for (const [id, row] of before) {
    const next = after.get(id);
    if (!next) {
      removed.push(id);
      issues.push(issue("record_removed", collection, id));
      continue;
    }
    const columns = changedColumns(row, next);
    if (!columns.length) continue;
    changed.push({ id, columns });
    if (collection === "merchants") {
      const identity = hasChanged(columns, new Set(["apiId", "userId"]));
      if (identity.length) issues.push(issue("merchant_identity_changed", collection, id, identity));
    } else if (collection === "orders") {
      if (columns.includes("merchantId")) issues.push(issue("merchant_identity_changed", collection, id, ["merchantId"]));
      const financial = hasChanged(columns, ORDER_FINANCIAL_FIELDS);
      if (financial.length) issues.push(issue("financial_order_changed", collection, id, financial));
      const tradeIdentity = hasChanged(columns, new Set(["tradeNo", "wechatOutTradeNo", "gatewayOrderId", "paymentEventKey", "paidAt"]))
        .filter(column => row[column] !== undefined && row[column] !== null && row[column] !== "");
      if (tradeIdentity.length) issues.push(issue("trade_identity_changed", collection, id, tradeIdentity));
      const allowed = new Set(["status", "paidAt", "tradeNo", "wechatOutTradeNo", "paymentEventKey", "refundStatus", "closedAt", "syncedAt", "lastError", "gatewayOrderId", "paymentUrl", "qrCode", "paymentHtml", "paymentFields"]);
      const unsupported = columns.filter(column => !ORDER_FINANCIAL_FIELDS.has(column) && !allowed.has(column));
      if (unsupported.length) issues.push(issue("order_field_changed", collection, id, unsupported));
      validateOrderTransition(row, next, issues, id);
    } else if (collection === "settlements") {
      const allowed = new Set(["status", "reviewedAt", "reviewedBy", "reference"]);
      if (columns.some(column => !allowed.has(column)) || row.status !== "pending" || !["paid", "rejected"].includes(String(next.status)) || typeof next.reviewedBy !== "string" || !next.reviewedBy || typeof next.reviewedAt !== "string" || !Number.isFinite(Date.parse(next.reviewedAt)) || (next.status === "paid" && (typeof next.reference !== "string" || !next.reference))) issues.push(issue("immutable_record_changed", collection, id, columns));
    } else if (collection === "ledger" || collection === "paymentEvents") {
      issues.push(issue("immutable_record_changed", collection, id, columns));
    } else if (collection === "refunds") {
      const financial = hasChanged(columns, REFUND_FINANCIAL_FIELDS);
      if (financial.length) issues.push(issue("financial_refund_changed", collection, id, financial));
    } else if (collection === "invoiceApplications") {
      const financial = hasChanged(columns, INVOICE_FINANCIAL_FIELDS);
      if (financial.length) issues.push(issue("financial_invoice_changed", collection, id, financial));
    } else if (collection === "accessTokens") {
      const identity = hasChanged(columns, TOKEN_IDENTITY_FIELDS);
      if (identity.length) issues.push(issue("token_identity_changed", collection, id, identity));
    } else {
      const identity = hasChanged(columns, ACTIVITY_IDENTITY_FIELDS);
      if (identity.length) issues.push(issue("activity_identity_changed", collection, id, identity));
    }
  }

  for (const [id, row] of after) if (!before.has(id)) added.push(row);
  return { added, removed, changed };
}

export function planMainPaymentDelta(baseline: unknown, current: unknown): MainPaymentDelta {
  if (!isRow(baseline) || !isRow(current)) throw new Error("main payment delta requires object snapshots");
  const issues: MainDeltaIssue[] = [];
  for (const name of COLLECTIONS) {
    if (!Array.isArray(baseline[name]) || !Array.isArray(current[name])) issues.push(issue("collection_missing", name, name));
  }
  for (const name of [...new Set([...Object.keys(baseline), ...Object.keys(current)])]) {
    if (!KNOWN_FIELDS.has(name)) issues.push(issue("unknown_collection", name, name));
  }
  const channelsChanged = Object.hasOwn(baseline, "channels") !== Object.hasOwn(current, "channels") ||
    (Object.hasOwn(baseline, "channels") && canonicalSource(baseline.channels) !== canonicalSource(current.channels));
  if (channelsChanged) issues.push(issue("configuration_changed", "channels", "channels"));
  const collections = Object.fromEntries(COLLECTIONS.map(name => [
    name,
    Array.isArray(baseline[name]) && Array.isArray(current[name]) ? compareCollection(name, baseline, current, issues) : { added: [], removed: [], changed: [] },
  ])) as Readonly<Record<CollectionName, MainDeltaCollection>>;
  if (COLLECTIONS.every(name => Array.isArray(current[name]))) validateRelationships(current, issues);
  return {
    version: 1,
    safe: issues.length === 0,
    baselineSha256: digest(baseline),
    currentSha256: digest(current),
    collections,
    issues,
  };
}
