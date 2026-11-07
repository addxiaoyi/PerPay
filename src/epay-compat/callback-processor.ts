import type { AppDatabase } from "../database/database.ts";
import { NodeWebhookTransport, WebhookTransportError, type WebhookTransport } from "../notifications/transport.ts";
import { deliverEPayPaidNotification, type EPayPaidNotification } from "./notification.ts";
import { EPayCallbackOutbox } from "./outbox.ts";
import { readConfirmedOrder, type ConfirmedOrder } from "./confirmed-order.ts";
import { deliverMainCallback, type MainCallback } from "./main-callback.ts";

class CallbackSecretReadError extends Error {}
class CallbackOrderReadError extends Error {}

export class EPayCallbackProcessor {
  readonly #database: Pick<AppDatabase, "read">;
  readonly #queue: EPayCallbackOutbox;
  readonly #secret: (merchantId: number, tradeNo?: string) => string;
  readonly #transport: (origin: string) => WebhookTransport;
  readonly #clock: () => number;
  readonly #mainCallback: ((order: ConfirmedOrder) => MainCallback | null) | undefined;

  constructor(options: { database: Pick<AppDatabase, "read" | "write">; secret: (merchantId: number, tradeNo?: string) => string; mainCallback?: (order: ConfirmedOrder) => MainCallback | null; transport?: (origin: string) => WebhookTransport; clock?: () => number }) {
    this.#database = options.database;
    this.#queue = new EPayCallbackOutbox(options.database);
    this.#secret = options.secret;
    this.#transport = options.transport ?? ((origin) => new NodeWebhookTransport(origin));
    this.#clock = options.clock ?? Date.now;
    this.#mainCallback = options.mainCallback;
  }

  async processOne(options: { timeoutMilliseconds: number; leaseMilliseconds: number; maximumAttempts: number; retryDelayMilliseconds: number; signal?: AbortSignal }): Promise<boolean> {
    if (!Number.isSafeInteger(options.timeoutMilliseconds) || options.timeoutMilliseconds < 1 || options.timeoutMilliseconds > 30_000 || !Number.isSafeInteger(options.leaseMilliseconds) || options.leaseMilliseconds < options.timeoutMilliseconds + 1_000 || !Number.isSafeInteger(options.retryDelayMilliseconds) || options.retryDelayMilliseconds < 1 || !Number.isSafeInteger(options.maximumAttempts) || options.maximumAttempts < 1 || options.maximumAttempts > 100) throw new Error("invalid callback timing policy");
    if (options.signal?.aborted) return false;
    const claim = this.#queue.claim(this.#clock(), options.leaseMilliseconds, options.maximumAttempts);
    if (!claim) return false;
    let acknowledged = false;
    let retryable = false;
    let httpStatus: number | undefined;
    let errorCode: string | undefined;
    try {
      let row: ConfirmedOrder | undefined;
      try {
        row = this.#database.read((db) => readConfirmedOrder(db, claim.tradeNo, claim.merchantId));
      } catch (cause) {
        throw new CallbackOrderReadError("callback order could not be read", { cause });
      }
      if (!row) throw new Error("paid order is no longer eligible for callback");
      let main: MainCallback | null | undefined;
      try {
        main = this.#mainCallback?.(row);
        if (!main && this.#database.read(db => db.prepare("SELECT 1 FROM epay_main_native_orders WHERE trade_no=?").get(row!.trade_no))) throw new Error("main callback resolver is unavailable");
      } catch (cause) { throw new CallbackSecretReadError("main callback contract could not be read", { cause }); }
      if (main) {
        const delivery = await deliverMainCallback({ callback: main, transport: this.#transport(new URL(row.notify_url).origin), phase: claim.method, now: this.#clock(), timeoutMilliseconds: options.timeoutMilliseconds, signal: options.signal });
        acknowledged = delivery.acknowledged;
        httpStatus = delivery.status;
        retryable = !acknowledged;
        if (!acknowledged) errorCode = "invalid_acknowledgement";
      } else {
        const merchantId = Number(row.merchant_id);
        const order: EPayPaidNotification = { tradeNo: row.trade_no, merchantOrderNo: row.out_trade_no, merchantId, type: row.type_code ?? "", name: row.name, amountCents: Number(row.money_cents), receivedAmountCents: Number(row.real_money_cents), paymentStatus: "CONFIRMED", param: row.param ?? "" };
        const target = new URL(row.notify_url);
        let signingKey: string;
        try {
          signingKey = this.#secret(merchantId, row.trade_no);
          if (!signingKey) throw new Error("merchant callback signing key is unavailable");
        } catch (cause) {
          throw new CallbackSecretReadError("merchant callback signing key could not be read", { cause });
        }
        const result = await deliverEPayPaidNotification({ order, signingKey, targetUrl: row.notify_url, transport: this.#transport(target.origin), method: claim.method, timeoutMilliseconds: options.timeoutMilliseconds, signal: options.signal });
        acknowledged = result.acknowledged;
        httpStatus = result.status;
        retryable = !acknowledged;
        if (!acknowledged) errorCode = "invalid_acknowledgement";
      }
    } catch (error) {
      retryable = error instanceof CallbackOrderReadError || error instanceof CallbackSecretReadError || (error instanceof WebhookTransportError && error.retryable);
      errorCode = error instanceof CallbackOrderReadError ? "callback_order_read_failed" : error instanceof CallbackSecretReadError ? "callback_secret_read_failed" : error instanceof WebhookTransportError ? error.code : "callback_configuration_invalid";
    }
    this.#queue.complete({ ...claim, now: this.#clock(), acknowledged, retryable, ...(httpStatus === undefined ? {} : { httpStatus }), ...(errorCode === undefined ? {} : { errorCode }), retryDelayMilliseconds: options.retryDelayMilliseconds, maximumAttempts: options.maximumAttempts });
    return true;
  }
}
