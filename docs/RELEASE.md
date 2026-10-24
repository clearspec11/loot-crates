# Releasing Loot Crates

How a version goes out, and the one-time checklist for making the repository public (Linear VIB-199).

## Every release

1. Move the changelog's **Unreleased** entry under the new version number in [CHANGELOG.md](../CHANGELOG.md), and put three to five of its lines in `module/scripts/changelog.js` (the GM's "What's new" note). `test/welcome.test.js` checks they agree.
2. Bump `version` in `module/module.json` and `package.json`.
3. `npm run lint && npm run test:run && npm run build` all green, and `NODE_PATH=$(npm root -g) npm run smoke` for any UI change.
4. Tag `vX.Y.Z` on `main` and publish a GitHub release with `dist/module.json` and `dist/module.zip` attached. The manifest's `manifest` and `download` URLs point at the latest release, so Foundry finds the update by itself.

## What the zip ships

`npm run build` packs `module/` into `dist/module.zip` and refuses to pack anything but `module.json`, `scripts/*.js`, `styles/*.css` and `lang/*.json` (the rule is `scripts/package-files.mjs`; `test/release.test.js` checks the working tree against it). Screenshots in `docs/images/` are for the README and the package listing only and never ship.

Audited on 2026-10-24 at 0.14.0 plus this round's work: 47 files, 276 KB.

```
module.json
scripts/*.js      45 files
styles/module.css
```

## Going public (VIB-199)

- [ ] **License.** Pick one and add `LICENSE` at the root, then set `license` in `module/module.json`. Not decided yet: the user's call.
- [ ] **Author.** `authors` in `module/module.json` reads `{ "name": "Loot Crates" }`. TODO: replace it with the name (and optionally `url` or `discord`) the module should be published under. Not decided yet: the user's call.
- [x] **History check.** Done on 2026-10-24 over all 152 commits on every branch; see below.
- [ ] **Flip the repository public** on GitHub (Settings, General, Danger Zone, Change visibility).
- [ ] **Check the README on GitHub**: every image shows and the manifest URL installs on a clean Foundry.
- [ ] **Point cc-dev at the GitHub manifest.** In cc-dev's setup screen, reinstall Loot Crates from `https://github.com/clearspec11/loot-crates/releases/latest/download/module.json`, so it updates like any user's copy.
- [ ] **Retire the LAN server** that served the working copy to cc-dev (`npm run foundry:serve`, port 8766) once nothing installs from it.
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
