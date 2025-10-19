/**
 * Uploads and publishes to Chrome Web Store using JS API (no shell vars).
 * Reads credentials from environment:
 *  - CWS_EXTENSION_ID
 *  - CWS_CLIENT_ID
 *  - CWS_CLIENT_SECRET
 *  - CWS_REFRESH_TOKEN
 */
const fs = require('fs');
const path = require('path');
const chromeWebstoreUpload = require('chrome-webstore-upload');
const { version } = require('../package.json');

const {
  CWS_EXTENSION_ID,
  CWS_CLIENT_ID,
  CWS_CLIENT_SECRET,
  CWS_REFRESH_TOKEN
} = process.env;

if (!CWS_EXTENSION_ID || !CWS_CLIENT_ID || !CWS_CLIENT_SECRET || !CWS_REFRESH_TOKEN) {
  console.error('Missing one or more CWS_* env vars.');
  process.exit(1);
}

const zipPath = path.resolve(`dist/chrome/run-in-terminal-chrome-v${version}.zip`);

(async () => {
  if (!fs.existsSync(zipPath)) {
    console.error(`Zip not found: ${zipPath}. Run "npm run pack:chrome" first.`);
    process.exit(1);
  }

  const webStore = chromeWebstoreUpload({
    extensionId: CWS_EXTENSION_ID,
    clientId: CWS_CLIENT_ID,
    clientSecret: CWS_CLIENT_SECRET,
    refreshToken: CWS_REFRESH_TOKEN
  });

  console.log('Uploading to Chrome Web Store...');
  await webStore.uploadExisting(fs.createReadStream(zipPath));

  console.log('Publishing...');
  const res = await webStore.publish();
  console.log('Publish status:', res.status || res);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

