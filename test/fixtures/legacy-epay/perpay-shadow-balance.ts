export class ShadowBalanceError extends Error {
  readonly status: number;
  constructor(status: number) { super("Shadow balance unavailable"); this.status = status; }
}

export async function readShadowBalance(input: { origin: string; cookie: string; merchantId: string; fetch?: typeof fetch }) {
  let origin: URL;
  try { origin = new URL(input.origin); } catch { throw new ShadowBalanceError(503); }
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new ShadowBalanceError(503);
  if (!input.cookie || input.cookie.length > 8192 || /[\r\n]/.test(input.cookie)) throw new ShadowBalanceError(401);
  if (!input.merchantId || input.merchantId.trim() !== input.merchantId || input.merchantId.length > 128) throw new ShadowBalanceError(400);
  const url = new URL("/api/merchant/epay/shadow-ledger-balance", origin);
  url.searchParams.set("merchantId", input.merchantId);
  let response: Response;
  try { response = await (input.fetch ?? fetch)(url, { headers: { accept: "application/json", cookie: input.cookie }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000) }); }
  catch { throw new ShadowBalanceError(503); }
  if (response.status === 401 || response.status === 404) throw new ShadowBalanceError(response.status);
  if (!response.ok || !(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json") || !response.body) throw new ShadowBalanceError(503);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) throw new Error("response too large");
      chunks.push(part.value);
    }
  } catch { throw new ShadowBalanceError(503); }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ShadowBalanceError(503); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ShadowBalanceError(503);
  const root = body as Record<string, unknown>;
  if (root.ok !== true || !root.data || typeof root.data !== "object" || Array.isArray(root.data)) throw new ShadowBalanceError(503);
  const data = root.data as Record<string, unknown>;
  if (data.merchantId !== input.merchantId || data.scope !== "shadow_ledger_projection" || data.financiallyReconciled !== false || !Number.isSafeInteger(data.availableCents) || !Number.isSafeInteger(data.frozenCents)) throw new ShadowBalanceError(503);
  return { merchantId: input.merchantId, availableCents: data.availableCents as number, frozenCents: data.frozenCents as number, scope: "shadow_ledger_projection" as const, financiallyReconciled: false as const };
}
