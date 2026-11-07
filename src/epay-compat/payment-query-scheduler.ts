import type { AppDatabase } from "../database/database.ts";
import { completePaymentQuery, reservePaymentQuery, type QueryJob, type QueryProvider } from "./payment-query-jobs.ts";

type QueryOutcome = { paymentConfirmed: boolean };
type Options = {
  database: Pick<AppDatabase, "write">;
  query: Readonly<Record<QueryProvider, (tradeNo: string) => Promise<QueryOutcome>>>;
  clock?: () => number;
  intervalMilliseconds: number;
  maximumPerRun: number;
  onError: (code: string) => void;
};

export class EPayPaymentQueryScheduler {
  readonly #options: Options;
  #timer: NodeJS.Timeout | null = null;
  #current: Promise<number> | null = null;
  #stopped = false;
  #lastRunAt: number | null = null;
  #lastFailureAt: number | null = null;
  #failures = 0;

  constructor(options: Options) {
    if (!Number.isSafeInteger(options.intervalMilliseconds) || options.intervalMilliseconds < 1000 || options.intervalMilliseconds > 60_000 || !Number.isSafeInteger(options.maximumPerRun) || options.maximumPerRun < 1 || options.maximumPerRun > 20) throw new Error("invalid EPay payment query schedule");
    this.#options = options;
  }

  start(): Promise<number> {
    if (this.#stopped) return Promise.reject(new Error("EPay payment query scheduler is stopped"));
    if (!this.#timer) {
      this.#timer = setInterval(() => { void this.trigger().catch(() => this.#options.onError("epay_payment_query_schedule_failed")); }, this.#options.intervalMilliseconds);
      this.#timer.unref();
    }
    return this.trigger();
  }

  trigger(): Promise<number> {
    if (this.#stopped) return Promise.reject(new Error("EPay payment query scheduler is stopped"));
    if (this.#current) return this.#current;
    this.#current = this.#run().finally(() => { this.#current = null; });
    return this.#current;
  }

  health() {
    return { state: this.#stopped ? "stopped" as const : this.#timer ? "running" as const : "idle" as const, inFlight: this.#current !== null, lastRunAt: this.#lastRunAt, lastFailureAt: this.#lastFailureAt, failures: this.#failures };
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#current;
  }

  #now(): number {
    const now = (this.#options.clock ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid EPay payment query clock");
    return now;
  }

  async #run(): Promise<number> {
    let processed = 0;
    while (!this.#stopped && processed < this.#options.maximumPerRun) {
      const job = reservePaymentQuery(this.#options.database, this.#now());
      if (!job) break;
      await this.#query(job);
      processed++;
    }
    this.#lastRunAt = this.#now();
    return processed;
  }

  async #query(job: QueryJob): Promise<void> {
    let outcome: "pending" | "confirmed" | "failed";
    try {
      const payment = await this.#options.query[job.provider](job.tradeNo);
      outcome = payment.paymentConfirmed ? "confirmed" : "pending";
    } catch {
      outcome = "failed";
      this.#lastFailureAt = this.#now();
      this.#failures++;
      this.#options.onError("epay_payment_query_failed");
    }
    completePaymentQuery(this.#options.database, job, outcome, this.#now());
  }
}
