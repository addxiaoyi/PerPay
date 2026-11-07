import { NodeWebhookTransport, WebhookTransportError } from "../notifications/transport.ts";
import { assertCallbackQueryIsUnambiguous } from "./notification.ts";

type Order = { merchantId: unknown; notifyUrl: unknown; status: unknown };

// This checks syntax and policy only; DNS and merchant acknowledgement require separate verification.
export function auditCallbackTargets(orders: readonly Order[]) {
  let incompatibleOrders = 0;
  let pendingIncompatibleOrders = 0;
  const merchants = new Set<string>();
  for (const order of orders) {
    if (!order || (typeof order.merchantId !== "string" && typeof order.merchantId !== "number") || typeof order.status !== "string" || typeof order.notifyUrl !== "string") {
      throw new Error("invalid callback audit order");
    }
    let compatible = false;
    try {
      const target = new URL(order.notifyUrl);
      new NodeWebhookTransport(target.origin).validateTarget(order.notifyUrl);
      try { assertCallbackQueryIsUnambiguous(target); } catch { throw new TypeError("callback target contains a reserved payment parameter"); }
      compatible = true;
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof WebhookTransportError)) throw error;
    }
    if (!compatible) {
      incompatibleOrders++;
      if (order.status === "PENDING") pendingIncompatibleOrders++;
      merchants.add(String(order.merchantId));
    }
  }
  return { incompatibleOrders, pendingIncompatibleOrders, affectedMerchants: merchants.size, dnsVerified: false, deliveryVerified: false };
}
