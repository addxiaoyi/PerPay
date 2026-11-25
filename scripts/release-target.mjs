// SPDX-License-Identifier: MIT
import { isReleaseVersion } from '../src/shared/release-version.ts';

const OWNER = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u;
const NAME = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u;

function canonicalRepository(value) {
  if (typeof value !== 'string' || value !== value.trim()) throw new Error('A trusted owner/repository is required');
  const parts = value.split('/');
  if (parts.length !== 2 || parts[0].length > 39 || !OWNER.test(parts[0]) || parts[1].length > 100 || !NAME.test(parts[1]) || /\.git$/iu.test(parts[1])) {
    throw new Error('Release repository must be a GitHub owner/repository with a GHCR-safe name');
  }
  return value.toLowerCase();
}

export function releaseTarget(repository, targetRepository = repository) {
  const source = canonicalRepository(repository);
  if (canonicalRepository(targetRepository) !== source) throw new Error('Release target must match the trusted GitHub repository');
  return Object.freeze({ repository: source, image: 'ghcr.io/' + source, registry: 'https://ghcr.io/v2/' + source });
}

export function requireReleaseImage(repository, image, tag) {
  const target = releaseTarget(repository);
  if (tag !== 'latest' && !isReleaseVersion(tag)) throw new Error('Release image tag must be latest or a canonical release version');
  if (image !== target.image + ':' + tag) throw new Error('Release Compose image must match this repository and release channel');
  return image;
}

if (import.meta.main) {
  const target = releaseTarget(process.env.GITHUB_REPOSITORY, process.env.PERPAY_RELEASE_REPOSITORY);
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 2 && arguments_[0] === '--check-image') {
    if (arguments_[1] !== target.image) throw new Error('Publication image must match the trusted GitHub repository');
  } else if (arguments_.length === 0) {
    process.stdout.write('repository=' + target.repository + '\nimage_name=' + target.image + '\n');
  } else {
    throw new Error('Expected no arguments or --check-image IMAGE');
  }
}
