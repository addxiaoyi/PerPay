type Inspector = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

const MAX_STATE_BYTES = 128 * 1024 * 1024;
const CAPTURE_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 2_000;

async function bounded(send: Inspector, method: string, params: Record<string, unknown> | undefined, timeout: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => send(method, params)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeout); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// A timeout cannot cancel an inspector command; the caller must close the connection on failure.
export async function capturePausedStore(send: Inspector, frameId: string, breakpointId: string, options: { captureTimeoutMs?: number; cleanupTimeoutMs?: number } = {}): Promise<Buffer> {
  let value: string | undefined;
  let captureError: unknown;
  let captureFailed = false;
  const cleanupErrors: unknown[] = [];
  const requestedCleanup = options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS;
  const cleanupTimeout = Number.isSafeInteger(requestedCleanup) && requestedCleanup >= 10 && requestedCleanup <= 120_000 ? requestedCleanup : CLEANUP_TIMEOUT_MS;
  try {
    if (!frameId || !breakpointId) throw new Error("missing inspector pause identity");
    const captureTimeout = options.captureTimeoutMs ?? CAPTURE_TIMEOUT_MS;
    if (!Number.isSafeInteger(captureTimeout) || captureTimeout < 10 || captureTimeout > 120_000 || cleanupTimeout !== requestedCleanup) throw new Error("invalid inspector timeout");
    const response = await bounded(send, "Debugger.evaluateOnCallFrame", {
      callFrameId: frameId,
      expression: "JSON.stringify(store)",
      returnByValue: true,
      throwOnSideEffect: true,
    }, captureTimeout) as { exceptionDetails?: unknown; result?: { value?: unknown } };
    if (response?.exceptionDetails || typeof response?.result?.value !== "string") throw new Error("live store serialization failed");
    value = response.result.value;
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes === 0 || bytes > MAX_STATE_BYTES) throw new Error("live store snapshot size invalid");
  } catch (error) {
    captureFailed = true;
    captureError = error;
  } finally {
    if (breakpointId) {
      try { await bounded(send, "Debugger.removeBreakpoint", { breakpointId }, cleanupTimeout); } catch (error) { cleanupErrors.push(error); }
    }
    try { await bounded(send, "Debugger.resume", undefined, cleanupTimeout); } catch (error) { cleanupErrors.push(error); }
  }
  if (captureFailed || cleanupErrors.length) throw new AggregateError([...(captureFailed ? [captureError] : []), ...cleanupErrors], "live store capture or inspector cleanup failed");
  return Buffer.from(value!, "utf8");
}
