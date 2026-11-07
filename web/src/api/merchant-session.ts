const REFRESH_TIMEOUT_MS = 10_000;

// Only reads are retried; financial writes always require a fresh user submission.
export function createMerchantSessionFetch(send: typeof fetch) {
  let refreshing: Promise<boolean> | undefined;
  let generation = 0;

  function refresh(): Promise<boolean> {
    refreshing ??= send("/auth/session/refresh", {
      method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { rid: "session", "st-auth-mode": "cookie" },
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    }).then(response => {
      if (response.ok) generation++;
      return response.ok;
    }).finally(() => { refreshing = undefined; });
    return refreshing;
  }

  return async function sessionFetch(path: string, init: RequestInit): Promise<Response> {
    const workspace = /^\/(?:pay\/)?api\/merchant\/epay\//.test(path);
    const collection = /^\/(?:pay\/)?api\/merchant\/orders(?:\?[^#]*)?$/.test(path);
    if ((!workspace && !collection) || path.includes("\\")) {
      throw new Error("merchant session request must use the local merchant API");
    }
    const started = generation;
    const response = await send(path, init);
    if (response.status !== 401 || (init.method ?? "GET").toUpperCase() !== "GET") return response;
    init.signal?.throwIfAborted();
    if (started === generation && !await refresh()) return response;
    init.signal?.throwIfAborted();
    return send(path, init);
  };
}

export const merchantSessionFetch = createMerchantSessionFetch((...args) => fetch(...args));
