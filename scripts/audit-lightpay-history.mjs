import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { auditLightpayHistory } from "../dist/epay-compat/lightpay-history-audit.js";

const [databasePath, currentPath, ...historyPaths] = process.argv.slice(2);
if (!databasePath || !currentPath || historyPaths.length === 0) throw new Error("expected bridge database, current store and historical stores");
function payment(path) {
  const root = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(root.payment?.merchants) || !Array.isArray(root.payment?.orders)) return null;
  return root.payment;
}
const current = payment(currentPath);
if (!current) throw new Error("current store is missing payment merchants or orders");
const history = historyPaths.map(payment).filter((snapshot) => snapshot !== null);
const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const bridge = db.prepare("SELECT id, merchant_id AS merchantId, amount FROM orders").all();
  const audit = auditLightpayHistory(current, history, bridge);
  console.log(JSON.stringify({ source: "lightpay_and_historical_stores", skippedStores: historyPaths.length - history.length, ...audit }));
} finally {
  db.close();
}
