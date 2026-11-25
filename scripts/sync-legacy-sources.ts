import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createConnection } from "mysql2/promise";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AppDatabase } from "../src/database/database.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { mysqlSnapshotConfig } from "../src/epay-compat/mysql-snapshot.ts";
import { readMainMemorySnapshot } from "../src/epay-compat/main-snapshot-client.ts";
import { captureSharedCutoff } from "../src/epay-compat/shared-cutoff.ts";
import { SOURCE_TABLES } from "../src/epay-compat/snapshot.ts";
import { sealSharedCapture } from "../src/epay-compat/source-sync-envelope.ts";
import { SourceSyncDeliveryError, SourceSyncDiagnostics, type SourceSyncStep } from "../src/epay-compat/source-sync-observability.ts";
import { retrySourceSynchronization } from "../src/epay-compat/source-sync-retry.ts";

let phase = "arguments";
let diagnostics = new SourceSyncDiagnostics();
const startupMilliseconds = Math.round(process.uptime() * 1000);
type SyncReport = ReturnType<typeof import("../src/epay-compat/shared-delta.ts").applySharedPaymentDelta>;

function queryStep(sql: string): SourceSyncStep {
  for (const [name, primary] of Object.entries(SOURCE_TABLES)) {
    if (sql === `SELECT * FROM \`${name}\` ORDER BY \`${primary}\``) return `source_${name as keyof typeof SOURCE_TABLES}`;
  }
  if (sql.startsWith("SELECT TABLE_NAME,")) return "source_schema";
  if (sql.startsWith("LOCK TABLES ")) return "source_lock";
  return sql === "UNLOCK TABLES" ? "source_unlock" : "source_session";
}

