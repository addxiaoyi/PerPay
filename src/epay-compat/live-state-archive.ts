import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { LiveStateEnvelope } from "./live-state-envelope.ts";

const MAX_ARCHIVE_BYTES = 180 * 1024 * 1024;

function secureDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("recovery directory must be a real directory");
  if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid?.())) throw new Error("recovery directory must be private and owned by the operator");
  if (process.platform === "win32") return;
  const uid = process.geteuid?.();
  for (let parent = dirname(directory);; parent = dirname(parent)) {
    const ancestor = lstatSync(parent);
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) throw new Error("recovery directory ancestor must be a real directory");
    if (ancestor.uid !== 0 && ancestor.uid !== uid) throw new Error("recovery directory ancestor has an untrusted owner");
    const writable = (ancestor.mode & 0o022) !== 0;
    const rootSticky = ancestor.uid === 0 && (ancestor.mode & 0o1000) !== 0;
    if (writable && !rootSticky) throw new Error("recovery directory ancestor is writable by other users");
    if (parent === dirname(parent)) break;
  }
}

function archivePath(path: string): string {
  if (!isAbsolute(path) || !/^[a-zA-Z0-9_-]{1,100}\.json$/.test(basename(path))) throw new Error("invalid recovery archive path");
  const directory = dirname(path);
  secureDirectory(directory);
  return directory;
}

function validEnvelope(value: unknown): value is LiveStateEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 7 && row.version === 1 && typeof row.snapshotId === "string" && /^[a-f0-9]{32}$/.test(row.snapshotId) && typeof row.recipientFingerprint === "string" && /^[a-f0-9]{64}$/.test(row.recipientFingerprint) && [row.wrappedKey, row.nonce, row.authenticationTag, row.ciphertext].every((field) => typeof field === "string" && field.length > 0 && field.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(field));
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function validateLiveStateArchiveTarget(path: string): void {
  archivePath(path);
  try {
    lstatSync(path);
    throw new Error("recovery archive already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

// Publish only a fully written ciphertext file; link prevents replacing an existing archive.
export function writeLiveStateArchive(path: string, envelope: LiveStateEnvelope): { sha256: string; bytes: number } {
  const directory = archivePath(path);
  if (!validEnvelope(envelope)) throw new Error("invalid recovery envelope");
  validateLiveStateArchiveTarget(path);
  const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("recovery archive too large");
  const temporary = join(directory, `.recovery-${randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    created = true;
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(temporary, path);
    syncDirectory(directory);
    return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
  } finally {
    if (created) unlinkSync(temporary);
  }
}

// The digest must come from an independent trusted record; decryption still authenticates the envelope.
export function readLiveStateArchive(path: string, expectedSha256: string): LiveStateEnvelope {
  archivePath(path);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("invalid recovery archive digest");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > MAX_ARCHIVE_BYTES) throw new Error("invalid recovery archive file");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size) throw new Error("recovery archive changed while reading");
    if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) throw new Error("recovery archive digest mismatch");
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!validEnvelope(parsed) || !bytes.equals(Buffer.from(JSON.stringify(parsed), "utf8"))) throw new Error("invalid recovery archive contents");
    return parsed;
  } finally { closeSync(fd); }
}
