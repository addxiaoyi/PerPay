import { describe, expect, it, vi } from "vitest";
import { createMerchantSessionFetch } from "../src/api/merchant-session";

const path = "/pay/api/merchant/epay/access";
const read = { credentials: "same-origin", cache: "no-store" } as const;

describe("main-site session renewal", () => {
  it("renews once and retries a rejected merchant read with the same credentials", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response()).mockResolvedValueOnce(new Response("accepted"));
    expect(await (await createMerchantSessionFetch(send)(path, read)).text()).toBe("accepted");
    expect(send.mock.calls[1]).toEqual(["/auth/session/refresh", expect.objectContaining({
      method: "POST", credentials: "same-origin", redirect: "error", headers: { rid: "session", "st-auth-mode": "cookie" },
    })]);
    expect(send.mock.calls[2]).toEqual([path, read]);
  });

  it("shares renewal across concurrent expired requests", async () => {
    let renewed = false;
    const send = vi.fn<typeof fetch>(async url => {
      if (url === "/auth/session/refresh") { renewed = true; return new Response(); }
      return new Response(null, { status: renewed ? 200 : 401 });
    });
    const request = createMerchantSessionFetch(send);
    const responses = await Promise.all([request(path, read), request(path, read), request(path, read)]);
    expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
    expect(send.mock.calls.filter(([url]) => url === "/auth/session/refresh")).toHaveLength(1);
  });

  it.each([401, 500])("does not loop after refresh failure %s", async status => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status }));
    expect((await createMerchantSessionFetch(send)(path, read)).status).toBe(401);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not replay an adjustment or fee mutation", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    await createMerchantSessionFetch(send)(path, { ...read, method: "POST", body: "{}" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("permits the exact local collection endpoint without replaying order creation", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    const request = createMerchantSessionFetch(send);
    const url = "/pay/api/merchant/orders?merchantId=main-1";
    expect((await request(url, { ...read, method: "POST", body: "{}" })).status).toBe(401);
    expect(send).toHaveBeenCalledTimes(1);
    for (const path of ["/pay/api/merchant/orders/../admin", "/pay/api/merchant/orders-other", "/pay/api/merchant/orders%2fadmin"]) await expect(request(path, read)).rejects.toThrow("local merchant API");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("stops after one rejected retry", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response()).mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect((await createMerchantSessionFetch(send)(path, read)).status).toBe(401);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("propagates refresh transport errors", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockRejectedValueOnce(new Error("refresh transport failed"));
    await expect(createMerchantSessionFetch(send)(path, read)).rejects.toThrow("refresh transport failed");
  });

  it("does not retry a read cancelled during shared renewal", async () => {
    const abort = new AbortController();
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockImplementationOnce(async () => { abort.abort(); return new Response(); });
    await expect(createMerchantSessionFetch(send)(path, { ...read, signal: abort.signal })).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("rejects cross-origin and unscoped requests", async () => {
    const send = vi.fn<typeof fetch>();
    for (const url of ["https://example.com/api/merchant/epay/access", "//example.com", "/api/user/me", "/pay/api/merchant/epay/\\evil"]) {
      await expect(createMerchantSessionFetch(send)(url, read)).rejects.toThrow("local merchant API");
    }
    expect(send).not.toHaveBeenCalled();
  });
});
