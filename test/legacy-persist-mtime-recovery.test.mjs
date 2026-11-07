import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "node:test";
import { openLiveState, sealLiveState } from "../src/epay-compat/live-state-envelope.ts";
import { readLiveStateArchive, writeLiveStateArchive } from "../src/epay-compat/live-state-archive.ts";

const modulePath = process.env.EPAY_DEPLOYED_PERSIST_FIXTURE;
const expectedHash = process.env.EPAY_DEPLOYED_PERSIST_SHA256;

it("recovers legacy saves after preserving and reopening the conflicting disk version", {
  skip: !modulePath || !expectedHash, timeout: 10000,
}, async () => {
  assert.equal(createHash("sha256").update(readFileSync(modulePath)).digest("hex"), expectedHash);
  const directory = mkdtempSync(join(tmpdir(), "legacy-store-recovery-"));
  const file = join(directory, "store.json");
  try {
    copyFileSync(modulePath, join(directory, "persist.js"));
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    writeFileSync(join(directory, "config.js"), `export const config = {dataDir:${JSON.stringify(directory)},databaseUrl:null};`);
    writeFileSync(file, JSON.stringify({users:[{id:"initial"}],payment:{orders:[],ledger:[]}}));
    utimesSync(file, 1000, 1000);
    const persist = await import(pathToFileURL(join(directory, "persist.js")).href);
    const live = persist.loadStore();
    live.users.push({id:"memory-only"});
    live.payment.orders.push({id:"memory-order",amountCents:123});
    const external = JSON.stringify({users:[{id:"disk-only"}],payment:{orders:[{id:"disk-order"}],ledger:[]}});
    writeFileSync(file, external);
    utimesSync(file, 2000, 2000);
    persist.scheduleSave();
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(readFileSync(file,"utf8"), external);
    const keys = generateKeyPairSync("rsa", {modulusLength:3072});
    const publicPem = keys.publicKey.export({type:"spki",format:"pem"});
    const fingerprint = createHash("sha256").update(keys.publicKey.export({type:"spki",format:"der"})).digest("hex");
    const snapshotId = randomBytes(16).toString("hex");
    const archivePath = join(directory,"prior-disk.json");
    const archived = writeLiveStateArchive(archivePath, sealLiveState(Buffer.from(external),publicPem,snapshotId,fingerprint));
    const recovered = openLiveState(readLiveStateArchive(archivePath,archived.sha256),keys.privateKey.export({type:"pkcs8",format:"pem"}),snapshotId);
    try { assert.equal(recovered.toString(), external); } finally { recovered.fill(0); }
    const before = statSync(file);
    utimesSync(file, before.atime, new Date(0));
    persist.scheduleSave();
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual(JSON.parse(readFileSync(file,"utf8")), live);
    live.payment.ledger.push({id:"later-entry",availableDelta:123});
    persist.scheduleSave();
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual(JSON.parse(readFileSync(file,"utf8")), live);
    assert.equal(persist.getStore(), live);
    assert.ok(statSync(file).mtimeMs > before.mtimeMs);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
