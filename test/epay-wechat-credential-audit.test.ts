import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { registerWechatCredential, revokeWechatCredential } from "../src/epay-compat/wechat-credentials.ts";
import { registerWechatSigningKey, revokeWechatSigningKey } from "../src/epay-compat/wechat-signing-keys.ts";

it("commits WeChat credential changes and secret-free audits together", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-credential-audit-"));
  const masterKey = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey });
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const apiKey = "x".repeat(32);
  try {
    new RuntimeSettingsStore(db, masterKey).initialize();
    const credential = { id: "credential", appId: "app", merchantId: "merchant", platformKey: publicKey, platformKeyId: "serial", apiV3Key: apiKey, validFrom: 100, validUntil: 200, actor: "admin" };
    const signingKey = { id: "signing", appId: "app", merchantId: "merchant", serial: "serial", publicKey, privateKey, validFrom: 100, validUntil: 200, actor: "admin" };
    const cases = [
      { kind: "wechat_credential", table: "epay_wechat_credentials", idColumn: "credential_id", revokeTable: "epay_wechat_credential_revocations", id: credential.id, register: () => registerWechatCredential(db, masterKey, credential, 100), revoke: () => revokeWechatCredential(db, credential.id, "admin", "rotation", 101) },
      { kind: "wechat_signing_key", table: "epay_wechat_signing_keys", idColumn: "key_id", revokeTable: "epay_wechat_signing_key_revocations", id: signingKey.id, register: () => registerWechatSigningKey(db, masterKey, signingKey, 100), revoke: () => revokeWechatSigningKey(db, signingKey.id, "admin", "rotation", 101) },
    ];
    for (const entry of cases) {
      const count = (table: string) => db.read((sql) => Number((sql.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${entry.idColumn}=?`).get(entry.id) as { n: number }).n));
      const failAudit = () => db.write((sql) => sql.exec("CREATE TRIGGER audit_test_failure BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END"));
      const restoreAudit = () => db.write((sql) => sql.exec("DROP TRIGGER audit_test_failure"));
      failAudit();
      assert.throws(entry.register, /audit unavailable/);
      assert.equal(count(entry.table), 0);
      restoreAudit();
      entry.register();
      assert.throws(entry.register);
      failAudit();
      assert.throws(entry.revoke, /audit unavailable/);
      assert.equal(count(entry.revokeTable), 0);
      restoreAudit();
      entry.revoke();
      assert.throws(entry.revoke);
      const events = db.read((sql) => sql.prepare("SELECT action, actor_type, actor_id, subject_type, subject_id, details_json FROM audit_events WHERE subject_type=? AND subject_id=? ORDER BY sequence").all(entry.kind, entry.id));
      assert.deepEqual(events.map((event) => event.action), [`epay.${entry.kind}.registered`, `epay.${entry.kind}.revoked`]);
      assert.ok(events.every((event) => event.actor_type === "ADMIN" && event.actor_id === "admin"));
      const audit = JSON.stringify(events);
      assert.equal(audit.includes(privateKey), false);
      assert.equal(audit.includes(publicKey), false);
      assert.equal(audit.includes(apiKey), false);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
