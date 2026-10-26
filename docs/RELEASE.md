# Releasing Loot Crates

How a version goes out, and the one-time checklist for making the repository public (Linear VIB-199).

## Who runs what

| Step | How it starts | Where it runs |
|---|---|---|
| CI: lint, tests, build | Automatically, on every pull request and every push to `main` | GitHub Actions, `.github/workflows/checks.yml` |
| Smoke and live checks | By hand, during a round | The dev machine (they need a browser and the LAN Foundry) |
| Dev release | By hand: `npm run release:dev` | The dev machine, with its `gh` login |
| Public release | By hand: `gh release create`, after the pull request merges | The dev machine, with its `gh` login, from `main` |

Only CI is in GitHub Actions. Publishing dev builds from Actions is in the backlog (Linear VIB-207); until then both releases are the manual steps below.

## A round, from branch to release

1. Cut the round's branch from `main` (`council/round-N`). All work, including the release commit, goes on it: `main` takes changes only through a pull request.
2. Make the release commit on the branch (see "The release commit").
3. Push the branch and open a pull request to `main`. CI runs on it by itself.
4. Publish a dev build from the branch (see "The dev channel") and update the test world.
5. The owner merges the pull request once CI is green.
6. Publish the public release from `main` (see "The public release").

## The release commit

1. In [CHANGELOG.md](../CHANGELOG.md), move the **Unreleased** bullets under a new `## X.Y.Z` heading with a one-line summary, and leave `- Nothing yet.` under Unreleased (`test/release.test.js` wants a bullet in every entry).
2. The GM's "What's new" note: put the summary in `module/lang/en.json` under `LOOTCRATES.News.Title` and three to five of the new entry's bullets, word for word, as `LOOTCRATES.News.Line1` and on. List those keys and the version in `module/scripts/core/changelog.js`. `test/welcome.test.js` checks they match the changelog and `module.json`. The note is plain text inside Foundry: no backticks or markup, and no word of four or more capitals (a bullet naming the README stays in the changelog only).
3. Bump `version` in `module/module.json`, `package.json` and `package-lock.json`. If the release changes the Foundry or dnd5e versions it supports, or starts using a new hook or API, update [COMPATIBILITY.md](COMPATIBILITY.md) and the README's table in the same commit (`test/release.test.js` checks them against the manifest).
4. `npm run lint && npm run test:run && npm run build` all green, and `NODE_PATH=$(npm root -g) npm run smoke` for any UI change.

## The public release

After the pull request merges, on an up-to-date `main`:

```
git checkout main && git pull --ff-only origin main
npm run lint && npm run test:run && npm run build
gh release create vX.Y.Z dist/module.zip dist/module.json --target main --title "Loot Crates X.Y.Z" --notes-file <the X.Y.Z changelog entry>
```

The manifest's `manifest` and `download` URLs point at the latest release, so every world installed from the public manifest finds the update by itself. GitHub can take a minute or two to serve the new files; check that `https://github.com/clearspec11/loot-crates/releases/latest/download/module.json` reports the new version.

## Main is protected

A ruleset on GitHub keeps `main` to pull requests: no direct pushes, no force-pushes, no deleting it, for admins too. A pull request merges only when the `checks` job (`.github/workflows/checks.yml`: lint, tests, build) has passed. No approval is required, because the pull requests are opened from the owner's own account. Smoke and the live checks need a browser and the LAN Foundry, so they stay on the dev machine and are reported in the pull request.

## The dev channel

Each round's work can be installed before it is public. `npm run release:dev` publishes the checked-out commit (clean and pushed) as a GitHub pre-release under the fixed tag `dev`, version `X.Y.Z-dev.N`: `X.Y.Z` is the branch's version and `N` counts up for each build of it. A test world installed from

```
https://github.com/clearspec11/loot-crates/releases/download/dev/module.json
```

updates to every dev build and never to a public release; the public manifest never sees a dev build, since a pre-release is never "latest". Foundry counts `1.2.0-dev.1` as newer than `1.1.0`, and `dev.2` as newer than `dev.1` (`test/channel.test.js`). A dev build shows no "What's new" note, because the note is keyed on the release version.

GitHub serves a new release's files a minute or two after it is made, so the script waits until the dev manifest has the new version and the zip downloads, then says it is live; update the test world after that.

