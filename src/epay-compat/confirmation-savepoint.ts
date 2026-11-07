import type { DatabaseSync } from "node:sqlite";

export function withConfirmationSavepoint<T>(db: DatabaseSync, operation: () => T): T {
  if (!db.isTransaction) throw new Error("payment confirmation requires a database transaction");
  db.exec("SAVEPOINT epay_payment_confirmation");
  try {
    const value = operation();
    db.exec("RELEASE SAVEPOINT epay_payment_confirmation");
    return value;
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT epay_payment_confirmation");
    db.exec("RELEASE SAVEPOINT epay_payment_confirmation");
    throw error;
  }
}
