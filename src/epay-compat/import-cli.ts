import { resolve } from "node:path";

import { AppDatabase } from "../database/database.ts";
import { assertImportReady, importEPay } from "./importer.ts";

assertImportReady();
const masterKey = requiredHex("PERPAY_MASTER_KEY", 64);
const databasePath = process.env.PERPAY_DATABASE_PATH
  ? resolve(process.env.PERPAY_DATABASE_PATH)
  : resolve(process.env.PERPAY_DATA_DIR ?? "./data", "perpay.sqlite3");
const database = await AppDatabase.open(databasePath, { masterKey: Buffer.from(masterKey, "hex") });

try {
  const summary = await importEPay({
    database,
    masterKey: Buffer.from(masterKey, "hex"),
    instanceId: database.instanceId(),
    mysqlUrl: required("EPAY_MYSQL_URL"),
    sourceName: process.env.EPAY_SOURCE_NAME?.trim() || "epay_starmc",
  });
  console.log(JSON.stringify(summary));
} finally {
  database.close();
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredHex(name: string, length: number): string {
  const value = required(name);
  if (value.length !== length || !/^[0-9a-f]+$/i.test(value)) {
    throw new Error(`${name} must contain ${length} hexadecimal characters`);
  }
  return value;
}
