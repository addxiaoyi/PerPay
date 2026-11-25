import { lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { AppDatabase } from "../database/database.ts";
import { parseStrictJson } from "../http/strict-json.ts";
import { createFaPiaoInvoiceProvider } from "./fa-piao-provider.ts";
import { savedReceipt, saveReceipt } from "./receipts.ts";

const credentialsSchema = z.object({
  appKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  appSecret: z.string().regex(/^[\x21-\x7e]{16,256}$/),
  accountId: z.string().regex(/^\d{1,32}$/),
  sellerTaxId: z.string().regex(/^[A-Z0-9]{15,20}$/),
  sellerName: z.string().trim().min(1).max(120),
  username: z.string().regex(/^1[3-9]\d{9}$/),
  plan: z.enum(["6", "7"]),
  sellerAddressPhone: z.string().trim().min(1).max(200).optional(),
  sellerBankAccount: z.string().trim().min(1).max(200).optional(),
  platformFees: z.object({
    itemName: z.string().trim().min(1).max(90), taxCode: z.string().regex(/^\d{19}$/),
    taxRateBps: z.union([z.literal(100), z.literal(300)]),
    enabled: z.boolean(), validUntil: z.number().int().safe().positive(),
  }).strict().optional(),
}).strict();

export function readFaPiaoCredentials(path: string, allowIssue = false) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
    throw new Error("fa-piao credentials must be a private ordinary file no larger than 8192 bytes");
  const parsed = credentialsSchema.safeParse(parseStrictJson(readFileSync(path)));
  if (!parsed.success) throw new Error("fa-piao credential file has invalid or missing fields");
  const credentials = parsed.data;
  if (allowIssue && (!credentials.sellerAddressPhone || !credentials.sellerBankAccount))
    throw new Error("fa-piao issuance requires confirmed seller address, phone and bank account");
  return credentials;
}

export function createFaPiaoRuntime(options: {
  database: Pick<AppDatabase, "read" | "write">; credentialFile: string; allowIssue: boolean;
  transport?: typeof fetch; clock?: () => number;
}) {
  const credentials = readFaPiaoCredentials(options.credentialFile, options.allowIssue), clock = options.clock ?? Date.now;
  return createFaPiaoInvoiceProvider({ ...options, credentials, receipts: {
    load: requestNo => options.database.read(sql => savedReceipt(sql, requestNo)),
    save: (requestNo, invoiceNo) => options.database.write(sql => saveReceipt(sql, requestNo, invoiceNo, clock())),
  } });
}
