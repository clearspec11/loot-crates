/* What the module zip may ship: the manifest, its scripts, its styles and
   (once there are any) its translations. Nothing else: no docs, images,
   tests, maps or editor leftovers. tools/build.mjs refuses to pack a
   module/ folder holding anything else, and test/release.test.js checks the
   same rule against the working tree. Scripts sit in main.js and the four
   folders core/, games/, views/ and foundry/ (docs/DEVELOPING.md). */
const SHIPPABLE = [
  /^module\.json$/,
  /^scripts\/(?:(?:core|games|views|foundry)\/)?[\w.-]+\.js$/,
  /^styles\/[\w.-]+\.css$/,
  /^lang\/[\w.-]+\.json$/,
];

// path: a file's path inside module/, with forward slashes.
export const shippable = path => SHIPPABLE.some(re => re.test(path));
