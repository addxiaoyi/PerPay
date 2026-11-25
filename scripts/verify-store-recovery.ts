import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { openLiveState } from "../src/epay-compat/live-state-envelope.ts";
import { readLiveStateArchive } from "../src/epay-compat/live-state-archive.ts";
import { auditMainLedger } from "../src/epay-compat/main-ledger-audit.ts";
import { auditMainPayments } from "../src/epay-compat/main-payment-audit.ts";

const archivePath = process.argv[2];
if (!archivePath) throw new Error("archive path is required");
const privateKey = readFileSync(0);
let plaintext: Buffer | undefined;
try {
  const manifest = JSON.parse(readFileSync(`${archivePath}.manifest.json`, "utf8"));
  const envelope = readLiveStateArchive(archivePath, manifest.archiveSha256);
  plaintext = openLiveState(envelope, privateKey.toString("utf8"), manifest.snapshotId);
  assert.equal(createHash("sha256").update(plaintext).digest("hex"), manifest.sourceSha256);
  assert.equal(plaintext.length, manifest.sourceBytes);
  const store = JSON.parse(plaintext.toString("utf8"));
  assert.ok(Array.isArray(store.users) && store.payment && Array.isArray(store.catalog));
  const ledger = auditMainLedger(store.payment);
  const { balances: _balances, ...ledgerSummary } = ledger;
  const orders = auditMainPayments(store.payment);
  console.log(JSON.stringify({ verified: true, users: store.users.length, catalog: store.catalog.length,
    ledger: ledgerSummary, orders, counts: Object.fromEntries(Object.entries(store.payment).filter(([,v])=>Array.isArray(v)).map(([k,v])=>[k,(v as unknown[]).length])) }));
} finally {
  privateKey.fill(0);
  plaintext?.fill(0);
}
