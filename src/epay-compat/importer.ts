import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createConnection } from "mysql2/promise";

import { RuntimeSecretCipher, type EPayCipherSecretName } from "../settings/crypto.ts";

type MysqlRow = Record<string, unknown>;

export interface EPayImportDatabase {
  read<T>(operation: (database: DatabaseSync) => T): T;
  write<T>(operation: (database: DatabaseSync) => T): T;
  instanceId(): string;
}

export interface EPayImportOptions {
  readonly database: EPayImportDatabase;
  readonly masterKey: Uint8Array;
  readonly instanceId: string;
  readonly mysqlUrl: string;
  readonly sourceName: string;
}

export interface EPayImportSummary {
  readonly importId: string;
  readonly sourceFingerprint: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly skipped: boolean;
}

const TABLES = [
  "Merchant",
  "MerchantBinding",
  "PayType",
  "Channel",
  "Order",
  "NotifyLog",
  "Invoice",
  "InvoiceApplication",
  "Config",
] as const;

const SECRET_CONFIG_KEYS = new Set([
  "invoice_api_app_id",
  "invoice_api_secret",
  "wechat_api_v3_key",
  "wechat_merchant_private_key",
  "alipay_private_key",
]);

export async function importEPay(options: EPayImportOptions): Promise<EPayImportSummary> {
  assertImportReady();
  const rows = Object.fromEntries(await Promise.all(TABLES.map(async (table) => [table, await readTable(options.mysqlUrl, table)]))) as Record<string, MysqlRow[]>;
  const sourceFingerprint = sha256(JSON.stringify(rows));
  const existing = options.database.read((db) => db.prepare(
    "SELECT import_id, counts_json FROM epay_compat_import_runs WHERE source_name = ? AND source_fingerprint = ?",
  ).get(options.sourceName, sourceFingerprint) as { import_id: string; counts_json: string } | undefined);
  if (existing) {
    return { importId: existing.import_id, sourceFingerprint, counts: JSON.parse(existing.counts_json) as Record<string, number>, skipped: true };
  }

  const cipher = new RuntimeSecretCipher(options.masterKey, options.instanceId);
  const counts: Record<string, number> = {};
  options.database.write((db) => {
    for (const row of rows.Merchant ?? []) {
      db.prepare(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,fee_rate_bps,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(merchant_id) DO UPDATE SET name=excluded.name,balance_cents=excluded.balance_cents,
        enabled=excluded.enabled,fee_rate_bps=excluded.fee_rate_bps,updated_at=excluded.updated_at`).run(
        number(row.id), text(row.name), cents(row.money), bool(row.status), 0, time(row.createdAt), time(row.updatedAt),
      );
      const secret = text(row.apiKey);
      const encrypted = cipher.encrypt(`epay:merchant:${number(row.id)}:api_key` as EPayCipherSecretName, 1, secret);
      db.prepare(`INSERT INTO epay_merchant_secrets VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(merchant_id) DO UPDATE SET secret_version=excluded.secret_version,cipher_version=excluded.cipher_version,
        nonce=excluded.nonce,ciphertext=excluded.ciphertext,authentication_tag=excluded.authentication_tag,
        secret_fingerprint=excluded.secret_fingerprint,updated_at=excluded.updated_at`).run(
        number(row.id), 1, encrypted.cipherVersion, encrypted.nonce, encrypted.ciphertext, encrypted.authenticationTag, sha256(secret), time(row.updatedAt),
      );
      counts.Merchant = (counts.Merchant ?? 0) + 1;
    }
    for (const row of rows.MerchantBinding ?? []) {
      db.prepare(`INSERT INTO epay_merchant_bindings VALUES(?,?,?,?,?,?)
        ON CONFLICT(binding_id) DO UPDATE SET main_api_id=excluded.main_api_id,main_merchant_id=excluded.main_merchant_id,
        epay_merchant_id=excluded.epay_merchant_id,updated_at=excluded.updated_at`).run(
        text(row.id), text(row.mainApiId), text(row.mainMerchantId), number(row.epayMerchantId), time(row.createdAt), time(row.updatedAt),
      );
      counts.MerchantBinding = (counts.MerchantBinding ?? 0) + 1;
    }
    for (const row of rows.PayType ?? []) {
      db.prepare(`INSERT INTO epay_pay_types VALUES(?,?,?,?,?,?) ON CONFLICT(type_id) DO UPDATE SET code=excluded.code,name=excluded.name,
        enabled=excluded.enabled,sort_order=excluded.sort_order,updated_at=excluded.updated_at`).run(number(row.id), text(row.code), text(row.name), bool(row.enabled), number(row.sort), time(row.createdAt), time(row.updatedAt));
      counts.PayType = (counts.PayType ?? 0) + 1;
    }
    for (const row of rows.Channel ?? []) {
      db.prepare(`INSERT INTO epay_channels VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET
        type_id=excluded.type_id,provider=excluded.provider,code=excluded.code,name=excluded.name,product=excluded.product,enabled=excluded.enabled,
        rate_bps=excluded.rate_bps,pay_min_cents=excluded.pay_min_cents,pay_max_cents=excluded.pay_max_cents,config_json=excluded.config_json,updated_at=excluded.updated_at`).run(
        number(row.id), nullableNumber(row.typeId), text(row.provider), text(row.code), text(row.name), text(row.product), bool(row.enabled), Math.round(number(row.rate) * 100), nullableCents(row.payMin), nullableCents(row.payMax), json(row.config), time(row.createdAt), time(row.updatedAt),
      );
      counts.Channel = (counts.Channel ?? 0) + 1;
    }
    for (const row of rows.Order ?? []) {
      db.prepare(`INSERT INTO epay_orders(trade_no,out_trade_no,api_trade_no,merchant_id,type_id,channel_id,type_code,channel_code,name,money_cents,real_money_cents,get_money_cents,notify_url,return_url,param,domain,ip,device,buyer,pay_url,qr_code,url_scheme,provider_result_json,status,notify_status,notify_count,notify_last_at,created_at,paid_at,updated_at,buyer_email)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(trade_no) DO UPDATE SET status=excluded.status,notify_status=excluded.notify_status,notify_count=excluded.notify_count,notify_last_at=excluded.notify_last_at,paid_at=excluded.paid_at,updated_at=excluded.updated_at`).run(
        text(row.tradeNo), text(row.outTradeNo), nullableText(row.apiTradeNo), number(row.merchantId), nullableNumber(row.typeId), nullableNumber(row.channelId), nullableText(row.typeCode), nullableText(row.channelCode), text(row.name), cents(row.money), nullableCents(row.realMoney), nullableCents(row.getMoney), text(row.notifyUrl), nullableText(row.returnUrl), nullableText(row.param), nullableText(row.domain), nullableText(row.ip), nullableText(row.device), nullableText(row.buyer), nullableText(row.payUrl), nullableText(row.qrCode), nullableText(row.urlScheme), json(row.providerResult), text(row.status), text(row.notifyStatus), number(row.notifyCount), nullableTime(row.notifyLastAt), time(row.createdAt), nullableTime(row.paidAt), time(row.updatedAt), nullableText(row.buyerEmail),
      );
      counts.Order = (counts.Order ?? 0) + 1;
    }
    for (const row of rows.NotifyLog ?? []) {
      db.prepare(`INSERT INTO epay_notify_logs VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(notify_id) DO UPDATE SET response_code=excluded.response_code,response_body=excluded.response_body,status=excluded.status,error=excluded.error`).run(number(row.id), text(row.tradeNo), text(row.url), json(row.params) ?? "{}", nullableNumber(row.responseCode), nullableText(row.responseBody), text(row.status), nullableText(row.error), time(row.createdAt));
      counts.NotifyLog = (counts.NotifyLog ?? 0) + 1;
    }
    for (const row of rows.Invoice ?? []) {
      db.prepare(`INSERT INTO epay_invoices VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(invoice_id) DO UPDATE SET status=excluded.status,external_id=excluded.external_id,receipt_pdf_path=excluded.receipt_pdf_path,provider_message=excluded.provider_message,updated_at=excluded.updated_at,issued_at=excluded.issued_at,charged_at=excluded.charged_at`).run(text(row.id), text(row.tradeNo), text(row.kind), number(row.merchantId), text(row.title), nullableText(row.taxId), nullableText(row.email), cents(row.amount), text(row.status), text(row.provider), nullableText(row.externalId), nullableText(row.receiptPdfPath), nullableText(row.providerMessage), time(row.createdAt), time(row.updatedAt), nullableTime(row.issuedAt), cents(row.serviceFee), nullableTime(row.chargedAt));
      counts.Invoice = (counts.Invoice ?? 0) + 1;
    }
    for (const row of rows.InvoiceApplication ?? []) {
      db.prepare(`INSERT INTO epay_invoice_applications VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(application_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,invoice_no=excluded.invoice_no,invoice_url=excluded.invoice_url,issued_at=excluded.issued_at,error_code=excluded.error_code,error_message=excluded.error_message,email_sent=excluded.email_sent,email_error=excluded.email_error`).run(text(row.id), number(row.merchantId), text(row.tradeNo), text(row.outTradeNo), text(row.title), text(row.taxId), text(row.email), number(row.feeCents), text(row.status), time(row.createdAt), time(row.updatedAt), nullableText(row.invoiceNo), nullableText(row.invoiceUrl), nullableTime(row.issuedAt), nullableText(row.errorCode), nullableText(row.errorMessage), bool(row.emailSent), nullableText(row.emailError));
      counts.InvoiceApplication = (counts.InvoiceApplication ?? 0) + 1;
    }
    for (const row of rows.Config ?? []) {
      if (SECRET_CONFIG_KEYS.has(text(row.key))) continue;
      db.prepare("INSERT INTO epay_config_values VALUES(?,?,?) ON CONFLICT(config_key) DO UPDATE SET config_value=excluded.config_value,updated_at=excluded.updated_at").run(text(row.key), nullableText(row.value), time(row.updatedAt));
      counts.Config = (counts.Config ?? 0) + 1;
    }
    const importId = randomUUID();
    db.prepare("INSERT INTO epay_compat_import_runs VALUES(?,?,?,?,?)").run(importId, options.sourceName, sourceFingerprint, Date.now(), JSON.stringify(counts));
    (counts as Record<string, unknown>).__importId = importId;
  });
  const importId = String(counts.__importId);
  delete counts.__importId;
  return { importId, sourceFingerprint, counts, skipped: false };
}

export function assertImportReady(): void {
  throw new Error("EPay import is disabled: consistent snapshots, secret protection and ledger reconciliation are not implemented");
}

async function readTable(url: string, table: string): Promise<MysqlRow[]> {
  const connection = await createConnection(url);
  try {
    const [rows] = await connection.query(
      `SELECT ${columns(table).map((column) => `\`${column}\``).join(",")} FROM \`${table}\``,
    );
    return rows as MysqlRow[];
  } finally {
    await connection.end();
  }
}

const columns = (table: string): string[] => ({
  Merchant: ["id", "name", "apiKey", "money", "status", "createdAt", "updatedAt"],
  MerchantBinding: ["id", "mainApiId", "mainMerchantId", "epayMerchantId", "createdAt", "updatedAt"],
  PayType: ["id", "code", "name", "enabled", "sort", "createdAt", "updatedAt"],
  Channel: ["id", "typeId", "provider", "code", "name", "product", "enabled", "rate", "payMin", "payMax", "config", "createdAt", "updatedAt"],
  Order: ["tradeNo", "outTradeNo", "apiTradeNo", "merchantId", "typeId", "channelId", "typeCode", "channelCode", "name", "money", "realMoney", "getMoney", "notifyUrl", "returnUrl", "param", "domain", "ip", "device", "buyer", "payUrl", "qrCode", "urlScheme", "providerResult", "status", "notifyStatus", "notifyCount", "notifyLastAt", "createdAt", "paidAt", "updatedAt", "buyerEmail"],
  NotifyLog: ["id", "tradeNo", "url", "params", "responseCode", "responseBody", "status", "error", "createdAt"],
  Invoice: ["id", "tradeNo", "kind", "merchantId", "title", "taxId", "email", "amount", "status", "provider", "externalId", "receiptPdfPath", "providerMessage", "createdAt", "updatedAt", "issuedAt", "serviceFee", "chargedAt"],
  InvoiceApplication: ["id", "merchantId", "tradeNo", "outTradeNo", "title", "taxId", "email", "feeCents", "status", "createdAt", "updatedAt", "invoiceNo", "invoiceUrl", "issuedAt", "errorCode", "errorMessage", "emailSent", "emailError"],
  Config: ["key", "value", "updatedAt"],
} as Record<string, string[]>)[table] ?? [];

const text = (value: unknown): string => String(value ?? "");
const nullableText = (value: unknown): string | null => value == null ? null : String(value);
const number = (value: unknown): number => Number(value ?? 0);
const nullableNumber = (value: unknown): number | null => value == null ? null : Number(value);
const cents = (value: unknown): number => Math.round(Number(value ?? 0) * 100);
const nullableCents = (value: unknown): number | null => value == null ? null : Math.round(Number(value) * 100);
const bool = (value: unknown): number => value ? 1 : 0;
const time = (value: unknown): number => new Date(String(value)).getTime();
const nullableTime = (value: unknown): number | null => value == null ? null : time(value);
const json = (value: unknown): string | null => value == null ? null : typeof value === "string" ? value : JSON.stringify(value);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
