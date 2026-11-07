import { readFileSync, statSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("a main-site store path is required");
const before = statSync(file);
const store = JSON.parse(readFileSync(file, "utf8"));
const after = statSync(file);
if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(key => before[key] !== after[key])) throw new Error("main-site store changed while reading");
const payment = store?.payment;
if (!payment || !Array.isArray(payment.merchants) || !Array.isArray(payment.ledger)) throw new Error("main-site payment data is missing");

const errors = { invalidMerchant: 0, invalidApiId: 0, invalidFee: 0, invalidEntry: 0, missingMerchant: 0, invalidTimestamp: 0, invalidOptionalField: 0 };
function validTimestamp(value) {
  if (typeof value !== "string") return false;
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(?:Z|([+-])(\d\d):(\d\d))$/.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1970 && month >= 1 && month <= 12 && day >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hour <= 23 && minute <= 59 && second <= 59 && Number(parts[8] ?? 0) <= 23 && Number(parts[9] ?? 0) <= 59 && Number.isSafeInteger(Date.parse(value)) && Date.parse(value) >= 0;
}
const merchants = new Set();
for (const merchant of payment.merchants) {
  if (!merchant || typeof merchant.id !== "string" || !merchant.id || merchants.has(merchant.id)) { errors.invalidMerchant++; continue; }
  merchants.add(merchant.id);
  if (typeof merchant.apiId !== "string" || !merchant.apiId) errors.invalidApiId++;
  if (typeof merchant.feeRate !== "number" || !Number.isFinite(merchant.feeRate) || merchant.feeRate < 0 || merchant.feeRate > 0.5 || Math.abs(merchant.feeRate * 10000 - Math.round(merchant.feeRate * 10000)) > 1e-8) errors.invalidFee++;
}
const ids = new Set();
for (const entry of payment.ledger) {
  if (!entry || typeof entry.id !== "string" || !entry.id || entry.id.length > 128 || ids.has(entry.id) || typeof entry.merchantId !== "string" || !entry.merchantId || typeof entry.type !== "string" || !entry.type || entry.type.length > 64 || !Number.isSafeInteger(entry.availableDelta) || !Number.isSafeInteger(entry.frozenDelta)) { errors.invalidEntry++; continue; }
  ids.add(entry.id);
  if (!merchants.has(entry.merchantId)) errors.missingMerchant++;
  if (!validTimestamp(entry.at)) errors.invalidTimestamp++;
  if ((entry.reason != null && typeof entry.reason !== "string") || (entry.actorId != null && typeof entry.actorId !== "string")) errors.invalidOptionalField++;
}
let bindings = null;
if (process.argv[3] === "--bindings-stdin") {
  const rows = JSON.parse(readFileSync(0, "utf8"));
  if (!Array.isArray(rows)) throw new Error("binding input is invalid");
  let matched = 0, unmatched = 0;
  for (const merchant of payment.merchants) {
    const matches = rows.filter(row => Array.isArray(row) && row.length === 2 && row[0] === merchant.id && row[1] === merchant.apiId);
    if (matches.length === 1) matched++;
    else unmatched++;
  }
  bindings = { sourceCount: rows.length, matchedMainMerchants: matched, unmatchedMainMerchants: unmatched };
}
console.log(JSON.stringify({ fileModifiedAt: after.mtime.toISOString(), merchantCount: payment.merchants.length, ledgerCount: payment.ledger.length, errors, bindings, coordinatedSnapshot: false, financiallyReconciled: false }));
