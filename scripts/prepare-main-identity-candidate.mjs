import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PROFILE_ROUTE = "  app.get('/api/merchant/profile', requireUser, (req, res) => {";
const ACCESS_ROUTE = "  app.get('/api/merchant/access', requireUser, (req, res) => {";

export function prepareIdentityCandidate(deployed, local, expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("invalid deployed source digest");
  if (createHash("sha256").update(deployed).digest("hex") !== expectedSha256) throw new Error("deployed source digest mismatch");
  const source = deployed.toString("utf8");
  const candidate = local.toString("utf8");
  if (!Buffer.from(source).equals(deployed) || !Buffer.from(candidate).equals(local)) throw new Error("source must be valid UTF-8");
  if (source.includes(ACCESS_ROUTE) || source.split(PROFILE_ROUTE).length !== 2 || candidate.split(ACCESS_ROUTE).length !== 2 || candidate.split(PROFILE_ROUTE).length !== 2) throw new Error("identity route or insertion point is ambiguous");
  const start = candidate.indexOf(ACCESS_ROUTE);
  const end = candidate.indexOf(PROFILE_ROUTE, start);
  if (end < 0) throw new Error("identity route does not precede profile route");
  const route = candidate.slice(start, end);
  if (!route.endsWith("  })\n\n") || route.includes("\n  app.")) throw new Error("identity route boundary is invalid");
  return Buffer.from(source.replace(PROFILE_ROUTE, route + PROFILE_ROUTE));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [deployedPath, localPath, expectedSha256, outputPath, ...extra] = process.argv.slice(2);
  if (!deployedPath || !localPath || !expectedSha256 || !outputPath || extra.length) throw new Error("usage: node prepare-main-identity-candidate.mjs DEPLOYED_FILE LOCAL_FILE SHA256 OUTPUT_FILE");
  const output = prepareIdentityCandidate(readFileSync(deployedPath), readFileSync(localPath), expectedSha256);
  writeFileSync(outputPath, output, { flag: "wx", mode: 0o600 });
  process.stdout.write(`candidate sha256 ${createHash("sha256").update(output).digest("hex")}\n`);
}
