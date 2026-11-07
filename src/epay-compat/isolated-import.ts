import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { RuntimeSecretCipher, type EncryptedSecret, type EPayCipherSecretName } from "../settings/crypto.ts";
import { readAuthenticatedEPaySnapshot } from "./authenticated-snapshot.ts";
import { parseSourceTimestamp } from "./source-timestamp.ts";
import { parseLegacyCents } from "./money.ts";
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from "./schema.ts";
import { SOURCE_TABLES, type SnapshotOptions } from "./snapshot.ts";
import { EPAY_CHANNEL_CONFIG_SCHEMA_SQL, readEncryptedChannelConfig, writeEncryptedChannelConfig } from "./channel-config.ts";
import { auditMainLedger } from "./main-ledger-audit.ts";
import { auditMainPayments } from "./main-payment-audit.ts";
import { EPAY_MAIN_LEDGER_SOURCE_SCHEMA_SQL, readEncryptedMainLedgerSource, writeEncryptedMainLedgerSource } from "./main-ledger-source.ts";
import { EPAY_MAIN_ORDER_SOURCE_SCHEMA_SQL, readEncryptedMainOrder, writeEncryptedMainOrder } from "./main-order-source.ts";
import { EPAY_MAIN_REFUND_SOURCE_SCHEMA_SQL } from "./main-refund-source.ts";
import { importMainRefundsInTransaction } from "./main-refund-import.ts";
import { auditMainRefunds } from "./main-refund-audit.ts";
import { verifyWechatMasterKeyGuard } from "./wechat-master-key.ts";
import { EPAY_LEGACY_INVOICE_CONFIG_SCHEMA_SQL } from "./legacy-invoice-config-schema.ts";

type Row = Record<string, unknown>;
export const MAPPED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  Merchant: ["id", "name", "apiKey", "money", "status", "createdAt", "updatedAt"],
  MerchantBinding: ["id", "mainApiId", "mainMerchantId", "epayMerchantId", "createdAt", "updatedAt"],
  PayType: ["id", "code", "name", "enabled", "sort", "createdAt", "updatedAt"],
  Channel: ["id", "typeId", "provider", "code", "name", "product", "enabled", "rate", "payMin", "payMax", "config", "createdAt", "updatedAt"],
  Order: ["tradeNo", "outTradeNo", "apiTradeNo", "merchantId", "typeId", "channelId", "typeCode", "channelCode", "name", "money", "realMoney", "getMoney", "notifyUrl", "returnUrl", "param", "domain", "ip", "device", "buyer", "payUrl", "qrCode", "urlScheme", "providerResult", "status", "notifyStatus", "notifyCount", "notifyLastAt", "createdAt", "paidAt", "updatedAt", "buyerEmail"],
  NotifyLog: ["id", "tradeNo", "url", "params", "responseCode", "responseBody", "status", "error", "createdAt"],
  Invoice: ["id", "tradeNo", "kind", "merchantId", "title", "taxId", "email", "amount", "status", "provider", "externalId", "receiptPdfPath", "providerMessage", "createdAt", "updatedAt", "issuedAt", "serviceFee", "chargedAt"],
  InvoiceApplication: ["id", "merchantId", "tradeNo", "outTradeNo", "title", "taxId", "email", "feeCents", "status", "createdAt", "updatedAt", "invoiceNo", "invoiceUrl", "issuedAt", "errorCode", "errorMessage", "emailSent", "emailError"],
  Config: ["key", "value", "updatedAt"],
};

export function assertMappedSourceMetadata(metadata: unknown): void {
  if (!Array.isArray(metadata)) throw new Error("invalid source column metadata");
  const actual = new Map<string, Set<string>>();
  for (const item of metadata) {
    if (!item || typeof item !== "object" || typeof item.TABLE_NAME !== "string" || typeof item.COLUMN_NAME !== "string") throw new Error("invalid source column metadata");
    const table = item.TABLE_NAME as string;
    const column = item.COLUMN_NAME as string;
    if (!Object.hasOwn(MAPPED_COLUMNS, table)) continue;
    const columns = actual.get(table) ?? new Set<string>();
    if (columns.has(column)) throw new Error(`duplicate source column in ${table}: ${column}`);
    columns.add(column);
    actual.set(table, columns);
  }
  for (const [table, expected] of Object.entries(MAPPED_COLUMNS)) {
    const columns = actual.get(table) ?? new Set<string>();
    const allowed = new Set(expected);
    for (const column of columns) if (!allowed.has(column)) throw new Error(`unmapped column in ${table}: ${column}`);
    for (const column of expected) if (!columns.has(column)) throw new Error(`missing column in ${table}: ${column}`);
  }
}

function assertMappedColumns(table: string, row: Row): void {
  const columns = MAPPED_COLUMNS[table];
  if (!columns) throw new Error(`unknown mapped source table: ${table}`);
  const allowed = new Set(columns);
  for (const key of Object.keys(row)) if (!allowed.has(key)) throw new Error(`unmapped column in ${table}: ${key}`);
  for (const key of columns) if (!Object.hasOwn(row, key)) throw new Error(`missing ${key}`);
}

