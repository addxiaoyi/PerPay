import type { AppDatabase } from "../database/database.ts";
import { Hono } from "hono";
import { EPayCallbackProcessor } from "./callback-processor.ts";
import { EPayCallbackScheduler } from "./callback-scheduler.ts";
import { createIsolatedGateway } from "./isolated-gateway.ts";
import { createMerchantSecretReader } from "./merchant-secret.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { readMainCallback } from "./main-callback.ts";

type ProcessorOptions = ConstructorParameters<typeof EPayCallbackProcessor>[0];
type SchedulerOptions = ConstructorParameters<typeof EPayCallbackScheduler>[0];

// Explicit transport is required; the caller owns the isolated HTTP listener.
export function createIsolatedGatewayRuntime(options: {
  gateway: Parameters<typeof createIsolatedGateway>[0];
  database: Pick<AppDatabase, "read" | "write" | "instanceId">;
  masterKey: Uint8Array;
  transport: NonNullable<ProcessorOptions["transport"]>;
  clock?: () => number;
  admitOrder?: () => boolean;
  mainOrders?: Hono;
  scheduler: Omit<SchedulerOptions, "processor">;
}) {
  if (typeof options.transport !== "function") throw new Error("isolated callback transport is required");
  const gateway = createIsolatedGateway(options.gateway);
  const app = new Hono();
  let acceptingRequests = true;
  let acceptingOrders = true;
  let activeRequests = 0;
  let activeOrders = 0;
  let requestsDrained: (() => void) | undefined;
  let drained: (() => void) | undefined;
  let quiescing: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  app.use("*", async (context, next) => {
    const isOrder = ((context.req.path === "/mapi.php" || context.req.path === "/submit.php") && (context.req.method === "GET" || context.req.method === "POST")) || (context.req.path === "/main/orders" && context.req.method === "POST");
    if (!acceptingRequests || (isOrder && (!acceptingOrders || (options.admitOrder && !options.admitOrder())))) {
      context.header("Cache-Control", "no-store");
      return context.json({ code: -1, msg: "payment temporarily unavailable", isolated: true }, 503);
    }
    activeRequests++;
    if (isOrder) activeOrders++;
    try { await next(); }
    finally {
      activeRequests--;
      if (activeRequests === 0) requestsDrained?.();
      if (isOrder) {
        activeOrders--;
        if (activeOrders === 0) drained?.();
      }
    }
  });
  app.route("/", gateway);
  if (options.mainOrders) app.route("/main", options.mainOrders);
  const processor = new EPayCallbackProcessor({
    database: options.database,
    mainCallback: order => options.database.read(sql => readMainCallback(sql, new RuntimeSecretCipher(options.masterKey, options.database.instanceId()), order)),
    secret: createMerchantSecretReader(options.database, options.masterKey),
    transport: options.transport,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const scheduler = new EPayCallbackScheduler({ ...options.scheduler, processor });
  function quiesceOrders(): Promise<void> {
    if (quiescing) return quiescing;
    acceptingOrders = false;
    quiescing = activeOrders === 0 ? Promise.resolve() : new Promise<void>(resolve => { drained = resolve; });
    return quiescing;
  }
  function stop(): Promise<void> {
      if (stopping) return stopping;
      const ordersDrained = quiesceOrders();
      stopping = Promise.allSettled([ordersDrained, scheduler.stop({ drain: true })]).then(results => {
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map(failure => failure.reason), "gateway shutdown failed");
      });
      return stopping;
  }
  function close(): Promise<void> {
    if (closing) return closing;
    acceptingRequests = false;
    const requests = activeRequests === 0 ? Promise.resolve() : new Promise<void>(resolve => { requestsDrained = resolve; });
    closing = Promise.allSettled([requests, stop()]).then(results => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(failure => failure.reason), "gateway close failed");
    });
    return closing;
  }
  return {
    app,
    start: () => scheduler.start(),
    quiesceOrders,
    stop,
    close,
    health: () => scheduler.health(),
    admission: () => ({ acceptingRequests, acceptingOrders }),
  };
}
