import assert from "node:assert/strict";
import { it } from "node:test";
import { pauseEPayOrders } from "../src/epay-compat/pause-orders.ts";
import { installBalanceOpenings, planBalanceOpenings } from "../src/epay-compat/balance-opening.ts";
import { readLiveBalance } from "../src/epay-compat/live-balance.ts";
import { balanceFixture } from "./epay-live-balance-fixture.ts";

async function buildFixture() {
  const fixture = await balanceFixture();
  fixture.db.write(sql => {
    installBalanceOpenings(sql, fixture.cipher, planBalanceOpenings(sql, fixture.cipher, "a".repeat(64)), 100);
    for (const merchant of [1, 2]) {
      const site = `site-${merchant}`;
      sql.prepare("INSERT INTO api_client_config VALUES(?,?,1,1,0,0)").run(site, "b".repeat(64));
      sql.prepare("INSERT INTO sites(client_id,revision,configuration,created_at,updated_at) VALUES(?,0,?,0,0)")
        .run(site, JSON.stringify({ accepting_orders: true, notifications_enabled: true, name: site }));
      sql.prepare("INSERT INTO epay_site_bindings VALUES(?,?,0)").run(merchant, site);
    }
  });
  return fixture;
}

it("pauses every EPay site atomically without replacing financial records or disabling callbacks", async () => {
  const fixture = await buildFixture();
  try {
    const before = fixture.db.read(sql => ({
      balances: [readLiveBalance(sql, 1), readLiveBalance(sql, 2)],
      orders: sql.prepare("SELECT * FROM epay_orders ORDER BY trade_no").all(),
      ledger: sql.prepare("SELECT * FROM epay_balance_ledger ORDER BY entry_id").all(),
      callbacks: sql.prepare("SELECT * FROM epay_callback_jobs ORDER BY trade_no").all(),
    }));
    assert.deepEqual(pauseEPayOrders(fixture.db, { actorId: "release-operator", reason: "切换回退" }, 200), { pausedSites: 2, alreadyPausedSites: 0 });
    assert.deepEqual(pauseEPayOrders(fixture.db, { actorId: "release-operator", reason: "切换回退" }, 201), { pausedSites: 0, alreadyPausedSites: 2 });
    fixture.db.read(sql => {
      assert.deepEqual([readLiveBalance(sql, 1), readLiveBalance(sql, 2)], before.balances);
      assert.deepEqual(sql.prepare("SELECT * FROM epay_orders ORDER BY trade_no").all(), before.orders);
      assert.deepEqual(sql.prepare("SELECT * FROM epay_balance_ledger ORDER BY entry_id").all(), before.ledger);
      assert.deepEqual(sql.prepare("SELECT * FROM epay_callback_jobs ORDER BY trade_no").all(), before.callbacks);
      const sites = sql.prepare("SELECT configuration,revision FROM sites ORDER BY client_id").all();
      for (const site of sites) {
        assert.equal(JSON.parse(String(site.configuration)).accepting_orders, false);
        assert.equal(JSON.parse(String(site.configuration)).notifications_enabled, true);
        assert.equal(Number(site.revision), 1);
      }
      const events = sql.prepare("SELECT actor_id,action,details_json FROM audit_events WHERE action='epay.orders.paused'").all();
      assert.equal(events.length, 2);
      assert.ok(events.every(event => event.actor_id === "release-operator" && JSON.parse(String(event.details_json)).reason === "切换回退"));
    });
  } finally { fixture.close(); }
});

// A source site can be invalid even when another site's update already succeeded.
it("rolls back all pauses and audit entries if any site or audit write is invalid", async () => {
  for (const failure of ["configuration", "audit"]) {
    const fixture = await buildFixture();
    try {
      fixture.db.write(sql => failure === "configuration"
        ? sql.exec("UPDATE sites SET configuration='{}',revision=revision+1 WHERE client_id='site-2'")
        : sql.exec("CREATE TRIGGER reject_pause_audit BEFORE INSERT ON audit_events WHEN NEW.action='epay.orders.paused' AND NEW.subject_id='site-2' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END"));
      assert.throws(() => pauseEPayOrders(fixture.db, { actorId: "release-operator", reason: "回退" }, 200));
      fixture.db.read(sql => {
        const site = sql.prepare("SELECT configuration,revision FROM sites WHERE client_id='site-1'").get()!;
        assert.equal(JSON.parse(String(site.configuration)).accepting_orders, true);
        assert.equal(Number(site.revision), 0);
        assert.equal(Number(sql.prepare("SELECT count(*) n FROM audit_events WHERE action='epay.orders.paused'").get()?.n), 0);
      });
    } finally { fixture.close(); }
  }
});

it("validates operator and cutoff before opening a write transaction", () => {
  const database = { write: () => assert.fail("invalid pause must not write") };
  for (const actorId of ["", " operator", "operator\n"]) assert.throws(() => pauseEPayOrders(database, { actorId, reason: "回退" }, 200));
  for (const reason of ["", " reason", "reason\n"]) assert.throws(() => pauseEPayOrders(database, { actorId: "operator", reason }, 200));
  assert.throws(() => pauseEPayOrders(database, { actorId: "operator", reason: "回退" }, -1));
});
