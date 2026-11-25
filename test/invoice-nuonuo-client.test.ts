import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { it } from "node:test";
import { createNuonuoInvoiceClient, NuonuoProtocolError, type NuonuoCachedToken, type NuonuoInvoiceClientOptions, type NuonuoPcInvoiceOrder } from "../src/invoices/nuonuo-client.ts";

const order: NuonuoPcInvoiceOrder = {
  orderNo: "persisted-order-20261121-1", salerTaxNum: "91310000123456789X", buyerName: "Fixture buyer", buyerTaxNum: "91310000987654321X",
  invoiceDate: "2026-11-21 20:00:00", invoiceDetail: [{ goodsName: "Software service", goodsCode: "3040201000000000000", taxRate: "0.06",
    taxIncludedAmount: "10.60", taxExcludedAmount: "10.00", tax: "0.60", withTaxFlag: "1", invoiceLineProperty: "0" }],
};

it("uses the official fixed gateway and signs the exact submitted pc invoice bytes", async () => {
  const f = fixture();
  assert.deepEqual(await f.client.submitPcInvoice(order), { status: "ACCEPTED", orderNo: order.orderNo, invoiceSerialNum: "fixture-serial-1" });
  assert.equal(f.calls.length, 2);
  const token = f.calls[0]!, request = f.calls[1]!, url = new URL(request.url), headers = new Headers(request.init?.headers);
  assert.equal(token.url, "https://open.nuonuo.com/accessToken");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(token.init?.body))), { client_id: "fixture-app", client_secret: "fixture-secret", grant_type: "client_credentials" });
  assert.equal(url.origin, "https://sandbox.nuonuocs.cn");
  assert.equal(url.pathname, "/open/v1/services");
  assert.match(url.searchParams.get("senid")!, /^[a-f0-9]{32}$/);
  assert.match(url.searchParams.get("nonce")!, /^[1-9]\d{7}$/);
  assert.equal(url.searchParams.get("timestamp"), String(Math.floor(f.now() / 1000)));
  assert.equal(headers.get("method"), "nuonuo.OpeMplatform.requestBillingNew");
  assert.equal(headers.get("accesstoken"), "fixture-token");
  assert.equal(headers.get("usertax"), order.salerTaxNum);
  const body = JSON.parse(String(request.init?.body)) as { order: Record<string, unknown> };
  assert.deepEqual(body.order, { ...order, invoiceLine: "pc", invoiceType: "1", pushMode: "-1" });
  const canonical = `a=services&l=v1&p=open&k=fixture-app&i=${url.searchParams.get("senid")}&n=${url.searchParams.get("nonce")}&t=${url.searchParams.get("timestamp")}&f=${String(request.init?.body)}`;
  assert.equal(headers.get("x-nuonuo-sign"), createHmac("sha1", "fixture-secret").update(canonical).digest("base64"));
  for (const call of f.calls) { assert.equal(call.init?.redirect, "error"); assert.equal(call.init?.cache, "no-store"); assert.ok(call.init?.signal); }
  assert.equal(f.saved.length, 1);
});

it("reuses a persistent token across client restarts and merges concurrent refreshes", async () => {
  const f = fixture();
  await Promise.all([f.client.submitPcInvoice(order), f.client.submitPcInvoice({ ...order, orderNo: "persisted-order-2" })]);
  assert.equal(f.calls.filter(call => call.url === "https://open.nuonuo.com/accessToken").length, 1);
  const restarted = f.newClient();
  await restarted.submitPcInvoice({ ...order, orderNo: "persisted-order-3" });
  assert.equal(f.calls.filter(call => call.url === "https://open.nuonuo.com/accessToken").length, 1);
  f.advance(86_400_000);
  await restarted.submitPcInvoice({ ...order, orderNo: "persisted-order-4" });
  assert.equal(f.calls.filter(call => call.url === "https://open.nuonuo.com/accessToken").length, 2);
});

it("does not obtain a new token when persistent cache access fails", async () => {
  const f = fixture({ loadFails: true });
  await assert.rejects(f.client.submitPcInvoice(order), error => isError(error, "token_cache_unavailable", "NOT_SUBMITTED"));
  assert.equal(f.calls.length, 0);
});

