import type { AppDatabase } from "../database/database.ts";
import { confirmAlipayInTransaction } from "./confirm-alipay.ts";

// Submission settlement commits with the verified payment, ledger and callback job.
export function confirmIsolatedAlipay(database: Pick<AppDatabase, "write">, params: Readonly<Record<string, string>>, now: number) {
  const tradeNo = params.out_trade_no;
  if (!tradeNo) throw new Error("invalid payment notification");
  return database.write((db) => {
    const submission = db.prepare("SELECT state,started_at FROM epay_alipay_submissions WHERE trade_no=?").get(tradeNo);
    if (!submission || !Number.isSafeInteger(now) || now < Number(submission.started_at)) throw new Error("Alipay submission not confirmable");
    const confirmation = confirmAlipayInTransaction(db, params, now);
    if (confirmation.duplicate) {
      if (submission.state !== "SETTLED") throw new Error("incomplete Alipay submission confirmation");
      return confirmation;
    }
    const changed = db.prepare("UPDATE epay_alipay_submissions SET state='SETTLED',lease_token=NULL,lease_until=NULL,updated_at=? WHERE trade_no=? AND state IN ('IN_FLIGHT','UNCERTAIN')").run(now, tradeNo);
    if (Number(changed.changes) !== 1) throw new Error("Alipay submission changed during confirmation");
    return confirmation;
  });
}
