import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectComposeContract, replaceComposeImage } from "./compose-contract.mjs";
import { releasePolicy } from "./release-policy.mjs";
import { releaseTarget, requireReleaseImage } from "./release-target.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function renderReleaseCompose(source, version, image = "ghcr.io/mashiro0619/perpay") {
  const policy = releasePolicy(version);
  const expectedImage = "ghcr.io/mashiro0619/perpay:latest";
  if (inspectComposeContract(source).image !== expectedImage) {
    throw new Error("root Compose app.image must use the latest channel");
  }
  if (typeof image !== 'string' || !image.startsWith('ghcr.io/') || releaseTarget(image.slice('ghcr.io/'.length)).image !== image) {
    throw new Error('release image must be a canonical lowercase GHCR repository');
  }
  if (!policy.prerelease && image + ':latest' === expectedImage) return source;
  const note = policy.prerelease ? "# 预发布版本：固定镜像版本，不跟随稳定版 latest；升级需显式修改三个服务的版本。\n" : '';
  return note + replaceComposeImage(source, image + ":" + policy.composeImageTag);
}

if (import.meta.main) {
  const outputArgument = process.argv[2];
  if (outputArgument === undefined || outputArgument.length === 0) throw new Error("release Compose output path is required");
  const source = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
  const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  const policy = releasePolicy(version);
  const image = process.env.PERPAY_IMAGE === undefined ? undefined :
    requireReleaseImage(process.env.GITHUB_REPOSITORY, process.env.PERPAY_IMAGE, policy.composeImageTag).slice(0, -(policy.composeImageTag.length + 1));
  const rendered = renderReleaseCompose(source, version, image);
  const output = resolve(root, outputArgument);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, rendered, "utf8");
}
