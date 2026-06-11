/**
 * setup-instagram-token.mjs
 * One-time helper for Part A4 of docs/setup-meta-and-notion.md.
 * Exchanges a short-lived Graph API token for a long-lived one (~60 days),
 * discovers the linked Instagram business account ID, and prints the
 * ready-to-paste .env lines.
 *
 * Usage:
 *   node setup-instagram-token.mjs --app-id <APP_ID> --app-secret <APP_SECRET> --token <SHORT_LIVED_TOKEN>
 */

const GRAPH = 'https://graph.facebook.com/v23.0';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app-id') args.appId = argv[++i];
    else if (argv[i] === '--app-secret') args.appSecret = argv[++i];
    else if (argv[i] === '--token') args.token = argv[++i];
  }
  return args;
}

async function graphGet(path, params) {
  const url = new URL(`${GRAPH}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok || body.error) {
    const msg = body.error ? `${body.error.type}: ${body.error.message}` : `HTTP ${res.status}`;
    throw new Error(`Graph API ${path} failed — ${msg}`);
  }
  return body;
}

async function exchangeForLongLivedToken(appId, appSecret, shortToken) {
  const body = await graphGet('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortToken,
  });
  return { token: body.access_token, expiresIn: body.expires_in };
}

async function findInstagramAccount(longToken) {
  const pages = await graphGet('/me/accounts', { access_token: longToken });
  if (!pages.data || pages.data.length === 0) {
    throw new Error('No Facebook Pages found on this token. Re-generate the token and make sure you select your Page in the popup (pages_show_list permission).');
  }
  for (const page of pages.data) {
    const detail = await graphGet(`/${page.id}`, {
      fields: 'name,instagram_business_account',
      access_token: longToken,
    });
    if (detail.instagram_business_account) {
      return { pageName: detail.name, igUserId: detail.instagram_business_account.id };
    }
  }
  throw new Error('None of your Pages has a linked Instagram business account. Check the IG↔Page link in Meta Business Suite.');
}

async function main() {
  const { appId, appSecret, token } = parseArgs(process.argv.slice(2));
  if (!appId || !appSecret || !token) {
    console.error('Usage: node setup-instagram-token.mjs --app-id <APP_ID> --app-secret <APP_SECRET> --token <SHORT_LIVED_TOKEN>');
    process.exit(1);
  }

  console.log('Exchanging short-lived token for a long-lived one...');
  const { token: longToken, expiresIn } = await exchangeForLongLivedToken(appId, appSecret, token);
  const days = expiresIn ? Math.round(expiresIn / 86400) : '~60';
  console.log(`OK — long-lived token obtained (expires in ${days} days).`);

  console.log('Looking up your Instagram business account...');
  const { pageName, igUserId } = await findInstagramAccount(longToken);

  const profile = await graphGet(`/${igUserId}`, {
    fields: 'username,followers_count,media_count',
    access_token: longToken,
  });

  console.log(`OK — found @${profile.username} (via Page "${pageName}") — ${profile.followers_count} followers, ${profile.media_count} posts.`);
  console.log('\nPaste these lines into .env:\n');
  console.log(`INSTAGRAM_ACCESS_TOKEN="${longToken}"`);
  console.log(`INSTAGRAM_USER_ID="${igUserId}"`);
  console.log(`META_APP_ID="${appId}"`);
  console.log(`META_APP_SECRET="${appSecret}"`);
  console.log('\nThen verify with: node post-to-instagram.mjs check');
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
