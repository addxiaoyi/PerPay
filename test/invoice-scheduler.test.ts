import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { InvoiceQueryScheduler } from "../src/invoices/scheduler.ts";
import type { InvoiceObservation, InvoiceProvider, InvoiceStatus } from "../src/invoices/model.ts";
import { balanceFixture } from "./epay-live-balance-fixture.ts";

const NOW = 1_800_000_000_000;
const profile = { subMchId: "1900000100", sellerName: "Test seller", sellerTaxId: "91310000123456789A", billingPersonId: "billing-person", itemName: "Software", taxCode: "3040201000000000000", taxRateBps: 600 };

async function fixture(query: InvoiceProvider["query"]) {
  const f = await balanceFixture();
  let clock = NOW;
  const errors: string[] = [];
  const scheduler = new InvoiceQueryScheduler({ database: f.db, query, clock: () => clock,
    intervalMilliseconds: 30_000, requestSpacingMilliseconds: 1, maximumPerRun: 2, onError: code => errors.push(code) });
  function add(status: InvoiceStatus, age = 60_000) {
    const id = randomUUID(), tradeNo = randomUUID(), requestNo = randomUUID().replaceAll("-", "");
    f.db.write(sql => {
      sql.prepare(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
        VALUES(?,?,1,'software',1000,1000,'https://merchant.example/notify','PAID','SUCCESS',0,0,0)`).run(tradeNo, tradeNo);
      sql.prepare(`INSERT INTO epay_tax_invoice_requests(invoice_id,request_no,application_no,attempt,request_id,merchant_id,trade_no,amount_cents,payment_type,provider_trade_no,profile_json,
        buyer_type,title,tax_id,email,requested_by,status,invoice_no,created_at,updated_at) VALUES(?,?,?,1,?,1,?,1000,'wxpay','123456',?,'INDIVIDUAL','Test buyer','','buyer@example.test','owner',?,?,?,?)`)
        .run(id, requestNo, requestNo, requestNo, tradeNo, JSON.stringify(profile), status,
          ["ISSUED", "REVERSING", "REVERSED"].includes(status) ? "12345678901234567890" : null, NOW - age, NOW - age);
    });
    return id;
  }
  const read = (id: string) => f.db.read(sql => sql.prepare("SELECT status,invoice_no,updated_at FROM epay_tax_invoice_requests WHERE invoice_id=?").get(id));
  return { ...f, scheduler, add, read, errors, clock: (value: number) => { clock = value; }, close: async () => { await scheduler.stop(); f.close(); } };
}

it("queries only aged unresolved invoices and persists issuance without ever submitting a new invoice", async () => {
  const queries: string[] = [];
  const f = await fixture(async request => { queries.push(request.requestNo); return { status: "ISSUED", invoiceNo: "12345678901234567890" }; });
  try {
    const pending = f.add("PROCESSING"), unknown = f.add("UNKNOWN");
    f.add("ISSUED"); f.add("FAILED"); f.add("REVERSED"); f.add("PROCESSING", 1000);
    assert.equal(await f.scheduler.trigger(), 2);
    assert.equal(queries.length, 2);
    assert.equal(f.read(pending)?.status, "ISSUED");
    assert.equal(f.read(unknown)?.status, "ISSUED");
    assert.equal(await f.scheduler.trigger(), 0);
  } finally { await f.close(); }
});

it("bounds batches and rotates old unknown results instead of starving later invoices", async () => {
  const queries: string[] = [];
  const f = await fixture(async request => { queries.push(request.requestNo); return { status: "UNKNOWN" }; });
  try {
    f.add("UNKNOWN", 90_000); f.add("UNKNOWN", 80_000); f.add("PROCESSING", 70_000);
    assert.equal(await f.scheduler.trigger(), 2);
    assert.equal(await f.scheduler.trigger(), 1);
    assert.equal(new Set(queries).size, 3);
    assert.equal(await f.scheduler.trigger(), 0);
    f.clock(NOW + 30_000);
    assert.equal(await f.scheduler.trigger(), 2);
  } finally { await f.close(); }
});

it("serializes reentrant triggers and atomically claims work across scheduler instances", async () => {
  let finish!: (observation: InvoiceObservation) => void;
  const f = await fixture(() => new Promise(resolve => { finish = resolve; }));
  const other = new InvoiceQueryScheduler({ database: f.db, query: async () => { throw new Error("duplicate query"); }, clock: () => NOW, onError: code => f.errors.push(code) });
  try {
    const id = f.add("PROCESSING");
    const first = f.scheduler.trigger();
    assert.equal(f.scheduler.trigger(), first);
    assert.equal(await other.trigger(), 0);
    finish({ status: "ISSUED", invoiceNo: "12345678901234567890" });
    assert.equal(await first, 1);
    assert.equal(f.read(id)?.status, "ISSUED");
    assert.deepEqual(f.errors, []);
  } finally { await other.stop(); await f.close(); }
});

it("records query failures without downgrading processing or retrying issuance", async () => {
  const f = await fixture(async () => { throw new Error("provider offline"); });
  try {
    const id = f.add("PROCESSING");
    assert.equal(await f.scheduler.trigger(), 1);
    assert.equal(f.read(id)?.status, "PROCESSING");
    assert.deepEqual(f.errors, ["invoice_query_failed"]);
    assert.equal(await f.scheduler.trigger(), 0);
  } finally { await f.close(); }
});

it("keeps newer manual observations when an older background query finishes late", async () => {
  let finish!: (observation: InvoiceObservation) => void;
  const f = await fixture(() => new Promise(resolve => { finish = resolve; }));
  try {
    const id = f.add("UNKNOWN"), run = f.scheduler.trigger();
    f.db.write(sql => sql.prepare("UPDATE epay_tax_invoice_requests SET status='PROCESSING',updated_at=? WHERE invoice_id=?").run(NOW + 1, id));
    f.clock(NOW + 2);
    finish({ status: "FAILED", errorCode: "wechat_issue_failed" });
    assert.equal(await run, 1);
    assert.equal(f.read(id)?.status, "PROCESSING");
  } finally { await f.close(); }
});

it("reconciles a pending red cancellation and preserves the original invoice number", async () => {
  const f = await fixture(async () => ({ status: "REVERSED" }));
  try {
    const id = f.add("REVERSING");
    assert.equal(await f.scheduler.trigger(), 1);
    assert.equal(f.read(id)?.status, "REVERSED");
    assert.equal(f.read(id)?.invoice_no, "12345678901234567890");
  } finally { await f.close(); }
});

it("stops an inter-request wait before claiming another invoice", async () => {
  const f = await fixture(async () => ({ status: "UNKNOWN" }));
  const scheduler = new InvoiceQueryScheduler({ database: f.db, query: async () => ({ status: "UNKNOWN" }), clock: () => NOW,
    requestSpacingMilliseconds: 60_000, onError: code => f.errors.push(code) });
  try {
    f.add("UNKNOWN"); f.add("UNKNOWN");
    const run = scheduler.trigger();
    await new Promise<void>(resolve => setImmediate(resolve));
    await scheduler.stop();
    assert.equal(await run, 1);
    assert.deepEqual(f.errors, []);
  } finally { await scheduler.stop(); await f.close(); }
});

it("aborts shutdown promptly and never writes a late provider reply", async () => {
  let finish!: (observation: InvoiceObservation) => void, signal: AbortSignal | undefined;
  const f = await fixture((_request, abort) => { signal = abort; return new Promise(resolve => { finish = resolve; }); });
  try {
    const id = f.add("UNKNOWN");
    const run = f.scheduler.trigger();
    await f.scheduler.stop();
    assert.equal(signal?.aborted, true);
    assert.equal(await run, 0);
    finish({ status: "ISSUED", invoiceNo: "12345678901234567890" });
    await Promise.resolve();
    assert.equal(f.read(id)?.status, "UNKNOWN");
    await assert.rejects(f.scheduler.trigger(), /stopped/);
  } finally { await f.close(); }
});

it("rejects a second database process before it can start a competing query worker", async () => {
  const f = await fixture(async () => ({ status: "UNKNOWN" }));
  try {
    await assert.rejects(AppDatabase.open(`${f.directory}/db.sqlite`, { masterKey: f.key }), /owns the database lease/);
  } finally { await f.close(); }
});

it("uses the unresolved invoice index instead of scanning terminal invoice history", async () => {
  const f = await fixture(async () => ({ status: "UNKNOWN" }));
  try {
    const plan = f.db.read(sql => sql.prepare(`EXPLAIN QUERY PLAN SELECT invoice_id,merchant_id FROM epay_tax_invoice_requests
      WHERE status IN ('UNKNOWN','PROCESSING','REVERSING') AND updated_at<=?
      ORDER BY updated_at,invoice_id LIMIT 1`).all(NOW));
    assert.ok(plan.some(row => String(row.detail).includes("epay_tax_invoice_pending_query")));
    assert.ok(plan.every(row => !String(row.detail).includes("TEMP B-TREE")));
  } finally { await f.close(); }
});
