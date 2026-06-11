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

### A3. Get a short-lived token (Graph API Explorer)

1. Go to https://developers.facebook.com/tools/explorer/
2. Top right: select your new app under **Meta App**.
3. **User or Page** → User Token.
4. **Permissions** — add all of these:
   - `instagram_basic`
   - `instagram_content_publish`
   - `instagram_manage_insights`
   - `pages_show_list`
   - `pages_read_engagement`
   - `business_management`
5. Click **Generate Access Token** → approve the popup (select your Page + IG account when asked).
6. Copy the token (long string starting with `EAA...`).

### A4. Exchange it and discover your IG user ID (automated)

You also need the **App ID** and **App Secret**: app dashboard → **App settings → Basic**.

Run the helper (it exchanges the token for a 60-day one and finds your IG user ID):

```
node setup-instagram-token.mjs --app-id <APP_ID> --app-secret <APP_SECRET> --token <SHORT_LIVED_TOKEN>
```

It prints the exact `.env` lines. Paste them into `.env`:

```
INSTAGRAM_ACCESS_TOKEN="EAA..."   # long-lived, ~60 days
INSTAGRAM_USER_ID="1784..."       # numeric IG business account id
META_APP_ID="..."                 # needed for token refresh
META_APP_SECRET="..."             # needed for token refresh
```

### A5. Verify

```
node post-to-instagram.mjs check
```

Should print your IG username and account info. If it does, Part A is done.

> Token lifecycle: the long-lived token lasts ~60 days. The n8n refresh workflow
> (built separately) re-exchanges it every ~45 days using META_APP_ID/SECRET and
> emails an alert if refresh fails. Until that workflow exists, re-run A3+A4 if
> publishing starts failing with auth errors.

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
