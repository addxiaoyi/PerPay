import type { SOURCE_TABLES } from "./snapshot.ts";

export type SourceSyncStep = "read_secrets" | "open_candidate" | "legacy_process" | "source_connect" | "source_grants" |
  "source_session" | "capture_shared_sources" | "source_schema" | "source_lock" | "source_unlock" | "main_snapshot" |
  "seal_capture" | "apply_shared_delta" | "close_source" | `source_${keyof typeof SOURCE_TABLES}`;

const CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "PROTOCOL_CONNECTION_LOST"]);
const TIMEOUT_CODES = new Set(["PROTOCOL_SEQUENCE_TIMEOUT", "ER_LOCK_WAIT_TIMEOUT", "ER_LOCK_DEADLOCK", "SQLITE_BUSY", "SQLITE_LOCKED"]);
const SAFE_REASONS = new Map([
  ["shared cutoff lock deadline exceeded", "source_lock_deadline"],
  ["shared cutoff does not fall within the source lock window", "source_lock_window"],
  ["main snapshot is unavailable", "main_snapshot_unavailable"],
  ["main snapshot signature is missing", "main_snapshot_signature_missing"],
  ["main snapshot signature differs", "main_snapshot_signature_invalid"],
  ["main snapshot identity or time differs", "main_snapshot_identity_or_window"],
  ["source reader privileges differ", "source_reader_privileges"],
  ["synchronization SQL is outside the read-only protocol", "source_protocol_rejected"],
]);

export class SourceSyncDeliveryError extends Error {
  readonly httpStatus: number;
  readonly reason: "delivery_rejected" | "apply_rejected" | "invalid_reply";
  constructor(status: number, reason: SourceSyncDeliveryError["reason"]) {
    super("candidate rejected source synchronization");
    this.name = "SourceSyncDeliveryError";
    this.httpStatus = status;
    this.reason = reason;
  }
}

// Never serialize arbitrary exception text: SQL errors and validation errors can contain source secrets.
export function sourceSyncFailure(error: unknown): { reason: string; httpStatus?: number } {
  if (error instanceof SourceSyncDeliveryError) return { reason: error.reason, httpStatus: error.httpStatus };
  if (!(error instanceof Error)) return { reason: "unknown_failure" };
  if (error.name === "TimeoutError" || error.name === "AbortError") return { reason: "request_timeout" };
  if (error instanceof AggregateError) return { reason: "source_lock_cleanup_failed" };
  const code = "code" in error ? error.code : undefined;
  if (typeof code === "string" && CONNECTION_CODES.has(code)) return { reason: "connection_failure" };
  if (typeof code === "string" && TIMEOUT_CODES.has(code)) return { reason: code.startsWith("SQLITE_") ? "database_busy" : "source_query_timeout" };
  const known = SAFE_REASONS.get(error.message);
  if (known) return { reason: known };
  if (error.cause instanceof Error && "code" in error.cause && typeof error.cause.code === "string" && CONNECTION_CODES.has(error.cause.code)) return { reason: "connection_failure" };
  return { reason: "unclassified_failure" };
}

export class SourceSyncDiagnostics {
  readonly #clock: () => number;
  readonly #startedAt: number;
  readonly #milliseconds: Partial<Record<SourceSyncStep, number>> = {};
  #ownerMilliseconds: { validation: number; apply: number } | undefined;
  #failureStep: SourceSyncStep | undefined;

  constructor(clock = () => performance.now()) {
    this.#clock = clock;
    this.#startedAt = clock();
  }

  async measure<T>(step: SourceSyncStep, operation: () => T | Promise<T>): Promise<T> {
    const startedAt = this.#clock();
    try { return await operation(); }
    catch (error) { this.#failureStep ??= step; throw error; }
    finally { this.#milliseconds[step] = (this.#milliseconds[step] ?? 0) + Math.max(0, this.#clock() - startedAt); }
  }

  recordOwnerTiming(header: string | null): void {
    const validation = /(?:^|,\s*)source-validate;dur=(\d+(?:\.\d+)?)(?:,|$)/.exec(header ?? "");
    const apply = /(?:^|,\s*)source-apply;dur=(\d+(?:\.\d+)?)(?:,|$)/.exec(header ?? "");
    if (!validation || !apply) return;
    const values = { validation: Number(validation[1]), apply: Number(apply[1]) };
    if (Object.values(values).every(value => Number.isFinite(value) && value >= 0 && value <= 300_000)) this.#ownerMilliseconds = values;
  }

  report(error?: unknown) {
    return {
      attemptMilliseconds: Math.round(Math.max(0, this.#clock() - this.#startedAt)),
      phaseMilliseconds: Object.fromEntries(Object.entries(this.#milliseconds).map(([step, value]) => [step, Math.round(value)])),
      ...(this.#ownerMilliseconds ? { ownerPhaseMilliseconds: this.#ownerMilliseconds } : {}),
      ...(this.#failureStep ? { failedStep: this.#failureStep } : {}),
      ...(error === undefined ? {} : sourceSyncFailure(error)),
    };
  }
}
