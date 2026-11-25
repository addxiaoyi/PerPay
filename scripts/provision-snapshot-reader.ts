import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createConnection, type ConnectionOptions } from "mysql2/promise";
import { mysqlSnapshotConfig } from "../src/epay-compat/mysql-snapshot.ts";

const destination = "/etc/helstera/perpay-snapshot.json";
const username = "perpay_snapshot_20261105";
let phase = "arguments";
async function provision() {
  const panelAdmin = process.argv[3] === "--panel-admin";
  if (process.argv[2] !== "--create-reader" || process.argv.length !== (panelAdmin ? 4 : 3) || existsSync(destination)) throw new Error("reader already exists or invocation is invalid");
  process.umask(0o077);
  const processes = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8", timeout: 15000, maxBuffer: 20 * 1024 * 1024 })) as Array<{ name?: string; pm2_env?: { status?: string; pm_cwd?: string; DATABASE_URL?: string } }>;
  const matches = processes.filter(row => row.name === "epay-next-reconcile-v1" && row.pm2_env?.status === "online" && row.pm2_env.pm_cwd?.startsWith("/www/wwwroot/epay-next-releases/"));
  if (matches.length !== 1 || !matches[0]?.pm2_env?.DATABASE_URL) throw new Error("legacy credential source is ambiguous");
  const config = mysqlSnapshotConfig(matches[0].pm2_env.DATABASE_URL);
  if (!config.database || !/^[A-Za-z0-9_]+$/.test(config.database)) throw new Error("invalid source database");
  phase = "connect_legacy";
  const adminConfig: ConnectionOptions = { ...config };
  if (panelAdmin) {
    const password = execFileSync("/www/server/panel/pyenv/bin/python3", ["-c", "import sys; sys.path.insert(0,'/www/server/panel/class'); import public; value=public.M('config').where('id=?',(1,)).getField('mysql_root'); assert isinstance(value,str) and value; print(value,end='')"],
      { cwd: "/www/server/panel", encoding: "utf8", timeout: 5000, maxBuffer: 16384 });
    adminConfig.user = "root";
    adminConfig.password = password;
    adminConfig.socketPath = "/tmp/mysql.sock";
  }
  const administrator = await createConnection(adminConfig);
  let reader: Awaited<ReturnType<typeof createConnection>> | undefined;
  let created = false, published = false;
  try {
    phase = "create_reader";
    const password = randomBytes(48).toString("base64url");
    // No IF NOT EXISTS: an unrelated pre-existing account must never be adopted or changed.
    await administrator.query("CREATE USER ?@'127.0.0.1' IDENTIFIED BY ?", [username, password]);
    created = true;
    await administrator.query(`GRANT SELECT, LOCK TABLES ON \`${config.database}\`.* TO ?@'127.0.0.1'`, [username]);
    const restricted = { host: "127.0.0.1", port: config.port ?? 3306, user: username, password, database: config.database,
      dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false, multipleStatements: false, connectTimeout: 10000 };
    phase = "verify_reader";
    reader = await createConnection(restricted);
    const [grants] = await reader.query("SHOW GRANTS");
    const statements = (grants as Record<string, unknown>[]).map(row => String(Object.values(row)[0]));
    if (statements.length !== 2 || !statements.some(value => /^GRANT USAGE ON \*\.\* TO /.test(value)) ||
        !statements.some(value => value.startsWith(`GRANT SELECT, LOCK TABLES ON \`${config.database}\`.* TO `))) throw new Error("unexpected reader grants");
    await reader.query("SELECT count(*) FROM Merchant");
    let writeDenied = false;
    try { await reader.query("UPDATE Merchant SET id=id WHERE 1=0"); }
    catch (error) { if ((error as { code?: string }).code === "ER_TABLEACCESS_DENIED_ERROR") writeDenied = true; else throw error; }
    if (!writeDenied) throw new Error("reader unexpectedly has write privileges");
    phase = "publish_reader";
    writeFileSync(destination, JSON.stringify(restricted), { mode: 0o600, flag: "wx", flush: true });
    published = true;
    console.log(JSON.stringify({ configured: true, readVerified: true, writeDenied, previousCredentialsPreserved: true, credentialFile: destination }));
  } finally {
    await reader?.end();
    try { if (created && !published) await administrator.query("DROP USER ?@'127.0.0.1'", [username]); }
    finally { await administrator.end(); }
  }
}
provision().catch(error => {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^ER_[A-Z_]+$/.test(error.code) ? error.code : "verification_failed";
  console.error(JSON.stringify({ ok: false, error: "snapshot_reader_provision_failed", phase, code }));
  process.exitCode = 1;
});
