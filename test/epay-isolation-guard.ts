import { mysqlSnapshotConfig } from "../src/epay-compat/mysql-snapshot.ts";

export function requireIsolatedMysql(url: string, expectedDatabase: "epay_fixture" | "epay_restore", enabled: string | undefined): void {
  if (enabled !== "1") throw new Error("explicit isolated MySQL test opt-in required");
  if (mysqlSnapshotConfig(url).database !== expectedDatabase) throw new Error("unexpected isolated MySQL database name");
}
