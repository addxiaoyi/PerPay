import { resolve } from "node:path";

import { AppDatabase } from "../database/database.ts";
import { snapshotIsolatedMysql } from "./mysql-snapshot.ts";

if (process.env.EPAY_ISOLATED_SNAPSHOT !== "1") throw new Error("EPAY_ISOLATED_SNAPSHOT=1 is required for an isolated restore");
const mysqlUrl = required("EPAY_SNAPSHOT_MYSQL_URL");
const key = required("PERPAY_MASTER_KEY");
if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("PERPAY_MASTER_KEY must contain 64 hexadecimal characters");
const path = resolve(required("PERPAY_SNAPSHOT_DATABASE_PATH"));
const database = await AppDatabase.open(path, { masterKey: Buffer.from(key, "hex") });
try {
  const result = await snapshotIsolatedMysql({ mysqlUrl, database, masterKey: Buffer.from(key, "hex"), instanceId: database.instanceId(), sourceName: process.env.EPAY_SOURCE_NAME?.trim() || "isolated-restore" });
  console.log(JSON.stringify(result));
} finally {
  database.close();
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
