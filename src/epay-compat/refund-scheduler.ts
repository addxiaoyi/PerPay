import { claimRefund, deferRefund, type RefundLease } from "./refund-queue.ts";
import type { RefundDatabase } from "./refund-store.ts";

type Options = { database: RefundDatabase; process: (lease: RefundLease) => Promise<void>; onError: (code: string) => void; clock?: () => number };
export class EPayRefundScheduler {
  readonly #options: Options;
  #timer: NodeJS.Timeout | null = null;
  #current: Promise<number> | null = null;
  #stopped = false;
  constructor(options: Options) { this.#options = options; }
  start() {
    if (this.#stopped) return Promise.reject(new Error("refund scheduler is stopped"));
    if (!this.#timer) {
      this.#timer = setInterval(() => { void this.trigger().catch(() => this.#options.onError("epay_refund_schedule_failed")); }, 5000);
      this.#timer.unref();
    }
    return this.trigger();
  }
  trigger(): Promise<number> {
    if (this.#stopped) return Promise.reject(new Error("refund scheduler is stopped"));
    if (!this.#current) this.#current = this.#run().finally(() => { this.#current = null; });
    return this.#current;
  }
  health() { return { state: this.#stopped ? "stopped" : this.#timer ? "running" : "idle", inFlight: this.#current !== null }; }
  async stop() {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#current;
  }
  async #run() {
    let processed = 0;
    const now = this.#options.clock ?? Date.now;
    while (!this.#stopped && processed < 5) {
      const lease = claimRefund(this.#options.database, now());
      if (!lease) break;
      try { await this.#options.process(lease); }
      catch {
        deferRefund(this.#options.database, lease, now(), "provider_verification_pending");
        this.#options.onError("epay_refund_verification_pending");
      }
      processed++;
    }
    return processed;
  }
}
