import { capturePausedStore } from "./live-state-capture.ts";
import { sealLiveState, validateLiveStateRecipient } from "./live-state-envelope.ts";
import { validateLiveStateArchiveTarget, writeLiveStateArchive } from "./live-state-archive.ts";

type Inspector = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

interface CaptureSession {
  send: Inspector;
  close: () => Promise<void>;
  frameId: string;
  breakpointId: string;
  recipientPem: string;
  recipientFingerprint: string;
  snapshotId: string;
  archivePath: string;
  captureTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

// Run before attaching to the target; publication repeats the checks to handle races.
export function preflightLiveStateCapture(options: Pick<CaptureSession, "recipientPem" | "recipientFingerprint" | "snapshotId" | "archivePath">): void {
  validateLiveStateRecipient(options.recipientPem, options.snapshotId, options.recipientFingerprint);
  validateLiveStateArchiveTarget(options.archivePath);
}

async function closeSession(close: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(close),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("inspector disconnect timed out")), 2000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The caller must verify the process identity and isolate the inspector before attaching.
export async function archivePausedSession(session: CaptureSession): Promise<{ sha256: string; bytes: number }> {
  let plaintext: Buffer | undefined;
  let failure: unknown;
  let closeFailure: unknown;
  let captureFailed = false;
  let closeFailed = false;
  try {
    const options: { captureTimeoutMs?: number; cleanupTimeoutMs?: number } = {};
    if (session.captureTimeoutMs !== undefined) options.captureTimeoutMs = session.captureTimeoutMs;
    if (session.cleanupTimeoutMs !== undefined) options.cleanupTimeoutMs = session.cleanupTimeoutMs;
    plaintext = await capturePausedStore(session.send, session.frameId, session.breakpointId, options);
  } catch (error) {
    captureFailed = true;
    failure = error;
  } finally {
    try { await closeSession(session.close); } catch (error) { closeFailed = true; closeFailure = error; }
  }
  try {
    if (captureFailed || closeFailed) throw new AggregateError([...(captureFailed ? [failure] : []), ...(closeFailed ? [closeFailure] : [])], "live state session failed");
    const envelope = sealLiveState(plaintext!, session.recipientPem, session.snapshotId, session.recipientFingerprint);
    return writeLiveStateArchive(session.archivePath, envelope);
  } finally {
    plaintext?.fill(0);
  }
}
