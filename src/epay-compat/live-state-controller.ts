import { archivePausedSession, preflightLiveStateCapture } from "./live-state-session.ts";
import { verifyLiveStateProcess, type LiveStateProcessIdentity } from "./live-state-process.ts";
import { verifyLoadedLiveStateSource } from "./live-state-source.ts";

type Inspector = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
type Pause = { hitBreakpoints?: string[]; callFrames?: Array<{ callFrameId?: string; location?: { scriptId?: string } }> };
export interface LiveStateInspector {
  readonly send: Inspector;
  readonly scripts: () => readonly { scriptId: string; url: string }[];
  readonly waitForPause: () => Promise<Pause>;
  readonly close: () => Promise<void>;
}

async function bounded<T>(operation: () => Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("inspector operation timed out")), milliseconds); })]);
  } finally { if (timer) clearTimeout(timer); }
}

// The connector must authenticate and isolate the inspector endpoint and bound its own connection time.
export async function archiveVerifiedInspector(options: {
  readonly target: LiveStateProcessIdentity;
  readonly connect: () => Promise<LiveStateInspector>;
  readonly sourceUrl: string;
  readonly sourceSha256: string;
  readonly lineNumber: number;
  readonly recipientPem: string;
  readonly recipientFingerprint: string;
  readonly snapshotId: string;
  readonly archivePath: string;
  readonly pauseTimeoutMs?: number;
}): Promise<{ sha256: string; bytes: number }> {
  preflightLiveStateCapture(options);
  if (!Number.isSafeInteger(options.lineNumber) || options.lineNumber < 0 || !Number.isSafeInteger(options.pauseTimeoutMs ?? 5000) || (options.pauseTimeoutMs ?? 5000) < 10 || (options.pauseTimeoutMs ?? 5000) > 30000) throw new Error("invalid inspector capture options");
  verifyLiveStateProcess(options.target);
  const inspector = await options.connect();
  let breakpointId: string | undefined;
  let pause: Pause | undefined;
  let transferred = false;
  let failure: unknown;
  try {
    verifyLiveStateProcess(options.target);
    await bounded(() => inspector.send("Debugger.enable"), 5000);
    const scriptId = await verifyLoadedLiveStateSource(inspector.send, inspector.scripts(), options.sourceUrl, options.sourceSha256);
    const response = await bounded(() => inspector.send("Debugger.setBreakpointByUrl", { url: options.sourceUrl, lineNumber: options.lineNumber }), 5000) as { breakpointId?: unknown; locations?: Array<{ scriptId?: string; lineNumber?: number }> };
    if (typeof response?.breakpointId !== "string" || !response.breakpointId) throw new Error("invalid inspector breakpoint");
    breakpointId = response.breakpointId;
    if (!Array.isArray(response.locations) || response.locations.length !== 1 || response.locations[0]?.scriptId !== scriptId || response.locations[0]?.lineNumber !== options.lineNumber) throw new Error("inspector breakpoint location mismatch");
    pause = await bounded(() => inspector.waitForPause(), options.pauseTimeoutMs ?? 5000);
    const frame = pause.callFrames?.[0];
    if (!Array.isArray(pause.hitBreakpoints) || pause.hitBreakpoints.length !== 1 || pause.hitBreakpoints[0] !== breakpointId || frame?.location?.scriptId !== scriptId || !frame.callFrameId) throw new Error("inspector pause identity mismatch");
    verifyLiveStateProcess(options.target);
    transferred = true;
    return await archivePausedSession({ ...options, send: inspector.send, close: inspector.close, frameId: frame.callFrameId, breakpointId });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (!transferred) {
      const errors: unknown[] = [];
      if (breakpointId) {
        try { await bounded(() => inspector.send("Debugger.removeBreakpoint", { breakpointId }), 2000); } catch (error) { errors.push(error); }
      }
      if (pause) {
        try { await bounded(() => inspector.send("Debugger.resume"), 2000); } catch (error) { errors.push(error); }
      }
      try { await bounded(inspector.close, 2000); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError([failure, ...errors], "inspector capture cleanup failed");
    }
  }
}
