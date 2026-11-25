import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Hono } from "hono";
import { AppDatabase } from "../src/database/database.ts";
import { createIsolatedEPayQuery } from "../src/epay-compat/isolated-api-query.ts";
import { readEPayParams, readEPayQueryParams } from "../src/epay-compat/shadow-gateway.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";

const fields = { act: "order", pid: "1", key: "fixture+key&encoded=value", out_trade_no: "external-1" };
const formHeaders = { "content-type": "application/x-www-form-urlencoded" };

describe("legacy EPay query transport compatibility", () => {
  let directory: string;
  let database: AppDatabase;
  let query: Hono;

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), "epay-query-compat-"));
    const masterKey = randomBytes(32);
    database = await AppDatabase.open(join(directory, "db.sqlite"), { masterKey });
    const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
    database.write(sql => {
      sql.exec("INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'one',0,1,0,0)");
      const sealed = cipher.encrypt("epay:merchant:1:api_key", 1, fields.key);
      sql.prepare("INSERT INTO epay_merchant_secrets VALUES (1,1,1,?,?,?,?,0)").run(
        sealed.nonce, sealed.ciphertext, sealed.authenticationTag,
        createHash("sha256").update(fields.key).digest("hex"),
      );
      sql.exec(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
        VALUES ('trade-1','external-1',1,'item',1,'https://example.test','PENDING','PENDING',0,0,0)`);
    });
    query = createIsolatedEPayQuery({ database, masterKey });
  });

  after(() => {
    database?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("returns the same authenticated order for GET, form POST and matching query plus form POST", async () => {
    const encoded = new URLSearchParams(fields);
    const responses = [
      await query.request(`/api.php?${encoded}`),
      await query.request("/api.php", { method: "POST", headers: formHeaders, body: encoded }),
      await query.request(`/api.php?${encoded}`, { method: "POST", headers: formHeaders, body: encoded }),
      await query.request(`/api.php?${encoded}`, { method: "POST" }),
    ];
    const expected = await responses[0]!.json() as { code: number; trade_no: string };
    assert.equal(expected.code, 1);
    assert.equal(expected.trade_no, "trade-1");
    for (const response of responses) {
      assert.equal(response.status, 200);
      if (response !== responses[0]) assert.deepEqual(await response.json(), expected);
    }
  });

  it("accepts unambiguous fields split between the query and form", async () => {
    const response = await query.request("/api.php?act=order", {
      method: "POST", headers: formHeaders,
      body: new URLSearchParams({ pid: fields.pid, key: fields.key, out_trade_no: fields.out_trade_no }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { trade_no: string }).trade_no, "trade-1");
  });

  it("rejects conflicting authentication, action and order fields", async () => {
    for (const name of Object.keys(fields)) {
      const body = new URLSearchParams(fields);
      body.set(name, "conflicting-value");
      const response = await query.request(`/api.php?${new URLSearchParams(fields)}`, {
        method: "POST", headers: formHeaders, body,
      });
      assert.equal(response.status, 400, name);
      assert.equal((await response.json() as { code: number }).code, -2, name);
    }
  });

  it("applies the same ambiguity checks to JSON bodies", async () => {
    const target = `/api.php?${new URLSearchParams(fields)}`;
    const post = (body: string) => query.request(target, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    const accepted = await post(JSON.stringify(fields));
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json() as { trade_no: string }).trade_no, "trade-1");
    assert.equal((await post(JSON.stringify({ ...fields, pid: "2" }))).status, 400);
    assert.equal((await post('{"pid":"1","pid":"1"}')).status, 400);
  });

  it("still authenticates matching credentials against the merchant key", async () => {
    const wrongKey = new URLSearchParams({ ...fields, key: "wrong-key" });
    const response = await query.request(`/api.php?${wrongKey}`, {
      method: "POST", headers: formHeaders, body: wrongKey,
    });
    assert.equal(response.status, 400);
  });

  it("rejects duplicate keys within either input source even when their values match", async () => {
    for (const source of ["query", "form"]) {
      const url = new URLSearchParams(fields);
      const body = new URLSearchParams(fields);
      (source === "query" ? url : body).append("pid", fields.pid);
      const response = await query.request(`/api.php?${url}`, { method: "POST", headers: formHeaders, body });
      assert.equal(response.status, 400, source);
    }
  });

  it("keeps mixed inputs forbidden on signed payment creation", async () => {
    for (const endpoint of ["mapi.php", "submit.php"]) {
      const request = new Request(`https://example.test/${endpoint}?pid=1`, {
        method: "POST", headers: formHeaders, body: "pid=1",
      });
      await assert.rejects(readEPayParams(request), /query parameters are not allowed/);
    }
  });

  it("enforces body and target size limits on compatibility requests", async () => {
    await assert.rejects(readEPayQueryParams(new Request(`https://example.test/api.php?padding=${"x".repeat(16_385)}`)), /target too large/);
    await assert.rejects(readEPayQueryParams(new Request("https://example.test/api.php?act=order", {
      method: "POST", headers: formHeaders, body: `padding=${"x".repeat(16_385)}`,
    })), /body too large/);
  });
});
