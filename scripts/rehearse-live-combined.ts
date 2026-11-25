import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "mysql2/promise";
import { AppDatabase } from "../src/database/database.ts";
import { EPAY_MYSQL_OFFSET_MINUTES, mysqlSnapshotConfig } from "../src/epay-compat/mysql-snapshot.ts";
import { captureEPaySnapshot, SOURCE_TABLES } from "../src/epay-compat/snapshot.ts";
import { readAuthenticatedEPaySnapshot } from "../src/epay-compat/authenticated-snapshot.ts";
import { rehearseCombinedImport } from "./epay-combined-import-rehearsal.ts";

async function run() {
  if (process.env.EPAY_ISOLATED_TEST !== "1" || statfsSync("/dev/shm").type !== 0x01021994) throw new Error("explicit tmpfs rehearsal is required");
  const processes = JSON.parse(execFileSync("pm2", ["jlist"], {encoding:"utf8",maxBuffer:20*1024*1024,timeout:15000}));
  const legacy = processes.filter((p: {name?: string; pm2_env?: {status?: string}})=>p.name === "epay-next-reconcile-v1" && p.pm2_env?.status === "online");
  if (legacy.length !== 1 || !legacy[0].pm2_env.pm_cwd.startsWith("/www/wwwroot/epay-next-releases/")) throw new Error("legacy source is ambiguous");
  const source = await createConnection(mysqlSnapshotConfig(legacy[0].pm2_env.DATABASE_URL));
  const key = randomBytes(32), directory = mkdtempSync("/dev/shm/perpay-live-combined-");
  let snapshotDb: AppDatabase | undefined;
  try {
    await source.query("SET SESSION TRANSACTION READ ONLY");
    const [mode] = await source.query("SELECT @@session.tx_read_only AS read_only");
    if (Number((mode as Array<{read_only: number}>)[0]?.read_only) !== 1) throw new Error("read-only session required");
    await source.query("SET SESSION time_zone = '+00:00'");
    const [tables] = await source.query("SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()");
    const engines = new Map((tables as Array<{TABLE_NAME:string;ENGINE:string}>).map(row=>[row.TABLE_NAME,row.ENGINE]));
    const expected = Object.keys(SOURCE_TABLES);
    if ([...engines.keys()].some(name=>!expected.includes(name)) || expected.some(name=>engines.get(name)?.toUpperCase() !== "INNODB")) throw new Error("source schema differs");
    snapshotDb = await AppDatabase.open(join(directory,"snapshot.sqlite"),{masterKey:key});
    const options = {source,database:snapshotDb,masterKey:key,instanceId:snapshotDb.instanceId(),sourceName:"live-combined-recovery-rehearsal",requireColumnMetadata:true};
    const capture = await captureEPaySnapshot(options);
    const snapshot = readAuthenticatedEPaySnapshot(options,capture.snapshotId);
    const store = JSON.parse(readFileSync("/www/wwwroot/starmc-api/data/store.json","utf8"));
    const placeholders = Object.fromEntries(snapshot.tables.Merchant.map(row=>[String(row.id),0]));
    const report = await rehearseCombinedImport({...options,merchantFeeBps:placeholders,sourceOffsetMinutes:EPAY_MYSQL_OFFSET_MINUTES},capture.snapshotId,store.payment,true);
    console.log(JSON.stringify({sourceCounts:capture.counts,mainSource:"resumed_persistence_file",coordinatedCutoff:false,...report}));
  } finally {
    snapshotDb?.close();
    await source.end();
    key.fill(0);
    rmSync(directory,{recursive:true,force:true});
  }
}

run().catch(error => {
  // Only application-defined messages are emitted; driver diagnostics can contain credentials.
  const safe = error instanceof Error && /^(main |isolated import |import target |EPay |reopened |source schema |merchant fee |unknown main |unsupported main )/.test(error.message);
  console.error(safe ? error.message : "combined recovery rehearsal failed");
  process.exitCode=1;
});
