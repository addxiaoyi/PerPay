import { Hono } from "hono";
import { z, ZodError } from "zod";
import type { AppDatabase } from "../database/database.ts";
import { authenticateMainOrder, readBoundedBody } from "../epay-compat/main-order-auth.ts";
import { MerchantAccessError } from "../epay-compat/merchant-access.ts";
import { parseStrictJson } from "../http/strict-json.ts";
import { InvoiceError, invoiceRequestInput, type InvoiceAccess, type InvoiceProvider } from "./model.ts";
import { createInvoiceService } from "./service.ts";

const MAX_BODY_BYTES = 8192;
const MAX_CLOCK_SKEW_SECONDS = 300;
const merchantId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const createCommand = z.object({ operation: z.literal("starpay.invoice.create.v1"), merchantId, application: invoiceRequestInput }).strict();
const queryCommand = z.object({ operation: z.literal("starpay.invoice.query.v1"), merchantId, invoiceId: z.uuid() }).strict();
const filesCommand = z.object({ operation: z.literal("starpay.invoice.files.v1"), merchantId, invoiceId: z.uuid() }).strict();

export type InvoiceAutomationOptions = {
  database: Pick<AppDatabase, "read" | "write" | "instanceId">;
  masterKey: Uint8Array;
  identityOrigin: string;
  publicOrigin: string;
  bridgeSecret?: string | undefined;
  send?: typeof fetch;
  clock?: () => number;
  enabled: boolean | (() => boolean);
  provider?: InvoiceProvider | undefined;
  onError?: (code: string) => void;
};

const unconfigured = async (): Promise<never> => { throw new InvoiceError("invoice_unconfigured", 503, "invoice provider is not configured"); };
const unavailableProvider: InvoiceProvider = { authorize: unconfigured, issue: unconfigured, query: unconfigured, download: unconfigured, invite: unconfigured };

export function createInvoiceAutomationRoutes(options: InvoiceAutomationOptions) {
  const app = new Hono(), clock = options.clock ?? Date.now;
  const enabled = () => options.provider?.issuanceEnabled !== false && (typeof options.enabled === "function" ? options.enabled() : options.enabled);
  const service = createInvoiceService({ database: options.database, provider: options.provider ?? unavailableProvider, clock, canIssue: enabled });

  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
    await next();
  });
  app.onError((error, context) => {
    if (error instanceof MerchantAccessError) return context.json({ ok: false, code: error.code, error: "请检查商户接口签名和商户权限。" },
      error.code === "unauthenticated" ? 401 : error.code === "unavailable" ? 503 : 403);
    if (error instanceof ZodError) return context.json({ ok: false, code: "invoice_invalid", error: "请检查开票操作、订单和购方资料。" }, 400);
    if (error instanceof InvoiceError) return context.json({ ok: false, code: error.code, error: "开票操作未完成，请核对配置和原申请状态。" }, error.status);
    if (options.onError) options.onError("invoice_automation_failed");
    else console.error("invoice automation failed", { errorType: error.name });
    return context.json({ ok: false, code: "invoice_unavailable", error: "开票服务暂不可用，请查询原申请。" }, 503);
  });

  async function authenticate<T extends { merchantId: string }>(request: Request, schema: z.ZodType<T>): Promise<{ access: InvoiceAccess; command: T }> {
    if (!enabled()) throw new InvoiceError("invoice_disabled", 503, "invoice automation is disabled");
    if (!options.provider) throw new InvoiceError("invoice_unconfigured", 503, "invoice provider is not configured");
    if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? ""))
      throw new InvoiceError("invoice_invalid", 400, "expected JSON");
    let raw: string, input: unknown;
    try {
      const bytes = await readBoundedBody(request.body, MAX_BODY_BYTES);
      raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      input = parseStrictJson(bytes);
    } catch { throw new InvoiceError("invoice_invalid", 400, "invalid invoice automation body"); }
    const command = schema.parse(input);
    const timestamp = request.headers.get("x-lightpay-timestamp") ?? "";
    const apiId = request.headers.get("x-lightpay-api-id") ?? "";
    const signature = request.headers.get("x-lightpay-signature") ?? "";
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid invoice automation clock");
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(apiId) || !/^\d{10,11}$/.test(timestamp) || !/^sha256=[a-f0-9]{64}$/.test(signature)
        || Math.abs(Math.floor(now / 1000) - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS)
      throw new MerchantAccessError("unauthenticated");
    // A signed purpose and merchant prevent a valid payment signature from authorizing invoicing.
    const identity = await authenticateMainOrder(options, request, raw);
    if (identity.merchantId !== command.merchantId) throw new MerchantAccessError("forbidden");
    if (!enabled()) throw new InvoiceError("invoice_disabled", 503, "invoice automation was disabled during authentication");
    return { command, access: { merchantId: identity.merchantId, mainApiId: identity.apiId, epayMerchantId: identity.epayMerchantId,
      role: "owner", userId: `api:${identity.apiId}` } };
  }

  app.post("/applications", async context => {
    const { access, command } = await authenticate(context.req.raw, createCommand);
    const invoice = await service.createAndIssue(access, command.application);
    return context.json({ ok: true, data: { merchantId: access.merchantId, invoice } }, ["UNKNOWN", "PROCESSING"].includes(invoice.status) ? 202 : 200);
  });
  app.post("/query", async context => {
    const { access, command } = await authenticate(context.req.raw, queryCommand);
    return context.json({ ok: true, data: { merchantId: access.merchantId, invoice: service.read(access, command.invoiceId) } });
  });
  app.post("/files", async context => {
    const { access, command } = await authenticate(context.req.raw, filesCommand);
    return context.json({ ok: true, data: { merchantId: access.merchantId, url: await service.download(access, command.invoiceId) } });
  });
  return app;
}
