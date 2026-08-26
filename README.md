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

    Nothing else is needed for the satis build itself: `genero-composer-bot` is installed on all repositories, so a new mirror is covered the moment it exists. If that installation is ever narrowed to selected repositories, the build fails naming the repo up front, rather than partway through the satis run.

    The collaborator step is still required because consuming projects authenticate Composer with `PACKAGIST_GITHUB_TOKEN`, a PAT on that machine user. It goes away once site repos move onto the app too.

4. _Optional._ Change the [`PACKAGIST_UPDATE_PAT`](https://github.com/organizations/generoi/settings/secrets/actions/PACKAGIST_UPDATE_PAT) secret permissions to be allowed to be used by the repository. This only buys an **immediate** satis rebuild after a release — skip it and the plugin still gets indexed by the next scheduled build (every 3h). When the secret isn't granted, [`update.yml`](./.github/workflows/update.yml) emits a warning and exits green rather than failing the plugin repo's build.

5. Add the plugin to [`satis.json`](./satis.json) in this repository.

6. Trigger an initial build which will download the latest plugin version, commit it, tag it, push it, release it and if successful trigger a rebuild in this repository.

7. Whenever a new version is found using the cron schedule, the plugin will be updated, released and finally a rebuild of this repository will be once again triggered.

### How a release reaches the index

Two independent paths, so no single missing credential can strand a release:

- **Push-based (fast, best-effort)** — the plugin repo's `update-satis` job calls
  [`update.yml`](./.github/workflows/update.yml), which POSTs a `repository_dispatch`
  here and rebuilds within a minute. Needs `PACKAGIST_UPDATE_PAT` (step 4 above).
- **Scheduled (slower, guaranteed)** — [`satis.yml`](./.github/workflows/satis.yml)
  runs every 3h and re-reads the tags of every `type: vcs` entry plus every
  upstream release in `release-packages.json`. Requires no per-repo config.

Need it indexed right now and the push path isn't wired up? Just run the build
manually: `gh workflow run satis.yml --repo generoi/packagist`.

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

- `genero-composer-bot`, a GitHub App with Contents (read) and Metadata (read), installed on all repositories in the org. [`satis.yml`](./.github/workflows/satis.yml) mints a token from it per run to read plugin tags and contents, and checks the installation still covers every `type: vcs` entry in `satis.json` before building. Note that `release-packages.json` sources must be **public** repositories — that script authenticates with the job's own `GITHUB_TOKEN`, which no app installation backs. Its client id is inlined in the workflow (it is not a secret, same as the watchdog's); the only credential is the `COMPOSER_BOT_PRIVATE_KEY` org secret, scoped to this repository.

    Replaced `GENEROI_DEPLOY_PAT`, a PAT on the `generoi-deploy` machine user. Same reasoning as `genero-watchdog-bot` in [`watchdog.yml`](./.github/workflows/watchdog.yml): app tokens are minted per run, expire in an hour, never need rotating, and are scoped by the installation rather than by whatever the machine user has accumulated invitations to.
- [`PACKAGIST_UPDATE_PAT`](https://github.com/organizations/generoi/settings/secrets/actions/PACKAGIST_UPDATE_PAT) action secret containg a Personal Access Token of a user with _write_ access to this repository. The token is limited to only this repository with Contents (write) access. [(settings link)](https://github.com/organizations/generoi/settings/personal-access-tokens/944959)
- [`WCCOM_ACCESS_TOKEN`](https://github.com/organizations/generoi/settings/secrets/actions/WCCOM_ACCESS_TOKEN) and [`WCCOM_ACCESS_TOKEN_SECRET`](https://github.com/organizations/generoi/settings/secrets/actions/WCCOM_ACCESS_TOKEN_SECRET) action secrets which contain the OAuth2 tokens stored in wp_options of the store which is connected to WooCommerce.
- `LICENSE_KEY` is added as a Repository Secret to each relevant plugin repository. The secret contains the license key.
