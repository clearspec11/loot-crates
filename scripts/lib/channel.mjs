/* The dev channel: a pre-release of the branch under review, published
   under the fixed GitHub release tag "dev" so its URLs never move. A
   Foundry world installed from DEV_MANIFEST updates to each dev build and
   never to a public release; one installed from the public manifest never
   sees a dev build (GitHub never makes a pre-release "latest").

   A dev build's version is the branch's version with "-dev.N". Foundry's
   isNewerVersion compares part by part ("1.2.0-dev.1" splits into 1, 2,
   "0-dev", 1), so it is newer than 1.1.0 and each N is newer than the
   last. N starts at 1 for each new branch version. */
export const DEV_TAG = "dev";
const DEV_BASE = `https://github.com/clearspec11/loot-crates/releases/download/${DEV_TAG}`;
export const DEV_MANIFEST = `${DEV_BASE}/module.json`;

// The version after `current`, the dev release's version now (or null).
export function nextDevVersion(version, current) {
  const m = /^(\d+\.\d+\.\d+)-dev\.(\d+)$/.exec(current ?? "");
  const n = m && m[1] === version ? Number(m[2]) + 1 : 1;
  return `${version}-dev.${n}`;
}

// The manifest a dev build ships: its version, and update URLs on the dev
// release, in dist/module.json and inside the zip alike (Foundry keeps the
// zip's copy and checks its `manifest` URL for updates).
export function devManifest(manifest, devVersion) {
  if (!devVersion.startsWith(`${manifest.version}-dev.`)) throw new Error(`dev version ${devVersion} is not a build of ${manifest.version}`);
  return { ...manifest, version: devVersion, manifest: DEV_MANIFEST, download: `${DEV_BASE}/module.zip` };
}