type Options = Omit<SnapshotOptions, "source"> & {
  readonly merchantFeeBps: Readonly<Record<string, number>>;
  readonly sourceOffsetMinutes: number;
  readonly mainPayment?: unknown;
  readonly preserveRefundsForRehearsal?: boolean;
};

function string(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`invalid ${key}`);
  return value;
}
function optionalString(row: Row, key: string): string | null {
  if (!Object.hasOwn(row, key)) throw new Error(`missing ${key}`);
  return row[key] == null ? null : string(row, key);
}
function integer(row: Row, key: string): number {
  const value = row[key];
  if ((typeof value !== "number" && (typeof value !== "string" || !/^-?\d+$/.test(value))) || !Number.isSafeInteger(Number(value))) throw new Error(`invalid ${key}`);
  return Number(value);
}
function optionalInteger(row: Row, key: string): number | null {
  if (!Object.hasOwn(row, key)) throw new Error(`missing ${key}`);
  return row[key] == null ? null : integer(row, key);
}
function bool(row: Row, key: string): number {
  const value = row[key];
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;
  throw new Error(`invalid ${key}`);
}
function cents(row: Row, key: string): number {
  return parseLegacyCents(string(row, key));
}
function optionalCents(row: Row, key: string): number | null {
  if (!Object.hasOwn(row, key)) throw new Error(`missing ${key}`);
  return row[key] == null ? null : cents(row, key);
}
function timestamp(row: Row, key: string, offsetMinutes: number): number {
  try { return parseSourceTimestamp(string(row, key), offsetMinutes); }
  catch (cause) { throw new Error(`invalid ${key}`, { cause }); }
}
function optionalTime(row: Row, key: string, offsetMinutes: number): number | null {
  if (!Object.hasOwn(row, key)) throw new Error(`missing ${key}`);
  return row[key] == null ? null : timestamp(row, key, offsetMinutes);
}
function json(row: Row, key: string): string | null {
  if (!Object.hasOwn(row, key)) throw new Error(`missing ${key}`);
  const value = row[key];
  if (value == null) return null;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof serialized !== "string") throw new Error(`invalid ${key}`);
  try { JSON.parse(serialized); } catch { throw new Error(`invalid ${key}`); }
  return serialized;
}

function verifyMappedRow(db: DatabaseSync, table: string, keyColumn: string, key: SQLInputValue, expected: Record<string, SQLInputValue>): void {
  const columns = Object.keys(expected);
  const actual = db.prepare(`SELECT ${columns.join(",")} FROM ${table} WHERE ${keyColumn} = ?`).get(key);
  if (!actual || columns.some((column) => {
    const value = actual[column], wanted = expected[column];
    if (typeof value === "bigint" && typeof wanted === "number") return !Number.isSafeInteger(wanted) || value !== BigInt(wanted);
    return value !== wanted;
  })) throw new Error(`isolated import ${table} field mismatch`);
}

