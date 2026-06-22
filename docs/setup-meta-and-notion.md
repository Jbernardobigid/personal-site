# Setup Guide — Meta (Instagram API) + Notion

User tasks for Phase 1 of the influencer-growth plan. Each step says exactly what to click.
When you're done with Part A you'll have two values for `.env`; Part B gives two more.

---

## Part A — Meta developer app + access token (~15 min)

You already have: IG Professional account ✓, linked Facebook Page ✓.
You're creating: a developer app, then a long-lived access token.

### A1. Create the app

1. Go to https://developers.facebook.com → log in with the Facebook account that owns your Page.
2. **My Apps → Create App**.
3. Use case: choose **Other** → app type **Business** → Next.
4. App name: `Jorge Content Studio` (anything works). Create app.

### A2. Add the Instagram product

1. In the app dashboard, find **Add products** → locate **Instagram** → **Set up**.
2. Pick the **Instagram API with Facebook Login** path (your IG is linked to a FB Page — this is the right one, NOT "Instagram API with Instagram Login").
3. You do NOT need App Review or Live mode: publishing to your own account works in
   Development mode because you are an admin of the app.

### A3. Add your IG account as Instagram Tester (dev-mode requirement)

1. App dashboard → **App roles → Roles** → **Add People** → role **Instagram Tester** → your IG username.
2. Accept the invite from the Instagram side: instagram.com (web) → **Settings → Apps and
   websites → Tester invites** → Accept.
   - Tip: do this in an **Incognito window** logged into ONLY the correct IG account —
     stale sessions for old/disabled accounts silently break the OAuth flow.

### A4. Generate the token (Instagram-login flavor — the path that works)

> Note: the "API setup with Facebook login" / Graph API Explorer route kept granting
> tokens without the `pages_*` permissions (the newer consent flow drops them), so
> `/me/accounts` came back empty. The Instagram-login flavor below needs no Page at all.
> Done 2026-06-11: connected as @jotabernard0.

1. App dashboard → **Instagram → API setup with Instagram business login**.
2. Section **"1. Generate access tokens"** → your account (added in A3) → **Generate token**
   → authorize in the popup → copy the token (starts with `IGAA...`, already long-lived).
3. Same page, top: click **Show** next to **Instagram app secret** → copy it.
4. Run:

```
node setup-instagram-token.mjs --ig-login --token <TOKEN> --ig-app-secret <INSTAGRAM_APP_SECRET>
```

It prints the `.env` lines. Paste them in:

```
INSTAGRAM_ACCESS_TOKEN="IGAA..."                     # long-lived, ~60 days
INSTAGRAM_USER_ID="1784..."                          # numeric IG account id
INSTAGRAM_API_BASE="https://graph.instagram.com"     # selects the Instagram-login flavor
INSTAGRAM_APP_SECRET="..."                           # for token refresh
```

### A5. Verify

```
npm run ig:check
```

Should print your IG username, follower and post counts. If it does, Part A is done.

> Token lifecycle: lasts ~60 days; refresh any time after it's 24h old via
> `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=<token>`
> (no app secret needed). The n8n refresh workflow calls this every ~45 days and
> emails an alert on failure. Until it exists, re-run A4 if auth errors appear.

---

## Part B — Notion integration (~10 min)

You're creating: an internal integration token + the IG Pipeline database.

### B1. Create the integration

1. Go to https://www.notion.so/my-integrations → **New integration**.
2. Name: `IG Pipeline`. Workspace: your personal workspace. Type: **Internal**.
3. Capabilities: Read, Update, Insert content.
4. Copy the **Internal Integration Secret** (`ntn_...` or `secret_...`).

### B2. Create the IG Pipeline database

1. In Notion, create a new page → **Database — Full page**. Name: `IG Pipeline`.
2. Add these properties (exact names matter — n8n and scripts reference them):

