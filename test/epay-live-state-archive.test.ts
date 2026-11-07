import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { readLiveStateArchive, writeLiveStateArchive } from "../src/epay-compat/live-state-archive.ts";
import { openLiveState, sealLiveState } from "../src/epay-compat/live-state-envelope.ts";

it("publishes a large encrypted snapshot without overwriting and validates recovery", { timeout: 30000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "starmc-recovery-archive-"));
  const path = join(directory, "snapshot.json");
  const key = generateKeyPairSync("rsa", { modulusLength: 3072, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const fingerprint = createHash("sha256").update(createPublicKey(key.publicKey).export({ type: "spki", format: "der" })).digest("hex");
  const id = "0123456789abcdef0123456789abcdef";
  const state = Buffer.alloc(50 * 1024 * 1024, 0x78);
  const marker = Buffer.from("synthetic-confidential-value");
  marker.copy(state, 1234);
  try {
    const envelope = sealLiveState(state, key.publicKey, id, fingerprint);
    const receipt = writeLiveStateArchive(path, envelope);
    const bytes = readFileSync(path);
    assert.equal(bytes.includes(marker), false);
    assert.equal(receipt.sha256, createHash("sha256").update(bytes).digest("hex"));
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o077, 0);
    assert.throws(() => writeLiveStateArchive(path, envelope), /exist/i);
    assert.deepEqual(readdirSync(directory), ["snapshot.json"]);
    const recovered = openLiveState(readLiveStateArchive(path, receipt.sha256), key.privateKey, id);
    try { assert.equal(recovered.equals(state), true); } finally { recovered.fill(0); }
    bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 1;
    writeFileSync(path, bytes);
    assert.throws(() => readLiveStateArchive(path, receipt.sha256), /digest mismatch/);
  } finally { state.fill(0); rmSync(directory, { recursive: true, force: true }); }
});

it("rejects insecure archive paths and malformed envelopes", () => {
  const directory = mkdtempSync(join(tmpdir(), "starmc-recovery-path-"));
  try {
    assert.throws(() => writeLiveStateArchive("relative.json", {} as never), /path/);
    assert.throws(() => writeLiveStateArchive(join(directory, "bad name.json"), {} as never), /path/);
    assert.throws(() => writeLiveStateArchive(join(directory, "good.json"), {} as never), /envelope/);
    assert.deepEqual(readdirSync(directory), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("rejects a shared or symlinked recovery directory on Linux", { skip: process.platform === "win32" }, () => {
  const parent = mkdtempSync(join(tmpdir(), "starmc-recovery-parent-"));
  const directory = mkdtempSync(join(parent, "private-"));
  const alias = join(parent, "alias");
  try {
    symlinkSync(directory, alias);
    assert.throws(() => writeLiveStateArchive(join(alias, "snapshot.json"), {} as never), /real directory/);
    chmodSync(directory, 0o755);
    assert.throws(() => writeLiveStateArchive(join(directory, "snapshot.json"), {} as never), /private/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

it("rejects writable and symlinked archive ancestors", { skip: process.platform === "win32" }, () => {
  const parent = mkdtempSync(join(tmpdir(), "starmc-recovery-ancestor-"));
  const ancestor = join(parent, "ancestor");
  const alias = join(parent, "alias");
  try {
    const actual = mkdtempSync(join(parent, "actual-"));
    const directory = mkdtempSync(join(actual, "private-"));
    symlinkSync(actual, alias);
    assert.throws(() => writeLiveStateArchive(join(alias, directory.split(/[\\/]/).pop()!, "snapshot.json"), {} as never), /ancestor must be a real directory/);
    chmodSync(actual, 0o777);
    assert.throws(() => writeLiveStateArchive(join(directory, "snapshot.json"), {} as never), /ancestor is writable/);
    assert.throws(() => writeLiveStateArchive(join(ancestor, "snapshot.json"), {} as never));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
