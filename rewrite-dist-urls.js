#!/usr/bin/env node
/**
 * Rewrites Satis-generated dist URLs for packages that publish
 * pre-built release zips on GitHub.
 *
 * Usage: node rewrite-dist-urls.js <build-dir>
 *
 * Reads release-dist.json for the mapping of package names to URL
 * templates. The placeholder {tag} is replaced with the version
 * string as a tag (e.g. "v0.1.1") and {version} with the raw
 * version number (e.g. "0.1.1").
 */

const fs = require('fs');
const path = require('path');

const buildDir = process.argv[2];
if (!buildDir) {
  console.error('Usage: node rewrite-dist-urls.js <build-dir>');
  process.exit(1);
}

const configPath = path.join(__dirname, 'release-dist.json');
if (!fs.existsSync(configPath)) {
  console.log('No release-dist.json found, skipping dist URL rewriting.');
  process.exit(0);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const packageNames = Object.keys(config);

if (packageNames.length === 0) {
  console.log('No packages configured in release-dist.json, skipping.');
  process.exit(0);
}

console.log(`Rewriting dist URLs for: ${packageNames.join(', ')}`);

/**
 * Build the dist URL for a given package and version string.
 */
function buildDistUrl(packageName, version) {
  const template = config[packageName];
  // Version from Satis may or may not have a 'v' prefix.
  // {tag} ensures the 'v' prefix (e.g. "v0.1.1").
  // {version} strips any leading 'v' (e.g. "0.1.1").
  const rawVersion = version.replace(/^v/, '');
  const tag = version.startsWith('v') ? version : `v${version}`;
  return template.replace(/\{tag\}/g, tag).replace(/\{version\}/g, rawVersion);
}

/**
 * Recursively rewrite dist URLs in a packages object.
 * Handles both Composer v1 (include) and v2 (p2) formats.
 */
function rewritePackages(packages) {
  let count = 0;
  for (const [name, versions] of Object.entries(packages)) {
    if (!packageNames.includes(name)) continue;

    const versionList = Array.isArray(versions) ? versions : Object.values(versions);
    for (const versionData of versionList) {
      if (!versionData.dist || !versionData.version) continue;
      const newUrl = buildDistUrl(name, versionData.version);
      if (versionData.dist.url !== newUrl) {
        console.log(`  ${name}@${versionData.version}: ${versionData.dist.url} -> ${newUrl}`);
        versionData.dist.url = newUrl;
        count++;
      }
    }
  }
  return count;
}

/**
 * Process a single JSON file.
 */
function processFile(filePath) {
  const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let modified = false;

  // Composer v2 metadata (p2/ files): { "packages": { "vendor/name": [...] } }
  if (content.packages && typeof content.packages === 'object') {
    const count = rewritePackages(content.packages);
    if (count > 0) modified = true;
  }

  if (modified) {
    fs.writeFileSync(filePath, JSON.stringify(content));
    console.log(`  Updated: ${filePath}`);
  }
}

// Process p2 metadata files for each configured package
for (const packageName of packageNames) {
  const p2File = path.join(buildDir, 'p2', packageName + '.json');
  if (fs.existsSync(p2File)) {
    processFile(p2File);
  }
}

// Process include files (Composer v1 format)
const includeDir = path.join(buildDir, 'include');
if (fs.existsSync(includeDir)) {
  for (const file of fs.readdirSync(includeDir)) {
    if (file.endsWith('.json')) {
      processFile(path.join(includeDir, file));
    }
  }
}

console.log('Done rewriting dist URLs.');
