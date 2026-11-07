import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import { readPayoutDestination } from "./payout-accounts.ts";
import { claimPayout, completePayout, deferPayout } from "./payout-queue.ts";
import type { PayoutChannel, PayoutDatabase, PayoutDestination, PayoutLease, PayoutPolicy, PayoutProof } from "./payout-model.ts";

export type PayoutAdapter = Readonly<{ payer: string; execute: (lease: PayoutLease, destination: PayoutDestination, signal: AbortSignal) => Promise<PayoutProof> }>;
type Options = { database: PayoutDatabase; cipher: RuntimeSecretCipher; policy: PayoutPolicy; adapters: Readonly<Partial<Record<PayoutChannel, PayoutAdapter>>>; clock?: () => number; onError: (code: string) => void };

export async function processPayout(options: Options): Promise<boolean> {
  const clock = options.clock ?? Date.now;
  const channels = Object.fromEntries(Object.entries(options.policy.channels).filter(([kind, config]) => options.adapters[kind as PayoutChannel]?.payer === config.account));
  const lease = claimPayout(options.database, { ...options.policy, channels }, clock());
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
