import { readAuthenticatedEPaySnapshot } from "./authenticated-snapshot.ts";
import { readSourceColumns, SOURCE_TABLES, type SnapshotOptions } from "./snapshot.ts";

export async function verifyEPaySnapshot(options: SnapshotOptions, snapshotId: string): Promise<Record<string, number>> {
  const snapshot = readAuthenticatedEPaySnapshot(options, snapshotId);
  const counts: Record<string, number> = {};
  let transactionOpen = false;
  try {
    await options.source.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await options.source.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    transactionOpen = true;
    for (const [name, primaryKey] of Object.entries(SOURCE_TABLES) as Array<[keyof typeof SOURCE_TABLES, string]>) {
      const [sourceRows, fields] = await options.source.query(`SELECT * FROM \`${name}\` ORDER BY \`${primaryKey}\``);
      if (!Array.isArray(sourceRows)) throw new Error(`source verification failed for ${name}`);
      if (snapshot.columns && JSON.stringify(snapshot.columns[name]) !== JSON.stringify(readSourceColumns(fields, name))) throw new Error(`snapshot column mismatch for ${name}`);
      if (snapshot.tables[name].length !== sourceRows.length) throw new Error(`snapshot row count mismatch for ${name}`);
      for (let index = 0; index < sourceRows.length; index++) {
        if (JSON.stringify(snapshot.tables[name][index]) !== JSON.stringify(sourceRows[index])) throw new Error(`snapshot row content mismatch for ${name}`);
      }
      counts[name] = sourceRows.length;
    }
    await options.source.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { await options.source.query("ROLLBACK"); } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "snapshot verification and source rollback failed");
      }
    }
    throw error;
  }
  return counts;
}
