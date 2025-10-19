/**
 * Cross-platform zipping without shell var expansion.
 * Creates:
 *  - dist/chrome/run-in-terminal-chrome-v{version}.zip
 *  - dist/firefox/run-in-terminal-firefox-v{version}.xpi
 */
const path = require('path');
const bestzip = require('bestzip');
const { version } = require('../package.json');

const target = process.argv[2]; // 'chrome' | 'firefox'
if (!['chrome', 'firefox'].includes(target)) {
  console.error('Usage: node scripts/pack.js <chrome|firefox>');
  process.exit(1);
}

(async () => {
  const isChrome = target === 'chrome';
  const srcDir = isChrome
    ? 'dist/chrome/run-in-terminal/**'
    : 'dist/firefox/run-in-terminal/**';
  const outFile = isChrome
    ? `dist/chrome/run-in-terminal-chrome-v${version}.zip`
    : `dist/firefox/run-in-terminal-firefox-v${version}.xpi`;

  await bestzip({
    source: srcDir,
    destination: outFile
  });
  console.log(`Packed ${outFile}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

