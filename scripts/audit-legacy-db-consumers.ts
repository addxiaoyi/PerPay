import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "mysql2/promise";
import { mysqlSnapshotConfig } from "../src/epay-compat/mysql-snapshot.ts";

type Process = { name: string; pid: number; pm2_env: { status: string; pm_cwd: string; PORT?: string; DATABASE_URL?: string } };
let phase = "arguments";
async function audit() {
  const destination = process.argv[2];
  if (process.env.EPAY_READONLY_AUDIT !== "1" || !destination || !/^\/root\/perpay-recovery-\d{8}-rc\d+\/[a-z0-9-]+\.json$/.test(destination)) throw new Error("explicit audit destination required");
  process.umask(0o077);
  const processes = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 15000 })) as Process[];
  const consumers = processes.filter(row => row.pm2_env.DATABASE_URL);
  const active = consumers.find(row => row.name === "epay-next-reconcile-v1" && row.pm2_env.status === "online");
  if (!active?.pm2_env.DATABASE_URL) throw new Error("active legacy database consumer unavailable");
  const config = mysqlSnapshotConfig(active.pm2_env.DATABASE_URL);
  phase = "connect";
  const rootPassword = execFileSync("/www/server/panel/pyenv/bin/python3", ["-c", "import sys; sys.path.insert(0,'/www/server/panel/class'); import public; value=public.M('config').where('id=?',(1,)).getField('mysql_root'); assert isinstance(value,str) and value; print(value,end='')"],
    { cwd: "/www/server/panel", encoding: "utf8", timeout: 5000, maxBuffer: 16384 });
  const sql = await createConnection({ ...config, user: "root", password: rootPassword, socketPath: "/tmp/mysql.sock" });
  try {
    phase = "inventory";
    const [accounts] = await sql.query("SELECT User,Host FROM mysql.user WHERE User=?", [config.user]);
    const grants = [];
    for (const account of accounts as Array<{ User: string; Host: string }>) {
      const [rows] = await sql.query("SHOW GRANTS FOR ?@?", [account.User, account.Host]);
      // Older MySQL appends password hashes to SHOW GRANTS; retain only the privilege clause.
      const permissions = (rows as Record<string, string>[]).map(row => {
        const clause = /^(GRANT [A-Z_, ()]+ ON [A-Za-z0-9_`.*]+) TO /.exec(Object.values(row)[0]!);
        if (!clause) throw new Error("unexpected grant format");
        return clause[1]!;
      });
      grants.push({ user: account.User, host: account.Host, permissions });
    }
    const [connections] = await sql.query("SELECT USER,DB,COUNT(*) connections FROM information_schema.PROCESSLIST WHERE USER=? GROUP BY USER,DB", [config.user]);
    const saved = JSON.parse(readFileSync("/root/.pm2/dump.pm2", "utf8")) as Array<{ name: string; DATABASE_URL?: string }>;
    const report = { observedAt: new Date().toISOString(), consumers: consumers.map(row => {
      const database = mysqlSnapshotConfig(row.pm2_env.DATABASE_URL!);
      return { name: row.name, state: row.pm2_env.status, port: row.pm2_env.PORT, codeRoot: row.pm2_env.pm_cwd,
        user: database.user, host: database.host, database: database.database,
        sameCredential: row.pm2_env.DATABASE_URL === active.pm2_env.DATABASE_URL,
        savedCredentialMatches: saved.some(value => value.name === row.name && value.DATABASE_URL === row.pm2_env.DATABASE_URL) };
    }), grants, connections, databaseWrites: 0, providerRequests: 0 };
    writeFileSync(destination, JSON.stringify(report), { mode: 0o600, flag: "wx", flush: true });
    console.log(JSON.stringify(report));
  } finally { await sql.end(); }
}
audit().catch(() => { console.error(JSON.stringify({ ok: false, phase, error: "legacy_consumer_audit_failed" })); process.exitCode = 1; });
