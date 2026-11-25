import { setTimeout as delay } from "node:timers/promises";
import { invoiceTime, parseInvoiceObservation, type InvoiceDatabase, type InvoiceObservation, type InvoiceProvider } from "./model.ts";
import { recordInvoiceObservation } from "./observations.ts";
import { claimInvoiceQuery, invoiceIssue, type InvoiceRow } from "./store.ts";

const QUERY_TIMEOUT_MS = 10_000;
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_SPACING_MS = 1_000;
const DEFAULT_BATCH_SIZE = 20;

type Options = {
  database: InvoiceDatabase;
  query: InvoiceProvider["query"];
  clock?: () => number;
  intervalMilliseconds?: number;
  requestSpacingMilliseconds?: number;
  maximumPerRun?: number;
  onError: (code: string) => void;
};

export class InvoiceQueryScheduler {
  readonly #options: Options;
  readonly #interval: number;
  readonly #spacing: number;
  readonly #batch: number;
  readonly #shutdown = new AbortController();
  #timer: NodeJS.Timeout | null = null;
  #current: Promise<number> | null = null;
  #lastRunAt: number | null = null;
  #failures = 0;

  constructor(options: Options) {
    this.#interval = options.intervalMilliseconds ?? DEFAULT_INTERVAL_MS;
    this.#spacing = options.requestSpacingMilliseconds ?? DEFAULT_SPACING_MS;
    this.#batch = options.maximumPerRun ?? DEFAULT_BATCH_SIZE;
    if (!Number.isSafeInteger(this.#interval) || this.#interval < 30_000 || this.#interval > 3_600_000
        || !Number.isSafeInteger(this.#spacing) || this.#spacing < 1 || this.#spacing > 60_000
        || !Number.isSafeInteger(this.#batch) || this.#batch < 1 || this.#batch > 20) throw new Error("invalid invoice query schedule");
    this.#options = options;
  }

  start(): Promise<number> {
    if (this.#shutdown.signal.aborted) return Promise.reject(new Error("invoice query scheduler is stopped"));
    if (!this.#timer) {
      this.#timer = setInterval(() => { void this.trigger().catch(() => this.#failed("invoice_query_schedule_failed")); }, this.#interval);
      this.#timer.unref();
    }
    return this.trigger();
  }

  trigger(): Promise<number> {
    if (this.#shutdown.signal.aborted) return Promise.reject(new Error("invoice query scheduler is stopped"));
    if (!this.#current) this.#current = this.#run().finally(() => { this.#current = null; });
    return this.#current;
  }

  health() {
    return { state: this.#shutdown.signal.aborted ? "stopped" as const : this.#timer ? "running" as const : "idle" as const,
      inFlight: this.#current !== null, lastRunAt: this.#lastRunAt, failures: this.#failures };
  }

  async stop(): Promise<void> {
    this.#shutdown.abort();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#current;
  }

  #now(): number { return invoiceTime((this.#options.clock ?? Date.now)()); }

  #failed(code: string): void {
    this.#failures++;
    this.#options.onError(code);
  }

  async #run(): Promise<number> {
    let queried = 0;
    while (!this.#shutdown.signal.aborted && queried < this.#batch) {
      if (queried) {
        try { await delay(this.#spacing, undefined, { signal: this.#shutdown.signal }); }
        catch (error) { if (this.#shutdown.signal.aborted) break; throw error; }
      }
      // AppDatabase owns the cross-process lease; touching the oldest request also reserves it across local workers.
      const row = claimInvoiceQuery(this.#options.database, this.#now(), this.#interval);
      if (!row) break;
      if (!await this.#query(row)) break;
      queried++;
    }
    this.#lastRunAt = this.#now();
    return queried;
  }

  async #query(row: InvoiceRow): Promise<boolean> {
    const signal = AbortSignal.any([this.#shutdown.signal, AbortSignal.timeout(QUERY_TIMEOUT_MS)]);
    let observation: InvoiceObservation;
    let cancel!: () => void;
    try {
      const aborted = new Promise<never>((_, reject) => {
        cancel = () => reject(signal.reason);
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      });
      observation = parseInvoiceObservation(await Promise.race([this.#options.query(invoiceIssue(row), signal), aborted]));
    } catch {
      if (this.#shutdown.signal.aborted) return false;
      this.#failed("invoice_query_failed");
      observation = { status: "UNKNOWN", errorCode: "invoice_provider_unavailable" };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
    if (this.#shutdown.signal.aborted) return false;
    recordInvoiceObservation(this.#options.database, row, observation, this.#now(), row.updated_at);
    return true;
  }
}
