import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { auditLightpayOrders } from "../dist/epay-compat/lightpay-audit.js";

const [databasePath, storePath] = process.argv.slice(2);
if (!databasePath || !storePath) throw new Error("expected LightPay database and main-site store paths");
const main = JSON.parse(readFileSync(storePath, "utf8"));
if (!Array.isArray(main.payment?.merchants) || !Array.isArray(main.payment?.orders)) throw new Error("main-site merchants or orders are missing");
const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const bridgeOrders = db.prepare("SELECT id, merchant_id AS merchantId, amount FROM orders").all();
  const audit = auditLightpayOrders(main.payment.merchants, main.payment.orders, bridgeOrders);
  console.log(JSON.stringify({ source: "lightpay_and_main_readonly", samePointInTime: false, ...audit }));
} finally {
  db.close();
}
