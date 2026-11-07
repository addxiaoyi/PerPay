import type { EPayCallbackProcessor } from "./callback-processor.ts";

type Processor = Pick<EPayCallbackProcessor, "processOne">;
type Policy = Omit<Parameters<Processor["processOne"]>[0], "signal">;

export class EPayCallbackScheduler {
  readonly #processor: Processor;
  readonly #policy: Policy;
  readonly #interval: number;
  readonly #limit: number;
  readonly #onError: (error: unknown) => void;
  #timer: NodeJS.Timeout | null = null;
  #current: Promise<number> | null = null;
  #abort: AbortController | null = null;
  #stopped = false;
  #lastSuccessAt: number | null = null;
  #lastFailureAt: number | null = null;
  #consecutiveFailures = 0;

  constructor(options: { processor: Processor; policy: Policy; intervalMilliseconds: number; maximumPerRun: number; onError: (error: unknown) => void }) {
    if (!Number.isSafeInteger(options.intervalMilliseconds) || options.intervalMilliseconds < 250 || options.intervalMilliseconds > 3_600_000) throw new RangeError("invalid callback scheduler interval");
    if (!Number.isSafeInteger(options.maximumPerRun) || options.maximumPerRun < 1 || options.maximumPerRun > 1000) throw new RangeError("invalid callback scheduler limit");
    this.#processor = options.processor;
    this.#policy = Object.freeze({ ...options.policy });
    this.#interval = options.intervalMilliseconds;
    this.#limit = options.maximumPerRun;
    this.#onError = options.onError;
  }

  start(): Promise<number> {
    if (this.#stopped) return Promise.reject(new Error("callback scheduler is stopped"));
    if (this.#timer) return this.trigger();
    const timer = setInterval(() => { void this.trigger().catch((error: unknown) => this.#onError(error)); }, this.#interval);
    timer.unref();
    this.#timer = timer;
    return this.trigger().catch((error: unknown) => {
      if (this.#timer === timer) {
        clearInterval(timer);
        this.#timer = null;
      }
      throw error;
    });
  }

  trigger(): Promise<number> {
    if (this.#stopped) return Promise.reject(new Error("callback scheduler is stopped"));
    if (this.#current) return this.#current;
    const controller = new AbortController();
    this.#abort = controller;
    const operation = this.#run(controller.signal).then((processed) => {
      if (!controller.signal.aborted) {
        this.#lastSuccessAt = Date.now();
        this.#consecutiveFailures = 0;
      }
      return processed;
    }, (error: unknown) => {
      this.#lastFailureAt = Date.now();
      this.#consecutiveFailures++;
      throw error;
    }).finally(() => {
      this.#current = null;
      this.#abort = null;
    });
    this.#current = operation;
    return operation;
  }

  health(): { state: "idle" | "running" | "stopped"; inFlight: boolean; lastSuccessAt: number | null; lastFailureAt: number | null; consecutiveFailures: number } {
    return {
      state: this.#stopped ? "stopped" : this.#timer ? "running" : "idle",
      inFlight: this.#current !== null,
      lastSuccessAt: this.#lastSuccessAt,
      lastFailureAt: this.#lastFailureAt,
      consecutiveFailures: this.#consecutiveFailures,
    };
  }

  async stop(options: { drain?: boolean } = {}): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (!options.drain) this.#abort?.abort();
    await this.#current;
  }

  async #run(signal: AbortSignal): Promise<number> {
    let processed = 0;
    while (processed < this.#limit && !signal.aborted && !this.#stopped) {
      if (!await this.#processor.processOne({ ...this.#policy, signal })) break;
      processed++;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return processed;
  }
}