it("holds the persistent refresh lock across acquisition for separate clients sharing the same account", async () => {
  const f = fixture(), other = f.newClient();
  await Promise.all([f.client.submitPcInvoice(order), other.submitPcInvoice({ ...order, orderNo: "other-persisted-order" })]);
  assert.equal(f.calls.filter(call => call.url === "https://open.nuonuo.com/accessToken").length, 1);
});

it("snapshots account settings at construction before token or invoice calls", async () => {
  const f = fixture();
  f.options.environment = "production";
  f.options.appKey = "other-account";
  f.options.appSecret = "other-secret";
  f.options.sellerTaxId = "91310000999999999X";
  await f.client.submitPcInvoice(order);
  const url = new URL(f.calls[1]!.url);
  assert.equal(url.origin, "https://sandbox.nuonuocs.cn");
  assert.equal(url.searchParams.get("appkey"), "fixture-app");
  assert.equal(new URLSearchParams(String(f.calls[0]!.init?.body)).get("client_secret"), "fixture-secret");
});

it("keeps an acquired token after a cache save failure instead of consuming another token grant", async () => {
  const f = fixture({ saveFailures: 1 });
  await assert.rejects(f.client.submitPcInvoice(order), error => isError(error, "token_cache_unavailable", "NOT_SUBMITTED"));
  assert.equal(f.calls.length, 1);
  await f.client.submitPcInvoice(order);
  assert.equal(f.calls.filter(call => call.url === "https://open.nuonuo.com/accessToken").length, 1);
});

it("preserves duplicate, HTTP failure, malformed and timed-out submissions as uncertain without retrying", async () => {
  for (const reply of [
    new Response(JSON.stringify({ code: "E9106", describe: "private buyer fixture-secret fixture-token" }), { status: 200 }),
    new Response(JSON.stringify({ code: "E0000", result: { invoiceSerialNum: "fixture-serial-1" } }), { status: 503 }),
    new Response("<html>fixture-secret fixture-token</html>"),
    new Response('{"code":"E0000","code":"E0000","result":{"invoiceSerialNum":"fixture-serial-1"}}'),
    new Response(JSON.stringify({ code: "E0000", result: {} })),
    new Error("timeout fixture-secret fixture-token"),
  ]) {
    const f = fixture({ issueReply: reply });
    await assert.rejects(f.client.submitPcInvoice(order), error => {
      assert.ok(error instanceof NuonuoProtocolError);
      assert.equal(error.outcome, "UNKNOWN");
      assert.doesNotMatch(error.message, /fixture-secret|fixture-token|private buyer/);
      return true;
    });
    assert.equal(f.calls.length, 2);
    assert.equal((JSON.parse(String(f.calls[1]!.init?.body)) as { order: { orderNo: string } }).order.orderNo, order.orderNo);
  }
});

it("rejects invalid tax identity, money, email and callbacks before sending", async () => {
  const invalid: unknown[] = [
    { ...order, salerTaxNum: "91310000999999999X" },
    { ...order, orderNo: "" },
    { ...order, invoiceDetail: [] },
    { ...order, invoiceDetail: [{ ...order.invoiceDetail[0], tax: "not-a-decimal" }] },
    { ...order, invoiceDetail: [{ ...order.invoiceDetail[0], taxIncludedAmount: "10.61" }] },
    { ...order, invoiceDetail: [{ ...order.invoiceDetail[0], taxRate: undefined }] },
    { ...order, email: "a".repeat(45) + "@example.test" },
    { ...order, callBackUrl: "https://other.example.test/invoice" },
    { ...order, invoiceLine: "p" },
  ];
  for (const input of invalid) {
    const f = fixture();
    await assert.rejects(f.client.submitPcInvoice(input as NuonuoPcInvoiceOrder), error => isError(error, "invalid_invoice", "NOT_SUBMITTED"));
    assert.equal(f.calls.length, 0);
  }
});

it("rejects cache entries belonging to another application before acquiring a token", async () => {
  const f = fixture({ cached: { accountKey: "other-application", accessToken: "fixture-token", issuedAt: 1_795_264_000_000, expiresAt: 1_795_350_400_000 } });
  await assert.rejects(f.client.submitPcInvoice(order), error => isError(error, "invalid_token_cache", "NOT_SUBMITTED"));
  assert.equal(f.calls.length, 0);
});

