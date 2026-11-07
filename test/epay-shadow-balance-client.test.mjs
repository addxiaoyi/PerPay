import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { createShadowBalanceWorkspace } from "../src/epay-compat/shadow-balance-workspace.ts";
import { preserveMainPaymentArchive } from "../src/epay-compat/main-payment-archive.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { readShadowBalance, ShadowBalanceError } from "./fixtures/legacy-epay/perpay-shadow-balance.ts";

it("connects the workspace proxy to an authorized isolated balance without trusting upstream shape", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-balance-client-"));
  const key = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: key });
  try {
    new RuntimeSettingsStore(db, key).initialize();
    db.write(sql => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'one',0,1,0,0);
        INSERT INTO epay_merchant_bindings VALUES ('b','api-one','one',1,0,0);
        INSERT INTO epay_main_ledger_import_runs VALUES(1,0)`);
      preserveMainPaymentArchive(sql, new RuntimeSecretCipher(key, db.instanceId()), { merchants: [{ id: "one", apiId: "api-one", feeRate: 0.05 }], ledger: [], refunds: [], settlements: [] });
    });
    const identityFetch = async (_url, options) => new Headers(options.headers).get("cookie") === "session=ok" ? Response.json({ ok: true, merchantId: "one", apiId: "api-one", role: "owner" }) : new Response(null, { status: 401 });
    const app = createShadowBalanceWorkspace({ database: db, masterKey: key, identityOrigin: "http://127.0.0.1:8787", identityFetch });
    const fetch = (url, options) => app.request(`/shadow-ledger-balance${new URL(String(url)).search}`, options);
    const input = { origin: "http://127.0.0.1:6190", cookie: "session=ok", merchantId: "one", fetch };
    assert.deepEqual(await readShadowBalance(input), { merchantId: "one", availableCents: 0, frozenCents: 0, scope: "shadow_ledger_projection", financiallyReconciled: false });
    await assert.rejects(() => readShadowBalance({ ...input, merchantId: "other" }), e => e instanceof ShadowBalanceError && e.status === 404);
    await assert.rejects(() => readShadowBalance({ ...input, cookie: "session=bad" }), e => e instanceof ShadowBalanceError && e.status === 401);
    await assert.rejects(() => readShadowBalance({ ...input, origin: "http://example.com" }), e => e instanceof ShadowBalanceError && e.status === 503);
    await assert.rejects(() => readShadowBalance({ ...input, fetch: async () => Response.json({ ok: true, data: { merchantId: "one", scope: "shadow_ledger_projection", financiallyReconciled: true, availableCents: 1, frozenCents: 0 } }) }), e => e instanceof ShadowBalanceError && e.status === 503);
  } finally { db.close(); key.fill(0); rmSync(dir, { recursive: true, force: true }); }
});
