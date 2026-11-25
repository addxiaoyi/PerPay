import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOperationalBackup } from "../src/database/maintenance.ts";

const [root, recovery] = process.argv.slice(2);
if (process.env.PERPAY_CAPTURE_BACKUP !== "1" || !root || !recovery || !/^\/var\/lib\/perpay-candidate-\d{8}[a-z]$/.test(root) || !/^\/root\/perpay-recovery-\d{8}-rc\d+$/.test(recovery)) throw new Error("explicit release backup paths required");
process.umask(0o077);
const reportPath = join(recovery, "pre-upgrade-backup.json");
if (existsSync(reportPath)) throw new Error("release backup already exists");
mkdirSync(join(recovery, "backups"), { mode: 0o700 });
const backup = await createOperationalBackup({ dataDirectory: join(root, "data"), backupDirectory: join(recovery, "backups") });
const sourceKey = join(root, "secrets/master-key"), checkpointKey = join(recovery, "master-key");
const key = readFileSync(sourceKey);
try {
  writeFileSync(checkpointKey, key, { flag: "wx", mode: 0o600, flush: true });
  if (createHash("sha256").update(readFileSync(checkpointKey)).digest("hex") !== createHash("sha256").update(key).digest("hex")) throw new Error("release key backup differs");
} finally { key.fill(0); }
writeFileSync(reportPath, JSON.stringify({ ...backup, sourceRoot: root, keyPreserved: true }), { flag: "wx", mode: 0o600, flush: true });
console.log(JSON.stringify({ ...backup, sourceRoot: root, keyPreserved: true }));