// Snapshot provenance and reconciliation remain the caller's responsibility.
export function importMainLedgerInTransaction(db: DatabaseSync, cipher: RuntimeSecretCipher, payment: unknown): { count: number; summaryVerified: boolean } {
  if (!db.isTransaction) throw new Error("main ledger import requires a transaction");
  verifyWechatMasterKeyGuard(db, cipher);
  const prior = db.prepare("SELECT 1 FROM epay_main_ledger_import_runs WHERE singleton_key=1").get();
  const existing = db.prepare("SELECT EXISTS(SELECT 1 FROM epay_balance_ledger WHERE source='main_site') OR EXISTS(SELECT 1 FROM epay_main_ledger_sources) AS present").get();
  if (prior || !existing || Number(existing.present) !== 0) throw new Error("main ledger target is not empty or was already imported");
  db.exec("SAVEPOINT epay_main_ledger_import");
  try {
  const audit = auditMainLedger(payment);
  if (audit.missingMerchantReferences || audit.unsupportedFeePrecision || audit.summaryMismatches) throw new Error("main ledger has unresolved merchants, fee precision or balance summary differences");
  const source = payment as { merchants: Row[]; ledger: Row[] };
  const bindings = new Map<string, number>();
  for (const merchant of source.merchants) {
    const id = string(merchant, "id");
    const apiId = string(merchant, "apiId");
    const binding = db.prepare("SELECT epay_merchant_id FROM epay_merchant_bindings WHERE main_merchant_id=? AND main_api_id=?").get(id, apiId);
    if (!binding || !Number.isSafeInteger(Number(binding.epay_merchant_id)) || Number(binding.epay_merchant_id) < 1) throw new Error("main ledger merchant binding is unresolved");
    bindings.set(id, Number(binding.epay_merchant_id));
  }
  const insert = db.prepare("INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,reason,actor_id,occurred_at,source) VALUES (?,?,?,?,?,?,?,?, 'main_site')");
  for (const entry of source.ledger) {
    const id = string(entry, "id"), merchantId = string(entry, "merchantId"), type = string(entry, "type"), at = string(entry, "at");
    const target = bindings.get(merchantId);
    const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(?:Z|([+-])(\d\d):(\d\d))$/.exec(at);
    if (!target || !parts) throw new Error("invalid main ledger timestamp or binding");
    const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number) as [number, number, number, number, number, number];
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (year < 1970 || month < 1 || month > 12 || day < 1 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59 || Number(parts[8] ?? 0) > 23 || Number(parts[9] ?? 0) > 59) throw new Error("invalid main ledger timestamp");
    const occurredAt = Date.parse(at);
    if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) throw new Error("invalid main ledger timestamp");
    const available = integer(entry, "availableDelta"), frozen = integer(entry, "frozenDelta");
    const reason = entry.reason == null ? null : string(entry, "reason");
    const actor = entry.actorId == null ? null : string(entry, "actorId");
    const raw = JSON.stringify(entry);
    if (typeof raw !== "string") throw new Error("invalid main ledger source record");
    insert.run(id, target, type, available, frozen, reason, actor, occurredAt);
    writeEncryptedMainLedgerSource(db, cipher, id, raw);
    verifyMappedRow(db, "epay_balance_ledger", "entry_id", id, { merchant_id: target, entry_type: type, available_delta_cents: available, frozen_delta_cents: frozen, reason, actor_id: actor, occurred_at: occurredAt, source: "main_site" });
    if (readEncryptedMainLedgerSource(db, cipher, id) !== raw) throw new Error("main ledger source record mismatch");
  }
  for (const balance of audit.balances) {
    const totals = db.prepare("SELECT coalesce(sum(available_delta_cents),0) AS available, coalesce(sum(frozen_delta_cents),0) AS frozen FROM epay_balance_ledger WHERE merchant_id=? AND source='main_site'").get(bindings.get(balance.merchantId)!);
    if (!totals || BigInt(totals.available as number | bigint) !== BigInt(balance.availableCents) || BigInt(totals.frozen as number | bigint) !== BigInt(balance.frozenCents)) throw new Error("main ledger balance mismatch");
  }
  db.prepare("INSERT INTO epay_main_ledger_import_runs(singleton_key,entry_count) VALUES(1,?)").run(source.ledger.length);
  db.exec("RELEASE SAVEPOINT epay_main_ledger_import");
  return { count: source.ledger.length, summaryVerified: audit.summaryMismatches === 0 };
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT epay_main_ledger_import");
    db.exec("RELEASE SAVEPOINT epay_main_ledger_import");
    throw error;
  }
}

function verifyMainPaymentLinks(payment: unknown, preserveRefundsForRehearsal = false): boolean {
  if (!payment || typeof payment !== "object" || Array.isArray(payment)) throw new Error("main payment store is invalid");
  if (!Object.hasOwn(payment, "orders")) return false;
  const audit = auditMainPayments(payment);
  if (audit.missingOrderMerchantReferences !== 0 || audit.unknownOrderStatuses || audit.unpaidWithPaidAt || audit.paidWithInvalidPaidAt || audit.invalidOrderAmounts || audit.orderAmountMismatches || audit.refundRecordsRequireReconciliation === null || (!preserveRefundsForRehearsal && (audit.refundOrdersRequireReconciliation || audit.refundRecordsRequireReconciliation)) || audit.missingOrderReference || audit.orphanOrderReference || audit.paidWithoutLedger || audit.duplicateLedger || audit.merchantMismatch || audit.invalidAmounts || audit.amountMismatch || audit.ledgerForNonPaid) {
    throw new Error("main payment order and ledger links are inconsistent");
  }
  return !audit.refundOrdersRequireReconciliation && !audit.refundRecordsRequireReconciliation;
}

// Neither rehearsal path enables production import or establishes financial reconciliation.
export function importEPaySnapshotIntoMemory(options: Options, snapshotId: string) {
  return importSnapshot(options, snapshotId);
}

// Candidate only: provenance, financial reconciliation and cutover remain separate gates.
export function importEPaySnapshotInTransaction(options: Options, snapshotId: string, target: { database: DatabaseSync; instanceId: string }) {
  if (!target.database.isTransaction) throw new Error("EPay import requires a target transaction");
  const foreignKeys = target.database.prepare("PRAGMA foreign_keys").get();
  if (Number(foreignKeys?.foreign_keys) !== 1) throw new Error("EPay import requires foreign keys enabled");
  const instance = target.database.prepare("SELECT value FROM system_metadata WHERE key = 'instance_id'").get();
  if (!instance || instance.value !== target.instanceId) throw new Error("EPay import target instance mismatch");
  if (options.mainPayment !== undefined || options.preserveRefundsForRehearsal) throw new Error("main-site data requires a separate controlled import");
  return importSnapshot(options, snapshotId, undefined, target);
}

