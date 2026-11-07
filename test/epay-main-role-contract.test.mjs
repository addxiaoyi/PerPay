import assert from "node:assert/strict";
import { it } from "node:test";
import { roleSetOf, hasRole } from "./fixtures/starmc-main/utils/permission.js";
import { buildCapabilityMatrix } from "./fixtures/starmc-main/auth/capabilities.js";
import { profileAdminAccess } from "./fixtures/starmc-main/profile-admin-access.mjs";
import { applyUserProfilePatch } from "./fixtures/starmc-main/modules/user/profile.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

it("keeps StarMC role semantics aligned with StarPAY merchant access", () => {
  assert.equal(hasRole({ roles: ["superadmin"] }, "admin"), true);
  assert.equal(hasRole({ roles: ["admin"] }, "admin"), true);
  assert.equal(hasRole({ roles: ["owner"] }, "admin"), false);
  assert.equal(hasRole({ roles: ["member"] }, "admin"), false);
  assert.deepEqual([...roleSetOf({ roles: ["superadmin"] })].sort(), ["admin", "superadmin"]);
});

it("personal-center admin visibility agrees with authoritative roles and profile edits cannot elevate access", () => {
  for (const role of ["user", "owner", "member", "reviewer", "moderator", "sponsor", "admin", "superadmin"]) {
    const user = { id: "ordinary-user", roles: [role], username: "member" };
    const expected = ["admin", "superadmin"].includes(role);
    const capabilities = buildCapabilityMatrix(user);
    assert.equal(profileAdminAccess(user, capabilities), expected, role);
    assert.equal(hasRole(user, "admin"), expected, role);
    assert.equal(capabilities.capabilities.canManageUsers, expected, role);
    const saved = structuredClone(user);
    const patch = applyUserProfilePatch({ users: [user] }, user, { displayName: "普通用户", roles: ["superadmin"], role: "admin", capabilities: { canManageUsers: true }, balance: 100000 });
    assert.equal(patch.ok, true);
    assert.deepEqual(user.roles, saved.roles);
    assert.equal(user.role, undefined);
    assert.equal(user.capabilities, undefined);
    assert.equal(user.balance, undefined);
    assert.equal(profileAdminAccess(user, buildCapabilityMatrix(user)), expected, role);
  }
});

it("keeps the captured main-site permission source provenance verifiable", () => {
  const manifest = JSON.parse(readFileSync(new URL("./fixtures/legacy-source-manifest.json", import.meta.url), "utf8"));
  for (const file of manifest.files) {
    assert.match(file.path, /^test\/fixtures\/[a-zA-Z0-9_./-]+$/);
    const bytes = readFileSync(new URL("../" + file.path, import.meta.url));
    const normalized = bytes.toString("utf8").replaceAll("\r\n", "\n");
    assert.equal(createHash("sha256").update(normalized).digest("hex"), file.sha256, file.path);
  }
  assert.equal(manifest.liveVerification.merchantAccessBlockMatchesLive, true);
  assert.equal(manifest.liveVerification.capabilitySourceMatchesLive, true);
});
