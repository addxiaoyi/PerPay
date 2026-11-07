import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import { readPayoutDestination } from "./payout-accounts.ts";
import { claimPayout, completePayout, deferPayout } from "./payout-queue.ts";
import type { PayoutChannel, PayoutDatabase, PayoutDestination, PayoutLease, PayoutPolicy, PayoutProof } from "./payout-model.ts";

export type PayoutAdapter = Readonly<{ payer: string; prepare?: (accountId: string, merchantId: number, signal: AbortSignal) => Promise<void>; execute: (lease: PayoutLease, destination: PayoutDestination, signal: AbortSignal) => Promise<PayoutProof> }>;
type Options = { database: PayoutDatabase; cipher: RuntimeSecretCipher; policy: PayoutPolicy; adapters: Readonly<Partial<Record<PayoutChannel, PayoutAdapter>>>; clock?: () => number; onError: (code: string) => void };

export async function processPayout(options: Options): Promise<boolean> {
  const clock = options.clock ?? Date.now;
  const channels = Object.fromEntries(Object.entries(options.policy.channels).filter(([kind, config]) => options.adapters[kind as PayoutChannel]?.payer === config.account));
  const prepared = new Set<string>();
  if (options.policy.enabled) {
    const pending = options.database.read(sql => sql.prepare(`SELECT p.settlement_id,p.account_id,p.merchant_id,p.channel,p.payer FROM epay_payouts p
      JOIN epay_payout_accounts a ON a.account_id=p.account_id AND a.merchant_id=p.merchant_id AND a.status='APPROVED'
      JOIN epay_merchant_accounts m ON m.merchant_id=p.merchant_id AND m.enabled=1
      WHERE p.status='READY' AND p.submitted_at IS NULL AND p.next_at<=? ORDER BY p.next_at,p.created_at,p.settlement_id LIMIT 10`).all(clock()));
    for (const row of pending) {
      const adapter = options.adapters[String(row.channel) as PayoutChannel];
      if (!adapter || channels[String(row.channel)]?.account !== row.payer) continue;
      try {
        const signal = AbortSignal.timeout(10000);
        if (adapter.prepare) await Promise.race([adapter.prepare(String(row.account_id), Number(row.merchant_id), signal), new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("payout preflight timeout")), { once: true }))]);
        prepared.add(String(row.settlement_id));
      } catch { options.onError("payout_authorization_requires_review"); }
    }
  }
  // A failed permission check did not send money: keep READY so an administrator can cancel the hold.
  const lease = claimPayout(options.database, { ...options.policy, channels }, clock(), prepared);
  if (!lease) return false;
  try {
    const destination = options.database.read(sql => readPayoutDestination(sql, options.cipher, lease.accountId, lease.merchantId));
    if (destination.kind !== lease.channel) throw new Error("payout destination differs");
    const signal = AbortSignal.timeout(20_000);
    const proof = await Promise.race([
      options.adapters[lease.channel]!.execute(lease, destination, signal),
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("payout provider timeout")), { once: true })),
    ]);
    completePayout(options.database, lease, proof, clock());
  } catch {
    deferPayout(options.database, lease, clock(), "payout_requires_query");
    options.onError("payout_requires_query");
  }
  return true;
}
