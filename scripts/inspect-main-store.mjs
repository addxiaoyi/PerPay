import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("expected an isolated or read-only main-site store path");
let root;
try {
  root = JSON.parse(readFileSync(path, "utf8"));
} catch {
  throw new Error("unable to read or parse main-site store");
}
const payment = root.payment;
if (!payment || typeof payment !== "object" || !Array.isArray(payment.merchants) || !Array.isArray(payment.ledger)) {
  throw new Error("main-site payment merchants or ledger are missing");
}
const names = ["merchants", "ledger", "settlements", "refunds", "orders", "callbacks", "syncJobs"];
const counts = Object.fromEntries(names.map((name) => [name, Array.isArray(payment[name]) ? payment[name].length : null]));
const merchantIds = new Set(payment.merchants.map((row) => row.id));
const ledgerIds = new Set();
let duplicateLedgerIds = 0;
let missingMerchants = 0;
let invalidDeltas = 0;
for (const row of payment.ledger) {
  if (ledgerIds.has(row.id)) duplicateLedgerIds++;
  ledgerIds.add(row.id);
  if (!merchantIds.has(row.merchantId)) missingMerchants++;
  if (!Number.isSafeInteger(row.availableDelta) || !Number.isSafeInteger(row.frozenDelta)) invalidDeltas++;
}
const feeIssues = payment.merchants.filter((row) => {
  const value = row.feeRate;
  return typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 0.5 || Math.abs(value * 10000 - Math.round(value * 10000)) > 1e-8;
}).length;
console.log(JSON.stringify({ counts, duplicateLedgerIds, missingMerchants, invalidDeltas, unsupportedOrInvalidFeeRates: feeIssues }));