When: once a round's pull request is open with its release commit, and again after any fix pushed to it. The checked-out commit must be committed and pushed, or the script refuses. After the merge, the public release goes out from `main` as above; the dev release is left as it is until the next round's first dev build replaces it.

```
git checkout council/round-N && git push
npm run release:dev
```

The test world (cc-dev) is installed from the dev manifest, so it gets dev builds only; a public release reaches it only as the next dev build.

## What the zip ships

`npm run build` packs `module/` into `dist/module.zip` and refuses to pack anything but `module.json`, `scripts/*.js`, `styles/*.css` and `lang/*.json` (the rule is `tools/package-files.mjs`; `test/release.test.js` checks the working tree against it). Screenshots in `docs/images/` are for the README and the package listing only and never ship.

Audited on 2026-10-24 at 0.14.0 plus this round's work: 47 files, 276 KB.

```
module.json
scripts/*.js      45 files
styles/module.css
```

## Going public (VIB-199)

- [x] **License.** MIT (the user's choice, 2026-10-24): `LICENSE` at the root, `"license": "LICENSE"` in `module/module.json`, and the build copies it into every zip.
- [x] **Author.** `authors` is the user's GitHub handle, `{ "name": "clearspec11", "url": "https://github.com/clearspec11" }` (the user's choice, 2026-10-24).
- [x] **History check.** Done on 2026-10-24 over all 152 commits on every branch; see below.
- [x] **Flip the repository public** on GitHub (Settings, General, Danger Zone, Change visibility).
- [x] **Check the README on GitHub**: every image shows and the manifest URL installs on a clean Foundry.
- [x] **Point cc-dev at the GitHub manifest.** Done 2026-10-25; since then cc-dev installs from the dev manifest instead (see "The dev channel").
- [x] **Retire the LAN package server** (port 8767) that installed private builds into cc-dev: stopped 2026-10-25. The working-copy server on port 8766 (`npm run foundry:serve`) stays: the live checks import the branch's code from it.
- [ ] **Optional: submit to the Foundry package list** at foundryvtt.com (Community Packages, Submit a Package) with the manifest URL. The listing reads `readme`, `changelog`, `bugs` and the `media` screenshots from `module/module.json`.

## History check

Run from the repository root on 2026-10-24, over `git log --all -p` (152 commits, every branch and tag):

```
# credentials and tokens
git log --all -p | grep -cE 'ghp_[A-Za-z0-9]{20,}|github_pat_|gho_[A-Za-z0-9]{20,}|sk-ant-|xox[abp]-|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|PVEAPIToken|OUTLINE_API_KEY|PVE_TOKEN|ANTHROPIC_API_KEY|Bearer [A-Za-z0-9._~+/-]{20,}|(api[_-]?key|secret|password|token)["'"'"']?\s*[:=]\s*["'"'"'][^"'"'"' ]{8,}'
# tailnet names and addresses
git log --all -p | grep -cE '\.ts\.net|tailscale|\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b'
# private addresses and host names
git log --all -p | grep -oE '\b(192\.168|10\.[0-9]+|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3}(:[0-9]+)?' | sort | uniq -c
git log --all -p | grep -oiE '\b(pve0[0-9]|leigh-pie|claude-agent|homelab|beetoff[.a-z]*)\b' | sort | uniq -c
# e-mail addresses
git log --all -p | grep -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' | sort | uniq -c
```

Result:

- **Credentials and tokens: 0 matches.** The word "password" appears only in "a Gamemaster with no password: a dev world only" in `foundry-dev/README.md`, and "token" only as design tokens and CSS class names.
- **Tailnet: 0 matches.**
- **Private addresses:** `192.168.0.57:30000` (the dev Foundry world, 37 lines) and `192.168.0.190:8766` (the LAN server for the working copy, 27 lines), in the dev checks and their docs. Expected and fine: LAN addresses that can't be reached from the internet.
- **Host names:** "homelab" twice, in a local path (`/home/claude/homelab/loot-crates/...`) inside an `.impeccable/` design record. Harmless; it names a folder, not a host.
- **E-mail addresses:** the commit identities only: the bot `brindle@beetoff.xyz`, GitHub's own `noreply` addresses and the `Co-Authored-By` trailer's `noreply@anthropic.com`. Nothing private.

Nothing needs rewriting before the repository goes public.