it("limits requests and responses before accepting an invoice receipt", async () => {
  const oversized = fixture();
  await assert.rejects(oversized.client.submitPcInvoice({ ...order, invoiceDetail: Array.from({ length: 2000 }, () => ({ ...order.invoiceDetail[0]! })) }),
    error => isError(error, "invalid_invoice", "NOT_SUBMITTED"));
  assert.equal(oversized.calls.length, 0);
  const f = fixture({ issueReply: Response.json({ code: "E0000", result: { invoiceSerialNum: "fixture-serial-1" }, unexpected: "x".repeat(65_536) }) });
  await assert.rejects(f.client.submitPcInvoice(order), error => isError(error, "invoice_response_uncertain", "UNKNOWN"));
  assert.equal(f.calls.length, 2);
});

it("blocks invalid cache entries and tokens without disclosing response contents", async () => {
  for (const tokenReply of [
    { access_token: "fixture-token", expires_in: 0 },
    { access_token: "fixture-token", expires_in: 86_401 },
    { access_token: "bad\r\nfixture-secret", expires_in: 86_400 },
    { error: "fixture-secret fixture-token" },
  ]) {
    const f = fixture({ tokenReply });
    await assert.rejects(f.client.submitPcInvoice(order), error => {
      assert.ok(error instanceof NuonuoProtocolError);
      assert.equal(error.outcome, "NOT_SUBMITTED");
      assert.doesNotMatch(error.message, /fixture-secret|fixture-token/);
      return true;
    });
    assert.equal(f.calls.length, 1);
  }
});

it("cancels one waiting caller without aborting the shared token refresh or issuing its invoice", async () => {
  let unblock!: () => void;
  const wait = new Promise<void>(resolve => { unblock = resolve; });
  const f = fixture({ beforeToken: () => wait }), abort = new AbortController();
  const canceled = f.client.submitPcInvoice(order, abort.signal);
  const continuing = f.client.submitPcInvoice({ ...order, orderNo: "persisted-uncanceled-order" });
  abort.abort();
  await assert.rejects(canceled, error => isError(error, "request_aborted", "NOT_SUBMITTED"));
  unblock();
  await continuing;
  assert.equal(f.calls.length, 2);
});

function isError(error: unknown, code: string, outcome: string): boolean {
  assert.ok(error instanceof NuonuoProtocolError);
  assert.equal(error.code, code);
  assert.equal(error.outcome, outcome);
  return true;
}

function fixture(options: { loadFails?: boolean; saveFailures?: number; issueReply?: Response | Error; tokenReply?: unknown; beforeToken?: () => Promise<void>; cached?: NuonuoCachedToken } = {}) {
  let now = 1_795_264_000_000, cache = options.cached, saveFailures = options.saveFailures ?? 0;
  let lock = Promise.resolve();
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [], saved: NuonuoCachedToken[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://open.nuonuo.com/accessToken") {
      await options.beforeToken?.();
      return Response.json(options.tokenReply ?? { access_token: "fixture-token", expires_in: "86400" });
    }
    if (options.issueReply instanceof Error) throw options.issueReply;
    return options.issueReply ?? Response.json({ code: "E0000", result: { invoiceSerialNum: "fixture-serial-1" } });
  };
  const config: NuonuoInvoiceClientOptions = { environment: "sandbox", appKey: "fixture-app", appSecret: "fixture-secret", sellerTaxId: order.salerTaxNum,
    transport, clock: () => now, tokenCache: {
      async withLock<T>(_key: string, task: () => Promise<T>): Promise<T> {
        const previous = lock;
        let release!: () => void;
        lock = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try { return await task(); } finally { release(); }
      },
      async load() { if (options.loadFails) throw new Error("private storage fixture-secret"); return cache; },
      async save(_key, token) { if (saveFailures-- > 0) throw new Error("storage fixture-secret"); cache = { ...token }; saved.push(token); },
    } };
  const newClient = () => createNuonuoInvoiceClient(config);
  return { client: newClient(), options: config, newClient, calls, saved, now: () => now, advance: (milliseconds: number) => { now += milliseconds; } };
}
