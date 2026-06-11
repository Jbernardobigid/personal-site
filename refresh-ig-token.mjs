/**
 * refresh-ig-token.mjs
 * Refreshes the long-lived Instagram access token (Instagram-login flavor) and
 * rewrites INSTAGRAM_ACCESS_TOKEN in .env. Sends a Resend alert email if the
 * refresh fails. Run by n8n every ~45 days; refresh works on tokens >24h old.
 *
 * Usage:  node refresh-ig-token.mjs
 */

import './load-env.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '.env');
const ALERT_TO = 'jorge.mbernardo@gmail.com';

async function sendAlert(subject, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('No RESEND_API_KEY — cannot send alert email.');
    return;
  }
  // resend.dev sandbox sender delivers to the account owner address only — fine for self-alerts
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'IG Pipeline <onboarding@resend.dev>', to: [ALERT_TO], subject, text }),
  });
  if (!res.ok) console.error(`Alert email failed: HTTP ${res.status}`);
}

async function main() {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token) {
    console.error('Missing INSTAGRAM_ACCESS_TOKEN in .env.');
    process.exit(1);
  }

  try {
    const url = new URL('https://graph.instagram.com/refresh_access_token');
    url.searchParams.set('grant_type', 'ig_refresh_token');
    url.searchParams.set('access_token', token);
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok || body.error) {
      throw new Error(body.error ? body.error.message : `HTTP ${res.status}`);
    }

    const env = fs.readFileSync(ENV_PATH, 'utf8');
    const updated = env.replace(/^INSTAGRAM_ACCESS_TOKEN=.*$/m, `INSTAGRAM_ACCESS_TOKEN="${body.access_token}"`);
    if (updated === env && !env.includes(body.access_token)) {
      throw new Error('Could not find INSTAGRAM_ACCESS_TOKEN line in .env to update.');
    }
    fs.writeFileSync(ENV_PATH, updated, 'utf8');

    const days = Math.round(body.expires_in / 86400);
    console.log(`Token refreshed — new token valid for ${days} days. .env updated.`);
  } catch (err) {
    console.error(`Token refresh FAILED: ${err.message}`);
    await sendAlert(
      '⚠️ Instagram token refresh failed',
      `The IG token refresh failed: ${err.message}\n\nIf the token expired, re-generate it: docs/setup-meta-and-notion.md Part A4 (takes ~3 minutes).`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