| Property | Type | Notes |
|---|---|---|
| `Name` | Title | post title / reel id |
| `Status` | Select | options: `Draft`, `Needs Edit`, `Approved For Production`, `Produced`, `Approved For Publishing`, `Published`, `Archived` |
| `Type` | Select | `Carousel`, `Reel`, `Single` |
| `Series` | Select | `Lessons From The Bike`, `Depois dos 40`, `Tech Sem Hype`, `Presença Preta`, `Construindo em Público`, `Pai em Construção`, `O Que Estou Aprendendo`, `Blog-derived` |
| `Pillar` | Select | `Cycling`, `Black Identity`, `Technology`, `Entrepreneurship`, `Fatherhood`, `Learning`, `Career After 40` |
| `Caption` | Text | full IG caption |
| `Preview` | Files & media | preview image(s) |
| `Media URL` | URL | public URL of staged media |
| `Publish Date` | Date | scheduled/actual |
| `IG Media ID` | Text | filled after publishing |
| `Notes` | Text | review notes / red flags |

3. Create two views: **Board** grouped by `Status` (approval kanban) and **Calendar** on `Publish Date`.

### B3. Share the database with the integration

1. Open the `IG Pipeline` database page → `•••` menu (top right) → **Connections** → **Connect to** → pick `IG Pipeline` (your integration).
2. Get the database ID: copy the page URL — the 32-char hex segment before `?` is the DB ID.

### B4. Save the values

Add to `.env`:

```
NOTION_API_KEY="ntn_..."
NOTION_IG_DB_ID="<32-char id>"
```

And in n8n: **Credentials → New → Notion API** → paste the same token (the n8n workflows use this credential).

### B5. (Later, same pattern) Metrics database

The weekly insights workflow will use a second database `IG Metrics` (created when that
workflow is built — same connection steps).

---

## Done?

When both parts are finished, tell Claude "Meta and Notion are set up" — the next build
steps (n8n IG Build & Queue workflow + first test publish) take it from there.

---

## Part C — Comment-to-DM automation ("comenta CENSO") (~10 min)

For the reply-to-comments.mjs flow: someone comments a trigger keyword on a Reel, the
account replies with a private DM containing a link. The existing token from Part A only
has posting scopes — it needs to be re-generated with comment permissions added.

Verified against Meta's current docs (2026-06-22): under Instagram API with Instagram
Login, a private reply is sent via `POST /<IG_USER_ID>/messages` with a JSON body
`{ recipient: { comment_id }, message: { text } }` — not the older `private_replies`
edge some examples online still show. One reply per comment, within 7 days of the
comment.

### C1. Re-generate the token with comment permissions

1. App dashboard → **Instagram → API setup with Instagram business login**.
2. Section **"1. Generate access tokens"** → your account → **Generate token**.
3. In the permissions popup, make sure these are checked, in addition to whatever's
   already there for posting:
   - `instagram_business_basic`
   - `instagram_business_manage_comments`
4. Authorize, copy the new token (`IGAA...`).
5. Run the same command as Part A4, with the new token:

```
node setup-instagram-token.mjs --ig-login --token <TOKEN> --ig-app-secret <INSTAGRAM_APP_SECRET>
```

6. Update `INSTAGRAM_ACCESS_TOKEN` in `.env` with the value it prints
   (`INSTAGRAM_USER_ID` and `INSTAGRAM_API_BASE` don't change).
7. Repeat the same `.env` update on the VPS — this token only helps once n8n's copy
   matches.

You're an Instagram Tester on this app already (Part A3), so this should work in
Development Mode without App Review — same as posting does today. If Meta's dashboard
insists on "Advanced Access" before letting you subscribe, that's only required for
*other* people's accounts in Live Mode, not your own as a tester; re-check you're using
the app-owner-logged-in session if it blocks you.

### C2. Subscribe to the `comments` webhook field

1. App dashboard → **Webhooks** (add the product first if it's not listed yet) →
   **Instagram** → subscribe to the **comments** field.
2. Meta asks for two things before it lets you subscribe:
   - **Callback URL** — the n8n webhook URL (I'll give you this once Part 4 of the
     build is live, something like `https://n8n.jorgebernardo.tech/webhook/ig-comment-reply`).
   - **Verify Token** — any string you pick yourself. Write it down; it goes in both
     Meta's dashboard and the n8n workflow.
3. Click **Verify and Save**. Meta pings the callback URL once and expects it to echo
   back the challenge — so do this step only after the n8n workflow is confirmed live,
   not before.

### C3. Confirm the account is public

Comment webhook notifications only fire for a public Instagram professional account.
If it's already public for posting (it is), nothing to do here.