export function createEncryptedEPayRehearsal(options: Options, snapshotId: string) {
  let encrypted: EncryptedSecret | undefined;
  const report = importSnapshot(options, snapshotId, (db, cipher) => {
    const bytes = db.serialize();
    try {
      encrypted = cipher.encrypt(`epay:config:isolated-import:${snapshotId}`, 1, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    } finally {
      bytes.fill(0);
    }
  });
  if (!encrypted) throw new Error("isolated import encryption failed");
  return { report, encrypted };
}

function importSnapshot(options: Options, snapshotId: string, capture?: (db: DatabaseSync, cipher: RuntimeSecretCipher) => void, target?: { database: DatabaseSync; instanceId: string }) {
  if (!Number.isInteger(options.sourceOffsetMinutes) || Math.abs(options.sourceOffsetMinutes) > 840) throw new Error("invalid source timezone offset");
  const snapshot = readAuthenticatedEPaySnapshot(target ? { ...options, requireColumnMetadata: true } : options, snapshotId);
  if (snapshot.columns) {
    const metadata = Object.entries(snapshot.columns).flatMap(([TABLE_NAME, columns]) => columns.map(COLUMN_NAME => ({ TABLE_NAME, COLUMN_NAME })));
    assertMappedSourceMetadata(metadata);
  }
  for (const table of Object.keys(MAPPED_COLUMNS) as Array<keyof typeof snapshot.tables>) {
    for (const row of snapshot.tables[table]) assertMappedColumns(table, row);
  }
  const cipher = new RuntimeSecretCipher(options.masterKey, target?.instanceId ?? options.instanceId);
  const offset = options.sourceOffsetMinutes;
  const emptyTables = ["epay_merchant_accounts", "epay_merchant_secrets", "epay_legacy_invoice_config_source", "epay_merchant_bindings", "epay_pay_types", "epay_channels", "epay_channel_config_secrets", "epay_orders", "epay_notify_logs", "epay_invoices", "epay_invoice_applications", "epay_config_values", "epay_config_secrets", "epay_balance_ledger", "epay_main_ledger_sources", "epay_main_ledger_import_runs", "epay_main_order_sources", "epay_main_order_import_runs", "epay_main_refund_sources", "epay_main_refund_import_runs", "epay_compat_import_runs"];
  if (target) emptyTables.push("epay_main_activity_sources", "epay_main_activity_import_runs");
  const db = target?.database ?? new DatabaseSync(":memory:", { enableForeignKeyConstraints: true, readBigInts: true });
  try {
    if (target) {
      verifyWechatMasterKeyGuard(db, cipher);
    } else {
    db.exec(`PRAGMA temp_store=MEMORY; ${EPAY_COMPATIBILITY_SCHEMA_SQL} ${EPAY_CHANNEL_CONFIG_SCHEMA_SQL} ${EPAY_MAIN_LEDGER_SOURCE_SCHEMA_SQL} ${EPAY_MAIN_ORDER_SOURCE_SCHEMA_SQL} ${EPAY_MAIN_REFUND_SOURCE_SCHEMA_SQL}
      CREATE TABLE runtime_master_key_guard(singleton_key INTEGER PRIMARY KEY,cipher_version INTEGER,nonce BLOB,ciphertext BLOB,authentication_tag BLOB);
      ${EPAY_LEGACY_INVOICE_CONFIG_SCHEMA_SQL}`);
    const guard = cipher.createGuard();
    db.prepare("INSERT INTO runtime_master_key_guard VALUES(1,1,?,?,?)").run(guard.nonce, guard.ciphertext, guard.authenticationTag);
    }
    db.exec("SAVEPOINT epay_isolated_import");
    try {
    for (const table of emptyTables) {
      const count = db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: bigint | number };
      if (Number(count.count) !== 0) throw new Error(`isolated target is not empty: ${table}`);
    }
    const insert = (table: string, columns: string[], values: SQLInputValue[]) => db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...values);
    for (const row of snapshot.tables.Merchant) {
      const id = integer(row, "id");
      const fee = options.merchantFeeBps[String(id)];
      if (!Number.isInteger(fee) || fee! < 0 || fee! > 5000) throw new Error("explicit merchant fee is required for isolated rehearsal");
      const updated = timestamp(row, "updatedAt", offset);
      insert("epay_merchant_accounts", ["merchant_id", "name", "balance_cents", "enabled", "fee_rate_bps", "created_at", "updated_at"], [id, string(row, "name"), cents(row, "money"), bool(row, "status"), fee!, timestamp(row, "createdAt", offset), updated]);
      const secret = string(row, "apiKey");
      const sealed = cipher.encrypt(`epay:merchant:${id}:api_key` as EPayCipherSecretName, 1, secret);
      insert("epay_merchant_secrets", ["merchant_id", "secret_version", "cipher_version", "nonce", "ciphertext", "authentication_tag", "secret_fingerprint", "updated_at"], [id, 1, sealed.cipherVersion, sealed.nonce, sealed.ciphertext, sealed.authenticationTag, createHash("sha256").update(secret).digest("hex"), updated]);
    }
    for (const row of snapshot.tables.MerchantBinding) insert("epay_merchant_bindings", ["binding_id", "main_api_id", "main_merchant_id", "epay_merchant_id", "created_at", "updated_at"], [string(row, "id"), string(row, "mainApiId"), string(row, "mainMerchantId"), integer(row, "epayMerchantId"), timestamp(row, "createdAt", offset), timestamp(row, "updatedAt", offset)]);
    for (const row of snapshot.tables.MerchantInvoiceConfig) {
      const id = integer(row, "merchantId");
      const raw = JSON.stringify(row);
      if (typeof raw !== "string") throw new Error("invalid invoice configuration source");
      const name = `epay:config:legacy-invoice:${id}` as const;
      const sealed = cipher.encrypt(name, 1, raw);
      insert("epay_legacy_invoice_config_source", ["merchant_id", "nonce", "ciphertext", "authentication_tag"], [id, sealed.nonce, sealed.ciphertext, sealed.authenticationTag]);
      const stored = db.prepare("SELECT nonce,ciphertext,authentication_tag FROM epay_legacy_invoice_config_source WHERE merchant_id=?").get(id) as { nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array } | undefined;
      if (!stored) throw new Error("invoice configuration source missing");
      const recovered = cipher.decrypt(name, 1, { cipherVersion: 1, nonce: Buffer.from(stored.nonce), ciphertext: Buffer.from(stored.ciphertext), authenticationTag: Buffer.from(stored.authentication_tag) });
      try { if (recovered.toString("utf8") !== raw) throw new Error("invoice configuration source mismatch"); }
      finally { recovered.fill(0); }
    }
    for (const row of snapshot.tables.PayType) insert("epay_pay_types", ["type_id", "code", "name", "enabled", "sort_order", "created_at", "updated_at"], [integer(row, "id"), string(row, "code"), string(row, "name"), bool(row, "enabled"), integer(row, "sort"), timestamp(row, "createdAt", offset), timestamp(row, "updatedAt", offset)]);
    for (const row of snapshot.tables.Channel) {
      const channelId = integer(row, "id");
      const config = json(row, "config");
      insert("epay_channels", ["channel_id", "type_id", "provider", "code", "name", "product", "enabled", "rate_bps", "pay_min_cents", "pay_max_cents", "config_json", "created_at", "updated_at"], [channelId, optionalInteger(row, "typeId"), string(row, "provider"), string(row, "code"), string(row, "name"), string(row, "product"), bool(row, "enabled"), cents(row, "rate"), optionalCents(row, "payMin"), optionalCents(row, "payMax"), null, timestamp(row, "createdAt", offset), timestamp(row, "updatedAt", offset)]);
      if (config !== null) writeEncryptedChannelConfig(db, cipher, channelId, config);
    }
    for (const row of snapshot.tables.Order) insert("epay_orders", ["trade_no", "out_trade_no", "api_trade_no", "merchant_id", "type_id", "channel_id", "type_code", "channel_code", "name", "money_cents", "real_money_cents", "get_money_cents", "notify_url", "return_url", "param", "domain", "ip", "device", "buyer", "pay_url", "qr_code", "url_scheme", "provider_result_json", "status", "notify_status", "notify_count", "notify_last_at", "created_at", "paid_at", "updated_at", "buyer_email"], [string(row, "tradeNo"), string(row, "outTradeNo"), optionalString(row, "apiTradeNo"), integer(row, "merchantId"), optionalInteger(row, "typeId"), optionalInteger(row, "channelId"), optionalString(row, "typeCode"), optionalString(row, "channelCode"), string(row, "name"), cents(row, "money"), optionalCents(row, "realMoney"), optionalCents(row, "getMoney"), string(row, "notifyUrl"), optionalString(row, "returnUrl"), optionalString(row, "param"), optionalString(row, "domain"), optionalString(row, "ip"), optionalString(row, "device"), optionalString(row, "buyer"), optionalString(row, "payUrl"), optionalString(row, "qrCode"), optionalString(row, "urlScheme"), json(row, "providerResult"), string(row, "status"), string(row, "notifyStatus"), integer(row, "notifyCount"), optionalTime(row, "notifyLastAt", offset), timestamp(row, "createdAt", offset), optionalTime(row, "paidAt", offset), timestamp(row, "updatedAt", offset), optionalString(row, "buyerEmail")]);
    for (const row of snapshot.tables.NotifyLog) insert("epay_notify_logs", ["notify_id", "trade_no", "url", "params_json", "response_code", "response_body", "status", "error", "created_at"], [integer(row, "id"), string(row, "tradeNo"), string(row, "url"), json(row, "params"), optionalInteger(row, "responseCode"), optionalString(row, "responseBody"), string(row, "status"), optionalString(row, "error"), timestamp(row, "createdAt", offset)]);
    for (const row of snapshot.tables.Invoice) insert("epay_invoices", ["invoice_id", "trade_no", "kind", "merchant_id", "title", "tax_id", "email", "amount_cents", "status", "provider", "external_id", "receipt_pdf_path", "provider_message", "created_at", "updated_at", "issued_at", "service_fee_cents", "charged_at"], [string(row, "id"), string(row, "tradeNo"), string(row, "kind"), integer(row, "merchantId"), string(row, "title"), optionalString(row, "taxId"), optionalString(row, "email"), cents(row, "amount"), string(row, "status"), string(row, "provider"), optionalString(row, "externalId"), optionalString(row, "receiptPdfPath"), optionalString(row, "providerMessage"), timestamp(row, "createdAt", offset), timestamp(row, "updatedAt", offset), optionalTime(row, "issuedAt", offset), cents(row, "serviceFee"), optionalTime(row, "chargedAt", offset)]);
    for (const row of snapshot.tables.InvoiceApplication) insert("epay_invoice_applications", ["application_id", "merchant_id", "trade_no", "out_trade_no", "title", "tax_id", "email", "fee_cents", "status", "created_at", "updated_at", "invoice_no", "invoice_url", "issued_at", "error_code", "error_message", "email_sent", "email_error"], [string(row, "id"), integer(row, "merchantId"), string(row, "tradeNo"), string(row, "outTradeNo"), string(row, "title"), string(row, "taxId"), string(row, "email"), integer(row, "feeCents"), string(row, "status"), timestamp(row, "createdAt", offset), timestamp(row, "updatedAt", offset), optionalString(row, "invoiceNo"), optionalString(row, "invoiceUrl"), optionalTime(row, "issuedAt", offset), optionalString(row, "errorCode"), optionalString(row, "errorMessage"), bool(row, "emailSent"), optionalString(row, "emailError")]);
    for (const row of snapshot.tables.Config) {
      const key = string(row, "key");
      const value = optionalString(row, "value");
      const updated = timestamp(row, "updatedAt", offset);
      if (value === null || value === "") insert("epay_config_values", ["config_key", "config_value", "updated_at"], [key, value, updated]);
      else {
        const sealed = cipher.encrypt(`epay:config:${key}` as EPayCipherSecretName, 1, value);
        insert("epay_config_secrets", ["config_key", "secret_version", "cipher_version", "nonce", "ciphertext", "authentication_tag", "secret_fingerprint", "updated_at"], [key, 1, sealed.cipherVersion, sealed.nonce, sealed.ciphertext, sealed.authenticationTag, createHash("sha256").update(value).digest("hex"), updated]);
      }
    }
    const invalidInvoices = db.prepare(`SELECT count(*) AS count FROM epay_invoices i LEFT JOIN epay_orders o ON o.trade_no = i.trade_no AND o.merchant_id = i.merchant_id WHERE o.trade_no IS NULL`).get() as { count: bigint | number };
    const invalidApplications = db.prepare(`SELECT count(*) AS count FROM epay_invoice_applications i LEFT JOIN epay_orders o ON o.trade_no = i.trade_no AND o.merchant_id = i.merchant_id WHERE o.trade_no IS NULL OR o.out_trade_no <> i.out_trade_no`).get() as { count: bigint | number };
    if (Number(invalidInvoices.count) || Number(invalidApplications.count)) throw new Error("invoice order or merchant mismatch");
    const targetTables = { Merchant: ["epay_merchant_accounts", "merchant_id"], MerchantBinding: ["epay_merchant_bindings", "binding_id"], PayType: ["epay_pay_types", "type_id"], Channel: ["epay_channels", "channel_id"], Order: ["epay_orders", "trade_no"], NotifyLog: ["epay_notify_logs", "notify_id"], Invoice: ["epay_invoices", "invoice_id"], InvoiceApplication: ["epay_invoice_applications", "application_id"] } as const;
    for (const [source, [table, column]] of Object.entries(targetTables)) {
      const actual = db.prepare(`SELECT ${column} AS id FROM ${table}`).all().map((row) => String(row.id)).sort();
      const sourceName = source as keyof typeof targetTables;
      const key = SOURCE_TABLES[sourceName];
      const expected = snapshot.tables[sourceName].map((row) => String(row[key])).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`isolated import identifier mismatch for ${source}`);
    }
    for (const row of snapshot.tables.Merchant) {
      const id = integer(row, "id");
      verifyMappedRow(db, "epay_merchant_accounts", "merchant_id", id, {
        balance_cents: cents(row, "money"),
        name: string(row, "name"), enabled: bool(row, "status"), fee_rate_bps: options.merchantFeeBps[String(id)]!,
        created_at: timestamp(row, "createdAt", offset), updated_at: timestamp(row, "updatedAt", offset),
      });
      const secret = db.prepare("SELECT nonce, ciphertext, authentication_tag FROM epay_merchant_secrets WHERE merchant_id = ?").get(id) as { nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array } | undefined;
      if (!secret || cipher.decrypt(`epay:merchant:${id}:api_key`, 1, { cipherVersion: 1, nonce: Buffer.from(secret.nonce), ciphertext: Buffer.from(secret.ciphertext), authenticationTag: Buffer.from(secret.authentication_tag) }).toString("utf8") !== string(row, "apiKey")) throw new Error("isolated import merchant secret mismatch");
    }
    for (const row of snapshot.tables.MerchantBinding) {
      verifyMappedRow(db, "epay_merchant_bindings", "binding_id", string(row, "id"), {
        main_api_id: string(row, "mainApiId"), main_merchant_id: string(row, "mainMerchantId"),
        epay_merchant_id: integer(row, "epayMerchantId"), created_at: timestamp(row, "createdAt", offset),
        updated_at: timestamp(row, "updatedAt", offset),
      });
    }
    for (const row of snapshot.tables.PayType) {
      verifyMappedRow(db, "epay_pay_types", "type_id", integer(row, "id"), {
        code: string(row, "code"), name: string(row, "name"), enabled: bool(row, "enabled"), sort_order: integer(row, "sort"),
        created_at: timestamp(row, "createdAt", offset), updated_at: timestamp(row, "updatedAt", offset),
      });
    }
    for (const row of snapshot.tables.Channel) {
      const id = integer(row, "id");
      const stored = db.prepare("SELECT config_json FROM epay_channels WHERE channel_id=?").get(id);
      if (!stored || stored.config_json !== null || readEncryptedChannelConfig(db, cipher, id) !== json(row, "config")) throw new Error("isolated import channel config mismatch");
      verifyMappedRow(db, "epay_channels", "channel_id", id, {
        type_id: optionalInteger(row, "typeId"), provider: string(row, "provider"), code: string(row, "code"),
        name: string(row, "name"), product: string(row, "product"), enabled: bool(row, "enabled"), rate_bps: cents(row, "rate"),
        pay_min_cents: optionalCents(row, "payMin"), pay_max_cents: optionalCents(row, "payMax"),
        created_at: timestamp(row, "createdAt", offset), updated_at: timestamp(row, "updatedAt", offset),
      });
    }
    for (const row of snapshot.tables.Order) {
      verifyMappedRow(db, "epay_orders", "trade_no", string(row, "tradeNo"), {
        money_cents: cents(row, "money"), real_money_cents: optionalCents(row, "realMoney"), get_money_cents: optionalCents(row, "getMoney"),
        out_trade_no: string(row, "outTradeNo"), api_trade_no: optionalString(row, "apiTradeNo"),
        merchant_id: integer(row, "merchantId"), type_id: optionalInteger(row, "typeId"), channel_id: optionalInteger(row, "channelId"),
        type_code: optionalString(row, "typeCode"), channel_code: optionalString(row, "channelCode"), name: string(row, "name"),
        notify_url: string(row, "notifyUrl"), return_url: optionalString(row, "returnUrl"), param: optionalString(row, "param"),
        domain: optionalString(row, "domain"), ip: optionalString(row, "ip"), device: optionalString(row, "device"),
        buyer: optionalString(row, "buyer"), pay_url: optionalString(row, "payUrl"), qr_code: optionalString(row, "qrCode"),
        url_scheme: optionalString(row, "urlScheme"), provider_result_json: json(row, "providerResult"),
        status: string(row, "status"), notify_status: string(row, "notifyStatus"), notify_count: integer(row, "notifyCount"),
        notify_last_at: optionalTime(row, "notifyLastAt", offset), created_at: timestamp(row, "createdAt", offset),
        paid_at: optionalTime(row, "paidAt", offset), updated_at: timestamp(row, "updatedAt", offset), buyer_email: optionalString(row, "buyerEmail"),
      });
    }
    for (const row of snapshot.tables.Invoice) {
      verifyMappedRow(db, "epay_invoices", "invoice_id", string(row, "id"), {
        amount_cents: cents(row, "amount"), service_fee_cents: cents(row, "serviceFee"),
        trade_no: string(row, "tradeNo"), kind: string(row, "kind"), merchant_id: integer(row, "merchantId"),
        title: string(row, "title"), tax_id: optionalString(row, "taxId"), email: optionalString(row, "email"),
        status: string(row, "status"), provider: string(row, "provider"), external_id: optionalString(row, "externalId"),
        receipt_pdf_path: optionalString(row, "receiptPdfPath"), provider_message: optionalString(row, "providerMessage"),
        created_at: timestamp(row, "createdAt", offset), updated_at: timestamp(row, "updatedAt", offset),
        issued_at: optionalTime(row, "issuedAt", offset), charged_at: optionalTime(row, "chargedAt", offset),
      });
    }
    for (const row of snapshot.tables.NotifyLog) {
      verifyMappedRow(db, "epay_notify_logs", "notify_id", integer(row, "id"), {
        trade_no: string(row, "tradeNo"), url: string(row, "url"), params_json: json(row, "params"),
        response_code: optionalInteger(row, "responseCode"), response_body: optionalString(row, "responseBody"),
        status: string(row, "status"), error: optionalString(row, "error"), created_at: timestamp(row, "createdAt", offset),
      });
    }
    for (const row of snapshot.tables.InvoiceApplication) {
      verifyMappedRow(db, "epay_invoice_applications", "application_id", string(row, "id"), {
        merchant_id: integer(row, "merchantId"), trade_no: string(row, "tradeNo"), out_trade_no: string(row, "outTradeNo"), fee_cents: integer(row, "feeCents"),
        title: string(row, "title"), tax_id: string(row, "taxId"), email: string(row, "email"), status: string(row, "status"),
        created_at: timestamp(row, "createdAt", offset), updated_at: timestamp(row, "updatedAt", offset),
        invoice_no: optionalString(row, "invoiceNo"), invoice_url: optionalString(row, "invoiceUrl"),
        issued_at: optionalTime(row, "issuedAt", offset), error_code: optionalString(row, "errorCode"),
        error_message: optionalString(row, "errorMessage"), email_sent: bool(row, "emailSent"), email_error: optionalString(row, "emailError"),
      });
    }
    const configCount = db.prepare("SELECT (SELECT count(*) FROM epay_config_values) + (SELECT count(*) FROM epay_config_secrets) AS count").get() as { count: number | bigint };
    if (BigInt(configCount.count) !== BigInt(snapshot.counts.Config)) throw new Error("isolated import config count mismatch");
    for (const row of snapshot.tables.Config) {
      const key = string(row, "key");
      const expected = optionalString(row, "value");
      if (expected === null || expected === "") {
        const stored = db.prepare("SELECT config_value FROM epay_config_values WHERE config_key = ?").get(key);
        if (!stored || stored.config_value !== expected) throw new Error("isolated import config value mismatch");
        continue;
      }
      const sealed = db.prepare("SELECT nonce, ciphertext, authentication_tag FROM epay_config_secrets WHERE config_key = ?").get(key) as { nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array } | undefined;
      if (!sealed || cipher.decrypt(`epay:config:${key}`, 1, { cipherVersion: 1, nonce: Buffer.from(sealed.nonce), ciphertext: Buffer.from(sealed.ciphertext), authenticationTag: Buffer.from(sealed.authentication_tag) }).toString("utf8") !== expected) throw new Error("isolated import config secret mismatch");
    }
    const mainPaymentsVerified = options.mainPayment === undefined ? false : verifyMainPaymentLinks(options.mainPayment, options.preserveRefundsForRehearsal);
    const mainLedger = options.mainPayment === undefined ? null : importMainLedgerInTransaction(db, cipher, options.mainPayment);
    const mainLedgerCount = mainLedger?.count ?? null;
    const mainBalanceSummaryVerified = mainLedger?.summaryVerified ?? false;
    const mainRefundCount = options.preserveRefundsForRehearsal && options.mainPayment !== undefined
      ? importMainRefundsInTransaction(db, cipher, options.mainPayment) : null;
    const mainRefundAudit = options.preserveRefundsForRehearsal && options.mainPayment !== undefined
      ? auditMainRefunds(options.mainPayment) : null;
    let mainOrderCount: number | null = null;
    const preserveOrders = mainPaymentsVerified || (options.preserveRefundsForRehearsal && options.mainPayment !== undefined && Array.isArray((options.mainPayment as { orders?: unknown }).orders));
    if (preserveOrders) {
      const orders = (options.mainPayment as { orders: Row[] }).orders;
      for (const order of orders) {
        const raw = JSON.stringify(order);
        if (typeof raw !== "string") throw new Error("invalid main order source record");
        writeEncryptedMainOrder(db, cipher, raw);
        if (readEncryptedMainOrder(db, cipher, string(order, "id")) !== raw) throw new Error("main order source record mismatch");
      }
      mainOrderCount = orders.length;
    }
    if (target) {
      const fingerprint = createHash("sha256").update(JSON.stringify([options.sourceName, snapshotId])).digest("hex");
      db.prepare("INSERT INTO epay_compat_import_runs(import_id,source_name,source_fingerprint,imported_at,counts_json) VALUES(?,?,?,?,?)")
        .run(snapshotId, options.sourceName, fingerprint, Date.now(), JSON.stringify(snapshot.counts));
    }
    capture?.(db, cipher);
    db.exec("RELEASE SAVEPOINT epay_isolated_import");
    return { counts: snapshot.counts, mainLedgerCount, mainBalanceSummaryVerified, mainOrderCount, mainRefundCount, mainRefundAudit, mainPaymentsVerified, preservedInvoiceConfigCount: snapshot.tables.MerchantInvoiceConfig.length, retainedOnly: { AdminSession: snapshot.counts.AdminSession, MerchantInvoiceConfig: snapshot.counts.MerchantInvoiceConfig }, identifiersVerified: true as const, amountsMapped: true as const, financiallyReconciled: false as const, productionReady: false as const };
    } catch (error) {
      try {
        db.exec("ROLLBACK TO SAVEPOINT epay_isolated_import; RELEASE SAVEPOINT epay_isolated_import");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "isolated import and rollback failed");
      }
      throw error;
    }
  } finally {
    if (!target) db.close();
  }
}
