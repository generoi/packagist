# generoi.github.io/packagist

This satis exposes Composer packages for plugins we use across Genero
projects. There are two distinct mechanisms depending on how upstream
distributes the plugin:

- **Genero-owned fork (default)** — a `generoi/<slug>` repo holds a
  curated `composer.json` declaring `type: wordpress-plugin` plus a CI
  workflow that polls upstream, commits new versions, tags, and triggers
  a satis rebuild. Listed under `repositories` in [`satis.json`](./satis.json)
  as `type: vcs`. The release zip URL is rewritten post-build by
  [`rewrite-dist-urls.js`](./rewrite-dist-urls.js) when entries are present
  in [`release-dist.json`](./release-dist.json).

- **Direct GitHub-release mirror** — for plugins that already publish
  signed, prebuilt release zips and don't need a Genero fork (typically
  open-distribution but closed-source). Listed in
  [`release-packages.json`](./release-packages.json);
  [`generate-release-packages.js`](./generate-release-packages.js) runs
  before satis build, queries the GitHub API for the source repo's
  releases, and synthesises a `package`-type entry per stable release
  with `dist.url` pointing at the asset on GitHub. The Satis Build
  workflow runs daily so new upstream releases get picked up automatically.

### Add a plugin (Genero-owned fork)

1. Create repository with a basic `composer.json`

    ```json
    {
      "name": "generoi/<plugin-slug>",
      "type": "wordpress-plugin",
      "description": "Plugin name",
      "homepage": "https://woocommerce.com/products/..."
    }
    ```

2. Add `.github/workflows/build.yml` which checks for plugin updates, makes releases and triggers packagist update ([`generoi/github-action-update-plugins` README has morere examples](https://github.com/generoi/github-action-update-plugins?tab=readme-ov-file#github-workflows-plugins)).

    ```yml
    name: Build
    on:
      workflow_dispatch:
      schedule:
        - cron: '5 4 * * *'
    jobs:
      build:
        uses: generoi/github-action-update-plugins/.github/workflows/wccom-update.yml@master
        secrets:
          ACCESS_TOKEN: ${{ secrets.WCCOM_ACCESS_TOKEN }}
          ACCESS_TOKEN_SECRET: ${{ secrets.WCCOM_ACCESS_TOKEN_SECRET }}
        with:
          slug: 'woocommerce-subscriptions'
          changelog_extract: "'/[0-9\\-]+ - version/ { if (p) { exit }; if ($4 == ver) { p=1; next } } p && NF' changelog.txt"
      update-satis:
        needs: build
        if: needs.build.outputs.updated == 'true'
        uses: generoi/packagist/.github/workflows/update.yml@master
        secrets:
          token: ${{ secrets.PACKAGIST_UPDATE_PAT }}
    ```

3. Add [`@generoi/deploy`](https://github.com/orgs/generoi/teams/deploy) as a collaborator with `read` access. **Do _NOT_ grant write access.**

4. Change the [`PACKAGIST_UPDATE_PAT`](https://github.com/organizations/generoi/settings/secrets/actions/PACKAGIST_UPDATE_PAT) secret permissions to be allowed to be used by the repository.

5. Add the plugin to [`satis.json`](./satis.json) in this repository.

6. Trigger an initial build which will download the latest plugin version, commit it, tag it, push it, release it and if successful trigger a rebuild in this repository.

7. Whenever a new version is found using the cron schedule, the plugin will be updated, released and finally a rebuild of this repository will be once again triggered.

### Add a plugin (direct GitHub-release mirror)

Use this when upstream already publishes a versioned release zip on
GitHub and we don't need a Genero-owned fork (no license key to inject,
no proprietary metadata, no custom `composer.json`).

1. Verify the upstream repo publishes a stable asset filename on every
   release (e.g. `altcha.zip` for `altcha-org/altcha-wordpress-next`).
   Inspect a recent release page to confirm.

2. Add an entry to [`release-packages.json`](./release-packages.json):

    ```json
    {
        "altcha-org/altcha": {
            "source": "altcha-org/altcha-wordpress-next",
            "asset":  "altcha.zip",
            "type":   "wordpress-plugin"
        }
    }
    ```

    Optional fields: `homepage`, `require` (applied uniformly to every
    synthesised version — only useful if upstream's dependency set is
    stable). `type` defaults to `wordpress-plugin`.

3. Trigger a Satis Build (manually via the Actions tab or just wait for
   the daily cron at 04:30 UTC). The script enumerates the upstream's
   releases, synthesises one `package` entry per stable release, and
   exposes them through this satis under the chosen package name.

4. In the consumer project (Bedrock site, etc.) add the satis as a
   `composer` repository (already done in agency projects) and
   `composer require <name>:^<version>` — Composer-installers will route
   it into `web/app/plugins/<slug>/` via Bedrock's `installer-paths`.

### Prerequisites

- [`GENEROI_DEPLOY_PAT`](https://github.com/organizations/generoi/settings/secrets/actions/GENEROI_DEPLOY_PAT) action secret containg a Personal Access Token of `@generoi/deploy` with Conents (read) access. This is used by this repo to read plugin tags/contents from every package listed in `satis.json`. [(settings link)](https://github.com/organizations/generoi/settings/personal-access-tokens/367034)
- [`PACKAGIST_UPDATE_PAT`](https://github.com/organizations/generoi/settings/secrets/actions/PACKAGIST_UPDATE_PAT) action secret containg a Personal Access Token of a user with _write_ access to this repository. The token is limited to only this repository with Contents (write) access. [(settings link)](https://github.com/organizations/generoi/settings/personal-access-tokens/944959)
- [`WCCOM_ACCESS_TOKEN`](https://github.com/organizations/generoi/settings/secrets/actions/WCCOM_ACCESS_TOKEN) and [`WCCOM_ACCESS_TOKEN_SECRET`](https://github.com/organizations/generoi/settings/secrets/actions/WCCOM_ACCESS_TOKEN_SECRET) action secrets which contain the OAuth2 tokens stored in wp_options of the store which is connected to WooCommerce.
- `LICENSE_KEY` is added as a Repository Secret to each relevant plugin repository. The secret contains the license key.
