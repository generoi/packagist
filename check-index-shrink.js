#!/usr/bin/env node
/**
 * Refuses to publish a Satis index that has lost packages or tagged versions.
 *
 * Usage: node check-index-shrink.js <previous-p2-dir> <current-p2-dir> <satis-config>
 *
 * Composer records a 404 on an individual tag's composer.json and carries on —
 * VcsRepository::shouldRethrowTransportException() rethrows only 401, 403, 429
 * and 5xx — so one flaky request drops one version from a build that stays
 * green. The publish step then wipes p2/ and copies the short build over the
 * good metadata, and downstream this reads as an unresolvable plugin rather
 * than as a failed build. See #17.
 *
 * Compares tagged versions only. The ~dev files track branches, which are
 * created and deleted legitimately and would make this noisy.
 *
 * Removing a package from satis.json is not a shrink. That case is recognised
 * from the source repository each published version carries, so no override
 * flag and no inspection of the commit is needed.
 */

const fs = require('fs');
const path = require('path');

const [previousDir, currentDir, satisConfigPath] = process.argv.slice(2);

if (!previousDir || !currentDir || !satisConfigPath) {
  console.error('Usage: node check-index-shrink.js <previous-p2-dir> <current-p2-dir> <satis-config>');
  process.exit(1);
}

// No previously published index — nothing to compare against, and refusing to
// publish would mean this repository could never bootstrap one.
if (!fs.existsSync(previousDir)) {
  console.log(`No previous index at ${previousDir}, nothing to compare.`);
  process.exit(0);
}

if (!fs.existsSync(currentDir)) {
  console.error(`::error title=No index built::Expected Satis output at ${currentDir}, found nothing.`);
  process.exit(1);
}

/** `git@github.com:generoi/x.git` and `https://github.com/generoi/x` both to `generoi/x`. */
function repoSlug(url) {
  if (!url) {
    return null;
  }
  const match = String(url).match(/github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?$/);
  return match ? match[1].toLowerCase() : null;
}

function jsonFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return jsonFiles(full);
    }
    // ~dev.json holds branches, not tags.
    return entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('~dev.json')
      ? [full]
      : [];
  });
}

/** name -> { versions: Set<string>, source: string|null } */
function census(dir) {
  const packages = new Map();

  for (const file of jsonFiles(dir)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`::error title=Unreadable metadata::${file} is not valid JSON: ${err.message}`);
      process.exit(1);
    }

    for (const [name, versions] of Object.entries(parsed.packages || {})) {
      const entry = packages.get(name) || { versions: new Set(), source: null };
      for (const version of versions) {
        entry.versions.add(version.version);
        entry.source = entry.source || repoSlug(version.source && version.source.url);
      }
      packages.set(name, entry);
    }
  }

  return packages;
}

const satis = JSON.parse(fs.readFileSync(satisConfigPath, 'utf8'));
const declaredRepos = new Set();
const declaredPackages = new Set();

for (const repository of satis.repositories || []) {
  if (repository.type === 'package' && repository.package) {
    declaredPackages.add(repository.package.name);
  } else if (repository.url) {
    const slug = repoSlug(repository.url);
    if (slug) {
      declaredRepos.add(slug);
    }
  }
}

const previous = census(previousDir);
const current = census(currentDir);

const gone = [];
const shrunk = [];
const removedOnPurpose = [];

for (const [name, before] of previous) {
  const after = current.get(name);

  if (!after) {
    const stillDeclared = (before.source && declaredRepos.has(before.source)) || declaredPackages.has(name);
    (stillDeclared ? gone : removedOnPurpose).push({ name, count: before.versions.size, source: before.source });
    continue;
  }

  const lost = [...before.versions].filter((version) => !after.versions.has(version));
  if (lost.length > 0) {
    shrunk.push({ name, lost });
  }
}

const grew = [...current.keys()].filter((name) => !previous.has(name));

console.log(`previous: ${previous.size} packages, current: ${current.size} packages.`);
for (const entry of removedOnPurpose) {
  console.log(`  dropped (no longer in satis.json): ${entry.name}, was ${entry.count} versions`);
}
for (const name of grew) {
  console.log(`  added: ${name}`);
}

if (gone.length === 0 && shrunk.length === 0) {
  console.log('No package or tagged version was lost.');
  process.exit(0);
}

for (const entry of gone) {
  console.error(
    `::error title=Package disappeared::${entry.name} is gone from the index but ${entry.source || 'its source'} is still declared in satis.json. ` +
    'Either the mirror could not be read this run, or its composer.json name changed - a rename needs confirming by hand.'
  );
}
for (const entry of shrunk) {
  const shown = entry.lost.slice(0, 10).join(', ');
  const more = entry.lost.length > 10 ? `, and ${entry.lost.length - 10} more` : '';
  console.error(`::error title=Versions lost::${entry.name} lost ${entry.lost.length} tagged version(s): ${shown}${more}`);
}

console.error(
  '::error title=Refusing to publish::The build is shorter than what is already published, so publishing would overwrite good metadata with it. ' +
  'A transient 404 on a tag does not fail the Satis build (see #17), so re-run before investigating - it usually passes.'
);
process.exit(1);
