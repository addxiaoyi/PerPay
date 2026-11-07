import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { prepareIdentityCandidate } from "../scripts/prepare-main-identity-candidate.mjs";

it("creates only the exact identity insertion and rejects mismatched or ambiguous sources", () => {
  const profile = "  app.get('/api/merchant/profile', requireUser, (req, res) => {";
  const access = "  app.get('/api/merchant/access', requireUser, (req, res) => {\n    return res.end()\n  })\n\n";
  const deployed = Buffer.from(`before\n${profile}\nafter\n`);
  const local = Buffer.from(`before\n${access}${profile}\nafter\n`);
  const digest = createHash("sha256").update(deployed).digest("hex");
  assert.equal(prepareIdentityCandidate(deployed, local, digest).toString(), local.toString());
  assert.throws(() => prepareIdentityCandidate(deployed, local, "0".repeat(64)), /digest mismatch/);
  assert.throws(() => prepareIdentityCandidate(local, local, createHash("sha256").update(local).digest("hex")), /ambiguous/);
  assert.throws(() => prepareIdentityCandidate(deployed, Buffer.from(`${local}${profile}`), digest), /ambiguous/);
  assert.throws(() => prepareIdentityCandidate(deployed, Buffer.from([0xff]), digest), /UTF-8/);
});
