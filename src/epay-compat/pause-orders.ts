import type { AppDatabase } from "../database/database.ts";
import { appendAuditEvent } from "../database/identity-store.ts";

type PauseAudit = { readonly actorId: string; readonly reason: string };

// A rollback changes admission only. New receipts, balances and queued callbacks stay in this database.
export function pauseEPayOrders(database: Pick<AppDatabase, "write">, audit: PauseAudit, now = Date.now()) {
  const validText = (value: string, limit: number) => typeof value === "string" && value.length > 0 && value.length <= limit && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
  if (!validText(audit.actorId, 128) || !validText(audit.reason, 512) || !Number.isSafeInteger(now) || now < 0) throw new Error("invalid EPay admission pause");
  return database.write(sql => {
    if (!sql.isTransaction) throw new Error("EPay admission pause requires a transaction");
    sql.exec("SAVEPOINT epay_pause_orders");
    try {
      const sites = sql.prepare(`SELECT b.client_id,s.configuration,s.revision,s.deleted_at,s.updated_at
        FROM epay_site_bindings b LEFT JOIN sites s ON s.client_id=b.client_id ORDER BY b.client_id`).all();
      if (!sites.length) throw new Error("EPay admission pause has no bound sites");
      let pausedSites = 0, alreadyPausedSites = 0;
      for (const site of sites) {
        if (site.deleted_at !== null || typeof site.configuration !== "string" || !Number.isSafeInteger(Number(site.revision)) || Number(site.revision) < 0 || now < Number(site.updated_at)) throw new Error("EPay admission site is invalid");
        const configuration: unknown = JSON.parse(site.configuration);
        if (!configuration || typeof configuration !== "object" || Array.isArray(configuration) || typeof (configuration as Record<string, unknown>).accepting_orders !== "boolean") throw new Error("EPay admission configuration is invalid");
        const fields = configuration as Record<string, unknown>;
        if (!fields.accepting_orders) { alreadyPausedSites++; continue; }
        const changed = sql.prepare("UPDATE sites SET configuration=?,revision=revision+1,updated_at=? WHERE client_id=? AND revision=? AND deleted_at IS NULL")
          .run(JSON.stringify({ ...fields, accepting_orders: false }), now, String(site.client_id), site.revision!);
        if (Number(changed.changes) !== 1) throw new Error("EPay admission site changed during pause");
        appendAuditEvent(sql, { occurredAt: now, actorType: "ADMIN", actorId: audit.actorId, action: "epay.orders.paused", outcome: "SUCCESS", subjectType: "website", subjectId: String(site.client_id), details: { reason: audit.reason, revision: Number(site.revision) + 1 } });
        pausedSites++;
      }
      sql.exec("RELEASE SAVEPOINT epay_pause_orders");
      return { pausedSites, alreadyPausedSites };
    } catch (error) {
      sql.exec("ROLLBACK TO SAVEPOINT epay_pause_orders; RELEASE SAVEPOINT epay_pause_orders");
      throw error;
    }
  });
}
