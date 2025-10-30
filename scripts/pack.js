/**
 * Cross-platform zipping without shell var expansion.
 *
 * Usage:
 * node pack.js [PATH]
 *
 * Creates:
 * PATH.zip
 * or (if firefox in path)
 * PATH.xpi
 */
const path = require('path');
const bestzip = require('bestzip');
const { version } = require('../package.json');

const srcDir = process.argv[2];
const ff = srcDir.includes("firefox");

(async () => {
  const outFile = ff ? `${srcDir}-v${version}.xpi` : `${srcDir}-v${version}.zip`;

  await bestzip({
    source: srcDir,
    destination: outFile
  });
  console.log(`Packed ${outFile}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

