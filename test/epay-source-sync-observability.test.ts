import assert from "node:assert/strict";
import { it } from "node:test";
import { SourceSyncDeliveryError, SourceSyncDiagnostics, sourceSyncFailure } from "../src/epay-compat/source-sync-observability.ts";

it("retains the failing leaf and completed durations when the enclosing capture rejects", async () => {
  let moment = 0;
  const diagnostics = new SourceSyncDiagnostics(() => moment);
  const timeout = new DOMException("provider secret must not appear", "TimeoutError");
  await assert.rejects(diagnostics.measure("capture_shared_sources", async () => {
    await diagnostics.measure("source_Order", () => { moment += 20; });
    await diagnostics.measure("main_snapshot", () => { moment += 5000; throw timeout; });
  }), error => error === timeout);
  const report = diagnostics.report(timeout);
  assert.equal(report.failedStep, "main_snapshot");
  assert.equal(report.reason, "request_timeout");
  assert.deepEqual(report.phaseMilliseconds, { source_Order: 20, main_snapshot: 5000, capture_shared_sources: 5020 });
  assert.equal(report.attemptMilliseconds, 5020);
  assert.equal(JSON.stringify(report).includes("provider secret"), false);
});

it("sums repeated session work without leaking arbitrary error properties or messages", async () => {
  let moment = 0;
  const diagnostics = new SourceSyncDiagnostics(() => moment);
  await diagnostics.measure("source_session", () => { moment += 3; });
  await diagnostics.measure("source_session", () => { moment += 7; });
  const unsafe = Object.assign(new Error("mysql password=private-value"), { code: "SQL private-value", sql: "SELECT private-value" });
  assert.deepEqual(diagnostics.report(unsafe), { attemptMilliseconds: 10, phaseMilliseconds: { source_session: 10 }, reason: "unclassified_failure" });
});

it("classifies transport, database, protocol and lock cleanup failures with fixed safe reasons", () => {
  const cases: Array<[unknown, string]> = [
    [new DOMException("deadline", "AbortError"), "request_timeout"],
    [Object.assign(new Error("private"), { code: "PROTOCOL_SEQUENCE_TIMEOUT" }), "source_query_timeout"],
    [Object.assign(new Error("private"), { code: "SQLITE_BUSY" }), "database_busy"],
    [new TypeError("fetch failed", { cause: Object.assign(new Error("private"), { code: "ECONNREFUSED" }) }), "connection_failure"],
    [new Error("main snapshot signature differs"), "main_snapshot_signature_invalid"],
    [new Error("shared cutoff does not fall within the source lock window"), "source_lock_window"],
    [new AggregateError([new Error("private")], "private"), "source_lock_cleanup_failed"],
    [{ message: "private" }, "unknown_failure"],
  ];
  for (const [failure, reason] of cases) assert.equal(sourceSyncFailure(failure).reason, reason);
  assert.deepEqual(sourceSyncFailure(new SourceSyncDeliveryError(503, "apply_rejected")), { reason: "apply_rejected", httpStatus: 503 });
});

it("records only bounded numeric owner timings and handles old owners without timing headers", () => {
  const diagnostics = new SourceSyncDiagnostics(() => 0);
  for (const header of [null, "private-value", "source-validate;dur=NaN, source-apply;dur=1", "source-validate;dur=1, source-apply;dur=999999999"])
    diagnostics.recordOwnerTiming(header);
  assert.equal("ownerPhaseMilliseconds" in diagnostics.report(), false);
  diagnostics.recordOwnerTiming("source-validate;dur=12.5, source-apply;dur=231");
  assert.deepEqual(diagnostics.report().ownerPhaseMilliseconds, { validation: 12.5, apply: 231 });
});
