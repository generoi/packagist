#!/usr/bin/env node
/**
 * Generates synthetic Satis `package` repository entries for plugins that
 * publish prebuilt zip releases on GitHub but don't (or can't) live as a
 * Genero-owned fork with `type: wordpress-plugin` in their composer.json.
 *
 * Reads `release-packages.json`:
 *
 *   {
 *     "altcha-org/altcha": {
 *       "source": "altcha-org/altcha-wordpress-next",
 *       "asset":  "altcha.zip",
 *       "type":   "wordpress-plugin"
 *     }
 *   }
 *
 * For each entry, queries the GitHub API for the source repo's releases,
 * synthesises one `package` repository per stable release that ships the
 * named asset, appends them to `satis.json.repositories`, and writes the
 * merged config to `satis.merged.json` for `composer/satis build` to read.
 *
 * Usage: node generate-release-packages.js [satis.json] [output.json]
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'release-packages.json');
const SATIS_PATH = process.argv[2] || path.join(ROOT, 'satis.json');
const OUT_PATH = process.argv[3] || path.join(ROOT, 'satis.merged.json');

const satis = JSON.parse(fs.readFileSync(SATIS_PATH, 'utf8'));

if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(OUT_PATH, JSON.stringify(satis, null, 4));
    console.log(`No release-packages.json — wrote ${SATIS_PATH} as-is to ${OUT_PATH}.`);
    process.exit(0);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const token = process.env.GITHUB_TOKEN || process.env.GENEROI_DEPLOY_PAT || '';
const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'generoi-packagist-build',
};
if (token) {
    headers.Authorization = `Bearer ${token}`;
}

/**
 * Fetch all releases for the repo (pages of 100 until exhausted), filtering
 * out drafts and prereleases. Caps at 5 pages so a misconfigured entry can't
 * burn the full rate limit budget.
 */
async function fetchReleases(repo) {
    const all = [];
    for (let page = 1; page <= 5; page++) {
        const url = `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`;
        const res = await fetch(url, { headers });
        if (!res.ok) {
            throw new Error(`GitHub API ${res.status} for ${repo}: ${await res.text()}`);
        }
        const batch = await res.json();
        if (batch.length === 0) break;
        all.push(...batch);
        if (batch.length < 100) break;
    }
    return all.filter((r) => !r.draft && !r.prerelease);
}

async function main() {
    const synthesised = [];

    for (const [name, entry] of Object.entries(config)) {
        if (!entry.source || !entry.asset) {
            throw new Error(`release-packages.json: ${name} missing required source/asset.`);
        }
        const releases = await fetchReleases(entry.source);
        let kept = 0;
        for (const rel of releases) {
            const asset = (rel.assets || []).find((a) => a.name === entry.asset);
            if (!asset) {
                console.warn(`  skip ${name}@${rel.tag_name}: asset "${entry.asset}" not in release.`);
                continue;
            }
            const tag = rel.tag_name;
            // Composer's version constraint engine expects a numeric-ish
            // version; preserve the raw tag in the dist URL so it still
            // resolves to the right release asset.
            const version = tag.startsWith('v') ? tag.slice(1) : tag;
            synthesised.push({
                type: 'package',
                package: {
                    name,
                    version,
                    type: entry.type || 'wordpress-plugin',
                    dist: {
                        type: 'zip',
                        url: asset.browser_download_url,
                    },
                    ...(entry.require ? { require: entry.require } : {}),
                    ...(entry.homepage ? { homepage: entry.homepage } : {}),
                },
            });
            kept++;
        }
        console.log(`${name}: ${kept} versions (from ${releases.length} stable releases).`);
    }

    satis.repositories = (satis.repositories || []).concat(synthesised);
    fs.writeFileSync(OUT_PATH, JSON.stringify(satis, null, 4));
    console.log(`Wrote ${OUT_PATH} with ${synthesised.length} synthesised package entries.`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
