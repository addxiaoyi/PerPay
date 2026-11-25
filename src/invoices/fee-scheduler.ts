import type { FeeInvoiceService } from "./fee-service.ts";
import { InvoiceError } from "./model.ts";
import { providerQueueFailure } from "./fee-queue.ts";

const INTERVAL_MS = 60_000;
export class FeeInvoiceScheduler {
  #timer: NodeJS.Timeout | undefined;
  #current: Promise<number> | undefined;
  #stopped = false;
  #lastRunAt: number | null = null;
  #lastError: string | null = null;
  #failures = 0;
  readonly #service: FeeInvoiceService;
  readonly #onError: (code: string) => void;
  constructor(service: FeeInvoiceService, onError: (code: string) => void) { this.#service = service; this.#onError = onError; }
  start() {
    if (this.#stopped) throw new Error("fee invoice scheduler is stopped");
    if (!this.#timer) {
      this.#timer = setInterval(() => { void this.trigger().catch(() => {
        if (!this.#stopped && !this.#lastError) this.#failed("fee_invoice_timer_failed");
      }); }, INTERVAL_MS);
      this.#timer.unref();
    }
    return this.trigger();
  }
  trigger(): Promise<number> {
    if (this.#stopped) return Promise.reject(new Error("fee invoice scheduler is stopped"));
    if (!this.#current) this.#current = Promise.resolve().then(() => this.#service.automationReady() ? this.#run() : 0)
      .catch(error => { this.#failed("fee_invoice_batch_failed"); throw error; })
      .finally(() => { this.#current = undefined; this.#lastRunAt = Date.now(); });
    return this.#current;
  }
  health() { return { state: this.#stopped ? "stopped" : this.#timer ? "running" : "idle", inFlight: Boolean(this.#current), lastRunAt: this.#lastRunAt, lastErrorCode: this.#lastError, failures: this.#failures }; }
  #failed(code: string) { this.#failures++; this.#lastError = code; this.#onError(code); }
  async #run() {
    let submitted = 0;
    for (const candidate of this.#service.candidates()) {
      if (this.#stopped || !this.#service.automationReady()) break;
      try {
        const invoice = await this.#service.create(candidate.access, candidate.tradeNo, true); submitted++;
        if (invoice.errorCode) {
          this.#failed(invoice.errorCode);
          if (providerQueueFailure(invoice.errorCode)) { this.#service.defer(candidate.tradeNo, invoice.errorCode); break; }
        }
      } catch (error) {
        const code = error instanceof InvoiceError ? error.code : "fee_invoice_submission_failed";
        this.#service.defer(candidate.tradeNo, code); this.#failed(code);
        if (providerQueueFailure(code)) break;
      }
    }
    return submitted;
  }
  async stop() { this.#stopped = true; if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; await this.#current; }
}
