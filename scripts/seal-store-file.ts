import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { sealLiveState } from "../src/epay-compat/live-state-envelope.ts";
import { writeLiveStateArchive } from "../src/epay-compat/live-state-archive.ts";

const [sourcePath, publicKeyPath, fingerprint, archivePath] = process.argv.slice(2);
if (!sourcePath || !publicKeyPath || !fingerprint || !archivePath) throw new Error("source, public key, fingerprint and archive paths are required");
const fd = openSync(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
let plaintext: Buffer | undefined;
try {
  const before = fstatSync(fd, { bigint: true });
  if (!before.isFile() || before.size < 1n || before.size > 128n * 1024n * 1024n) throw new Error("invalid store file");
  plaintext = readFileSync(fd);
  const after = fstatSync(fd, { bigint: true });
  const current = lstatSync(sourcePath, { bigint: true });
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.ino !== current.ino || current.isSymbolicLink()) throw new Error("store changed during archive read");
  const snapshotId = randomBytes(16).toString("hex");
  const envelope = sealLiveState(plaintext, readFileSync(publicKeyPath, "utf8"), snapshotId, fingerprint);
  const archive = writeLiveStateArchive(archivePath, envelope);
  const manifest = { version: 1, snapshotId, archiveSha256: archive.sha256, archiveBytes: archive.bytes,
    sourceSha256: createHash("sha256").update(plaintext).digest("hex"), sourceBytes: plaintext.length,
    sourceInode: before.ino.toString(), sourceMtimeNs: before.mtimeNs.toString(), sourceMode: Number(before.mode & 0o777n),
    capturedAt: new Date().toISOString() };
  writeFileSync(`${archivePath}.manifest.json`, JSON.stringify(manifest), { flag: "wx", mode: 0o600, flush: true });
  console.log(JSON.stringify({ archived: true, bytes: manifest.sourceBytes, snapshotId }));
} finally {
  plaintext?.fill(0);
  closeSync(fd);
}
