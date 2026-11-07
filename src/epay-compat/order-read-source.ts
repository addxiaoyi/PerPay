import type { DatabaseSync } from "node:sqlite";

// Restored pre-refund snapshots remain readable during migration comparisons.
export function orderReadSource(db: DatabaseSync): "epay_orders" | "epay_order_states" {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type='view' AND name='epay_order_states'").get() ? "epay_order_states" : "epay_orders";
}