async function synchronize() {
  diagnostics = new SourceSyncDiagnostics();
  process.umask(0o077);
  const [root, mode] = process.argv.slice(2);
  const running = mode === "--running";
  if (!root || process.argv.length !== (running ? 4 : 3) || (mode && !running) || !/^\/var\/lib\/perpay-candidate-[a-z0-9-]+$/.test(root) || resolve(root) !== root) throw new Error("invalid candidate synchronization root");
  const readSecret = (path: string) => {
    if ((statSync(path).mode & 0o077) !== 0) throw new Error("synchronization secret permissions are unsafe");
    const value = readFileSync(path, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("synchronization secret format is invalid");
    return Buffer.from(value, "hex");
  };
  phase = "read_secrets";
  const [key, secret] = await diagnostics.measure("read_secrets", () => [readSecret(join(root, "secrets/master-key")), readSecret("/etc/helstera/perpay-migration.secret")] as const);
  let database: AppDatabase | undefined, mysql: Awaited<ReturnType<typeof createConnection>> | undefined;
  try {
    phase = "open_candidate";
    const instanceId = await diagnostics.measure("open_candidate", async () => {
      if (running) {
        const reader = new DatabaseSync(join(root, "data/perpay.sqlite3"), { readOnly: true });
        try {
          const value = reader.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get()?.value;
          if (typeof value !== "string" || !value) throw new Error("candidate instance identity is unavailable");
          return value;
        } finally { reader.close(); }
      }
      const { AppDatabase } = await import("../src/database/database.ts");
      database = await AppDatabase.open(join(root, "data/perpay.sqlite3"), { masterKey: key });
      return database.instanceId();
    });
    const cipher = new RuntimeSecretCipher(key, instanceId);
    phase = "locate_legacy_source";
    const readerPath = "/etc/helstera/perpay-snapshot.json";
    const restrictedReader = running && existsSync(readerPath);
    if (restrictedReader) {
      const path = readerPath;
      if ((statSync(path).mode & 0o077) !== 0) throw new Error("source reader permissions are unsafe");
      const config = z.object({ host: z.literal("127.0.0.1"), port: z.number().int().min(1).max(65535), user: z.literal("perpay_snapshot_20261105"), password: z.string().min(32), database: z.string().regex(/^[A-Za-z0-9_]+$/), dateStrings: z.literal(true), supportBigNumbers: z.literal(true), bigNumberStrings: z.literal(true), decimalNumbers: z.literal(false), multipleStatements: z.literal(false), connectTimeout: z.literal(10000) }).strict().parse(JSON.parse(readFileSync(path, "utf8")));
      mysql = await diagnostics.measure("source_connect", () => createConnection(config));
      const [grants] = await diagnostics.measure("source_grants", () => mysql!.query({ sql: "SHOW GRANTS", timeout: 5000 }));
      if (!Array.isArray(grants)) throw new Error("source reader grants are unavailable");
      const statements = (grants as Record<string, unknown>[]).map(row => String(Object.values(row)[0]));
      if (statements.length !== 2 || !statements.some(value => /^GRANT USAGE ON \*\.\* TO /.test(value)) ||
        !statements.some(value => value.startsWith(`GRANT SELECT, LOCK TABLES ON \`${config.database}\`.* TO `))) throw new Error("source reader privileges differ");
    } else {
      const processes = await diagnostics.measure("legacy_process", () => JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 15000 })) as Array<{ name: string; pm2_env?: { status: string; pm_cwd?: string; DATABASE_URL?: string } }>);
      const matches = processes.filter(row => row.name === "epay-next-reconcile-v1" && row.pm2_env?.status === "online" && row.pm2_env.pm_cwd?.startsWith("/www/wwwroot/epay-next-releases/"));
      if (matches.length !== 1 || !matches[0]!.pm2_env?.DATABASE_URL) throw new Error("legacy source process is ambiguous");
      mysql = await diagnostics.measure("source_connect", () => createConnection(mysqlSnapshotConfig(matches[0]!.pm2_env!.DATABASE_URL!)));
    }
    await diagnostics.measure("source_session", () => mysql!.query({ sql: "SET SESSION TRANSACTION READ ONLY", timeout: 5000 }));
    const allowed = new Set([
      "SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()",
      "SET SESSION time_zone = '+00:00'", "SET SESSION lock_wait_timeout = 3", "SET SESSION innodb_lock_wait_timeout = 3", "SET autocommit = 0", "UNLOCK TABLES",
      `LOCK TABLES ${Object.keys(SOURCE_TABLES).map(name => `\`${name}\` READ`).join(", ")}`,
      ...Object.entries(SOURCE_TABLES).map(([name, primary]) => `SELECT * FROM \`${name}\` ORDER BY \`${primary}\``),
    ]);
    phase = "capture_shared_sources";
    const capture = await diagnostics.measure("capture_shared_sources", () => captureSharedCutoff({ query: sql => {
      if (!mysql || !allowed.has(sql)) throw new Error("synchronization SQL is outside the read-only protocol");
      return diagnostics.measure(queryStep(sql), () => mysql!.query({ sql, timeout: 5000 }));
    } }, () => diagnostics.measure("main_snapshot", () => readMainMemorySnapshot({ origin: "http://127.0.0.1:8787", secret }))));
    await diagnostics.measure("close_source", () => mysql!.destroy());
    mysql = undefined;
    phase = "apply_shared_delta";
    let report: SyncReport;
    if (running) {
      const body = await diagnostics.measure("seal_capture", () => JSON.stringify(sealSharedCapture(cipher, capture, Date.now())));
      report = await diagnostics.measure("apply_shared_delta", async () => {
        const response = await fetch("http://127.0.0.1:16191/pay/epay/internal/source-sync", {
          method: "POST", headers: { "content-type": "application/json" }, redirect: "error", cache: "no-store",
          signal: AbortSignal.timeout(20_000), body,
        });
        diagnostics.recordOwnerTiming(response.headers.get("server-timing"));
        const reply = await response.json() as { ok?: boolean; data?: SyncReport; error?: unknown };
        if (!response.ok || reply.ok !== true || !reply.data) throw new SourceSyncDeliveryError(response.status,
          reply.error === "source_delivery_rejected" ? "delivery_rejected" : reply.error === "source_sync_failed" ? "apply_rejected" : "invalid_reply");
        return reply.data;
      });
    } else {
      if (!database) throw new Error("offline candidate is unavailable");
      const { applySharedPaymentDelta } = await import("../src/epay-compat/shared-delta.ts");
      report = await diagnostics.measure("apply_shared_delta", () => applySharedPaymentDelta(database!, cipher, capture, Date.now()));
    }
    console.log(JSON.stringify({ ...report, sourceReadOnly: true, providerRequests: 0, running, restrictedReader,
      startupMilliseconds, ...diagnostics.report() }));
  } catch (error) {
    if (database) {
      const { recordSourceSyncFailure } = await import("../src/epay-compat/shared-delta.ts");
      recordSourceSyncFailure(database, Date.now());
    }
    throw error;
  } finally {
    // A timed-out query must not leave the retry waiting behind queued QUIT or retain source locks.
    try { mysql?.destroy(); }
    finally {
      try { database?.close(); }
      finally { key.fill(0); secret.fill(0); }
    }
  }
}

retrySourceSynchronization({ synchronize, onRetry: (attempt, delayMilliseconds, error) => {
  console.error(JSON.stringify({ ok: false, error: "legacy_source_sync_retry", phase, attempt, delayMilliseconds, startupMilliseconds, ...diagnostics.report(error) }));
} }).catch(error => {
  console.error(JSON.stringify({ ok: false, error: "legacy_source_sync_failed", phase, startupMilliseconds, ...diagnostics.report(error) })); process.exitCode = 1;
});
