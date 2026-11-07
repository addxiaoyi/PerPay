import { processPayout } from "./payout-worker.ts";

export class PayoutScheduler {
  readonly #options: Parameters<typeof processPayout>[0];
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<number> | undefined;
  #stopped = false;

  constructor(options: Parameters<typeof processPayout>[0]) { this.#options = options; }

  start(): Promise<number> {
    if (this.#stopped) return Promise.reject(new Error("payout scheduler is stopped"));
    if (!this.#timer) {
      this.#timer = setInterval(() => { void this.trigger().catch(() => this.#options.onError("payout_scheduler_failed")); }, 5000);
      this.#timer.unref();
    }
    return this.trigger();
  }

  trigger(): Promise<number> {
    if (this.#stopped) return Promise.reject(new Error("payout scheduler is stopped"));
    this.#running ??= this.#drain().finally(() => { this.#running = undefined; });
    return this.#running;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  async #drain(): Promise<number> {
    let processed = 0;
    while (!this.#stopped && processed < 5 && await processPayout(this.#options)) processed++;
    return processed;
  }
}
