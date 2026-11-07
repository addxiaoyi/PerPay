import { PayoutScheduler } from "./payout-scheduler.ts";
import { reconcilePayoutDay } from "./payout-reconciliation.ts";
import type { PayoutServices } from "./payout-routes.ts";
import type { WechatPayoutService } from "./payout-wechat.ts";
import type { processPayout } from "./payout-worker.ts";

type Options = Parameters<typeof processPayout>[0] & { wechat?: WechatPayoutService };

// Composition is explicit: collection credentials alone must never enable outbound payments.
export function createPayoutRuntime(options: Options) {
  for (const [kind, channel] of Object.entries(options.policy.channels)) {
    const adapter = options.adapters[kind as keyof typeof options.adapters];
    if (options.policy.enabled && (!adapter || adapter.payer !== channel.account)) throw new Error("enabled payout channel has no matching adapter");
  }
  const clock = options.clock ?? Date.now, worker = new PayoutScheduler(options);
  let timer: NodeJS.Timeout | undefined, running: Promise<unknown> | undefined, stopped = false;
  const reconcile = (day: string) => {
    if (stopped) return Promise.reject(new Error("payout reconciliation is stopped"));
    if (running) return Promise.reject(new Error("payout reconciliation is already running"));
    running = reconcilePayoutDay({ ...options, day }).finally(() => { running = undefined; });
    return running;
  };
  const daily = async () => {
    const now = clock(), day = new Date(now + 8 * 3600000 - 86400000).toISOString().slice(0, 10);
    // The owning process holds the database lease; interrupted runs remain flagged for an explicit retry.
    const complete = options.database.read(sql => sql.prepare("SELECT 1 FROM epay_payout_reconciliations WHERE business_day=? AND status IN ('COMPLETE','ATTENTION') LIMIT 1").get(day));
    if (!complete && !running) await reconcile(day);
  };
  const services: PayoutServices = { policy: options.policy, reconcile, ...(options.wechat ? { wechat: options.wechat } : {}) };
  return { services, worker, reconcile,
    async start() {
      if (stopped) throw new Error("payout runtime is stopped");
      if (timer) return;
      options.database.write(sql => sql.prepare("UPDATE epay_payout_reconciliations SET status='ATTENTION',finished_at=?,issue_count=issue_count+1 WHERE status='RUNNING'").run(clock()));
      timer = setInterval(() => { void daily().catch(() => options.onError("payout_daily_reconciliation_failed")); }, 60000); timer.unref();
      try { await worker.start(); await daily(); }
      catch (cause) {
        stopped = true; clearInterval(timer); timer = undefined;
        try { await worker.stop(); } catch (cleanup) { throw new AggregateError([cause, cleanup], "payout runtime start and cleanup failed"); }
        throw cause;
      }
    },
    async stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; await worker.stop(); await running; },
  };
}
