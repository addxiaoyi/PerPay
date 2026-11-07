import { createConnection } from "mysql2/promise";

import { captureEPaySnapshot, SOURCE_TABLES, type SnapshotDatabase, type SnapshotSource } from "./snapshot.ts";
import { verifyEPaySnapshot } from "./verify-snapshot.ts";

const TABLES = Object.keys(SOURCE_TABLES);
// Legacy Prisma stores and reads this installation's DATETIME values as UTC.
export const EPAY_MYSQL_OFFSET_MINUTES = 0;

export interface MysqlSnapshotOptions {
  mysqlUrl: string;
  database: SnapshotDatabase;
  masterKey: Uint8Array;
  instanceId: string;
  sourceName: string;
}

export function mysqlSnapshotConfig(mysqlUrl: string) {
  let address: URL;
  try { address = new URL(mysqlUrl); } catch { throw new Error("invalid EPay snapshot database URL"); }
  if (address.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(address.hostname) || address.search || address.hash || !address.pathname.slice(1) || !address.username) {
    throw new Error("EPay snapshot requires a local isolated MySQL URL without query parameters");
  }
  return {
    host: address.hostname === "[::1]" ? "::1" : address.hostname,
    port: address.port ? Number(address.port) : 3306,
    user: decodeURIComponent(address.username),
    password: decodeURIComponent(address.password),
    database: decodeURIComponent(address.pathname.slice(1)),
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    multipleStatements: false,
    connectTimeout: 10000,
  };
}

export async function snapshotIsolatedMysql(options: MysqlSnapshotOptions) {
  const connection = await createConnection(mysqlSnapshotConfig(options.mysqlUrl));
  try {
    return await snapshotMysqlConnection(connection, options);
  } finally {
    await connection.end();
  }
}

export async function snapshotMysqlConnection(connection: SnapshotSource, options: Omit<MysqlSnapshotOptions, "mysqlUrl">) {
  await connection.query("SET SESSION time_zone = '+00:00'");
  const [rows] = await connection.query("SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
  if (!Array.isArray(rows)) throw new Error("cannot inspect snapshot source tables");
  const engines = new Map((rows as Array<{ TABLE_NAME: string; ENGINE: string | null }>).map((row) => [row.TABLE_NAME, row.ENGINE]));
  for (const name of engines.keys()) {
    if (!TABLES.includes(name)) throw new Error(`snapshot source contains an unhandled table: ${name}`);
  }
  for (const name of TABLES) {
    if (engines.get(name)?.toUpperCase() !== "INNODB") throw new Error(`snapshot source table ${name} is missing or not InnoDB`);
  }
  const snapshotOptions = { ...options, source: connection, requireColumnMetadata: true };
  const snapshot = await captureEPaySnapshot(snapshotOptions);
  const verified = await verifyEPaySnapshot(snapshotOptions, snapshot.snapshotId);
  return { ...snapshot, verified };
}
