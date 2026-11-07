import { createHash } from "node:crypto";

type Inspector = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
type Script = { readonly scriptId: string; readonly url: string };

// Script metadata must come from the same inspector session after Debugger.enable.
export async function verifyLoadedLiveStateSource(send: Inspector, scripts: readonly Script[], expectedUrl: string, expectedSha256: string): Promise<string> {
  if (!expectedUrl.startsWith("file://") || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("invalid expected debugger source");
  const matches = scripts.filter(script => script.url === expectedUrl);
  const script = matches[0];
  if (matches.length !== 1 || !script || !/^\d+$/.test(script.scriptId)) throw new Error("debugger source identity is ambiguous or missing");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      send("Debugger.getScriptSource", { scriptId: script.scriptId }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("debugger source verification timed out")), 5000); }),
    ]) as { scriptSource?: unknown };
    if (typeof response?.scriptSource !== "string" || Buffer.byteLength(response.scriptSource, "utf8") > 4 * 1024 * 1024) throw new Error("invalid debugger source");
    if (createHash("sha256").update(response.scriptSource, "utf8").digest("hex") !== expectedSha256) throw new Error("loaded debugger source does not match expected digest");
    return script.scriptId;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
