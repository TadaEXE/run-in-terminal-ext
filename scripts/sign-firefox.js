/**
 * Signs the Firefox add-on using web-ext's Node API.
 * Reads credentials from environment:
 *  - AMO_JWT_ISSUER
 *  - AMO_JWT_SECRET
 * Usage: node scripts/sign-firefox.js [listed|unlisted]
 */
const { cmd } = require('web-ext');
const path = require('path');

const channel = (process.argv[2] || 'listed').toLowerCase();
if (!['listed', 'unlisted'].includes(channel)) {
  console.error('Channel must be "listed" or "unlisted"');
  process.exit(1);
}

const apiKey = process.env.AMO_JWT_ISSUER;
const apiSecret = process.env.AMO_JWT_SECRET;

if (!apiKey || !apiSecret) {
  console.error('Missing AMO_JWT_ISSUER or AMO_JWT_SECRET in environment');
  process.exit(1);
}

(async () => {
  await cmd.sign(
    {
      sourceDir: path.resolve('dist/firefox/run-in-terminal'),
      artifactsDir: path.resolve('dist/signed'),
      id: 'run-in-terminal@tada.com',
      channel,
      apiKey,
      apiSecret
    },
    { shouldExitProgram: false }
  );
  console.log(`Firefox ${channel} signing complete.`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

