# jorgebernardo.tech — personal site + content engine

Personal site for Jorge Bernardo (Sr. Technical Trainer at BigID, founder of DePretoPraPreto and afterALL), plus the automation pipelines that turn the site's blog into Instagram carousels, Reels-style videos, and LinkedIn posts.

Live site: <https://jorgebernardo.tech> (deployed on Vercel, served from the repo root).

## The site

- Single-page editorial portfolio in [index.html](index.html) — Portuguese (pt-BR), dark terracotta palette, hand-written HTML/CSS (no framework, no Tailwind).
- Fonts: Noto Serif Display (display) · Lora (body) · DM Mono (accents).
- Motion: GSAP 3 + ScrollTrigger from cdnjs (the CSP in [vercel.json](vercel.json) only allows cdnjs/unpkg).
- Contact form via Formspree; analytics via Vercel Web Analytics + Speed Insights.
- Blog lives in [blog/](blog/) — posts are **auto-generated** (see pipeline below), don't hand-edit them.
- Brand identity (palette "Futuro Preto", typography, logo system, photography library) is documented in [docs/PRODUCT.md](docs/PRODUCT.md) and [docs/DESIGN.md](docs/DESIGN.md); assets live in `brand_assets/`.

## Content pipelines

All pipelines are plain Node scripts (`node <script>.mjs`), with secrets in a local `.env` loaded by [load-env.mjs](load-env.mjs). Deterministic logic lives in code; n8n and GitHub Actions only trigger it.

### Blog (fully automated)

[.github/workflows/blog-post.yml](.github/workflows/blog-post.yml) runs every 2 days at 09:00 UTC:

1. [signals.mjs](signals.mjs) picks a fresh news "signal" from Afro-Brazilian press RSS + Google News feeds ([signal-sources.json](signal-sources.json)), with a Claude safety/quality check and a pillar-balance guardrail across 7 topic pillars.
2. [research.mjs](research.mjs) runs Tavily web research and synthesizes citation-backed notes with OpenAI.
3. [generate-post.mjs](generate-post.mjs) writes the post with Claude, generates an OG image (gpt-image-2 via [generate-image.mjs](generate-image.mjs)), updates `blog/index.html`, `sitemap.xml`, and `robots.txt`, and commits.
4. [post-to-linkedin.mjs](post-to-linkedin.mjs) publishes the post to LinkedIn using `post-meta.json`.

Manual/local: `npm run blog:generate:live` (with signals), `npm run blog:dry-run`, `npm run signals:fetch` ([fetch-signals.mjs](fetch-signals.mjs)).

### Instagram carousels

1. [agent-templates.mjs](agent-templates.mjs) — regenerates the 1080×1080 HTML templates in [templates/html/](templates/html/) from the canonical Canva brand designs (Canva export → Claude vision → HTML/CSS).
2. [generate-carousel.mjs](generate-carousel.mjs) — reads the latest blog post, picks format + templates, renders slides with Puppeteer into `carousels/{date}-{slug}/`, writes `caption.txt`.
3. [prepare-carousel.mjs](prepare-carousel.mjs) — n8n orchestrator: build from latest post, upload slides to Vercel Blob, email the links + caption.

### Instagram publishing (Graph API + Notion approval queue)

Setup guide: [docs/setup-meta-and-notion.md](docs/setup-meta-and-notion.md) · one-time token helper: [setup-instagram-token.mjs](setup-instagram-token.mjs).

- [post-to-instagram.mjs](post-to-instagram.mjs) — `check` / `stage` / `publish-carousel` / `publish-reel`. Media is staged into [social/](social/), committed, and served publicly by Vercel (the Graph API requires public URLs). Supports both Facebook-login and Instagram-login API flavors via `INSTAGRAM_API_BASE`.
- [queue-to-notion.mjs](queue-to-notion.mjs) — stages each new carousel and creates a Draft card in the Notion IG Pipeline database (idempotent via `ig-queue-state.json`).
- [publish-approved.mjs](publish-approved.mjs) — polled by n8n; publishes cards marked "Approved For Publishing" and marks them Published.
- [refresh-ig-token.mjs](refresh-ig-token.mjs) — refreshes the long-lived IG token (~every 45 days via n8n), alerts by email on failure.
- [ig-insights.mjs](ig-insights.mjs) — weekly metrics (IG reach/followers + Resend subscribers) → Notion IG Metrics DB + `metrics-history.json` + email digest.
- [ig-audit.mjs](ig-audit.mjs) — re-runnable historical per-post audit → `ig-audit-report.{json,md}`.
- [notion-api.mjs](notion-api.mjs) — shared minimal Notion REST helper.

### Educational videos (Reels format)

- [generate-video.mjs](generate-video.mjs) — blog post (or a `--topic-file` cycling concept) → ~45–55s 9:16 video: Claude script (5 scenes), ElevenLabs voice-clone voiceover (shared [tts.mjs](tts.mjs)), typographic b-roll by default (image/mixed/real/KIE modes behind flags), Puppeteer kinetic-text layers ([templates/video/](templates/video/)), ffmpeg compositing, Whisper word-level karaoke captions, music bed ([assets/music/](assets/music/)). Output: `videos/{date}-{slug}/video.mp4`.
  - The per-scene TTS calls are **stitched** (each conditioned on the neighbouring narration + prior request IDs) so the read builds across the 5 scenes instead of restarting flat on each one. Scenes stay separate files — per-scene durations drive the video timing.
  - Voice A/B: every run saves the exact spoken text to `script.json`; `--script-file <json>` replays it verbatim so two voice settings can be compared on identical narration. `--no-stitch` renders the pre-stitching read, `--keep-audio` keeps the bare VO (the final mix buries it under captions + music), `--out-suffix` disambiguates output dirs.
- [prepare-video.mjs](prepare-video.mjs) — n8n orchestrator: build (or reuse latest), upload to Vercel Blob, create a **Draft Reel card** in the Notion IG Pipeline — the same approval surface carousels use; [publish-approved.mjs](publish-approved.mjs) publishes it once approved. Flags: `--cycling` (Phase 4 topic-driven Reel, no blog post), `--skip-generate`, `--dry-run`, `--force`, b-roll mode passthroughs.

### Podcast — "A Interseção" (blog → audio)

- [generate-audio-post.mjs](generate-audio-post.mjs) — narrates a blog post with the ElevenLabs voice clone: Claude adapts the written essay into a spoken pt-BR script (full essay, not a summary), shared [tts.mjs](tts.mjs) fixes orthography/units and synthesizes one MP3, uploaded to Vercel Blob at `podcast/{slug}.mp3`. Appends [podcast-episodes.json](podcast-episodes.json) (script-owned ledger), regenerates [podcast.xml](podcast.xml) (RSS 2.0 + itunes tags), and injects a branded `<audio>` player into the post HTML. `npm run audio:generate` (latest post) / `npm run audio:dry-run` / explicit post path to backfill / `--force` to regenerate. Posts whose script exceeds `AUDIO_MAX_CHARS` (default 9000) are skipped, never truncated; `AUDIO_TTS_MODEL=eleven_flash_v2_5` is the cheap escape hatch.
- Runs as the **last** step of the VPS blog workflow (after LinkedIn), so an audio failure can never block the post. The GitHub Actions workflow is break-glass only and ships posts **without** audio — catch up afterwards with a single manual `node generate-audio-post.mjs` run (it targets the latest post and injects the player into the existing HTML).
- **Launch checklist (one-time, manual):** ① Spotify for Creators → "Add your podcast" → `https://www.jorgebernardo.tech/podcast.xml` → verify via code emailed to the `itunes:owner` address. ② Apple Podcasts Connect → same feed URL. Both then auto-publish every new episode from the feed. Cover art: [podcast-cover.jpg](podcast-cover.jpg) (3000×3000).

## Dev tooling

| Command | What it does |
|---|---|
| `node serve.mjs` | Dev server at `http://localhost:3000` (blocks `.env` and pipeline meta files) |
| `node screenshot.mjs <url> [label]` | Puppeteer screenshot → `temporary screenshots/screenshot-N[-label].png` |
| `node overflow-check.mjs [url] [width]` | Detects horizontal-overflow culprits at a given viewport width |
| `node build-montages.mjs` | Contact-sheet montages of `brand_assets/Fotos` for the photo inventory |
| `node remove-bg.mjs <in> <out>` | Edge flood-fill background removal for logos |

All npm script aliases are in [package.json](package.json) (`blog:*`, `signals:fetch`, `carousel:*`, `video:*`, `templates:*`, `ig:*`).

## Directory map

```
index.html            The site (single page, pt-BR)
blog/                 Auto-generated posts + index
api/subscribe.js      Vercel serverless function — newsletter signup (Resend audience)
brand_assets/         Logos, brand guide pages, photo library (see Fotos/INVENTORY.md)
docs/                 PRODUCT.md (brand bible) · DESIGN.md · setup-meta-and-notion.md
templates/            html/ carousel slide templates · video/ scene template
carousels/            Rendered carousel output (per post)
videos/               Rendered video output (per post)
social/               Staging for IG media — public via Vercel, deletable after publish
signals/              Cached signal runs · used-signals.json is the dedupe ledger
jorge_ai_reels_clone_studio/  Reels content engine: strategy, calendar, workflows
brainstorms/          Planning docs (e.g. content-stack growth plan)
infra/                oci-retry-launch.ps1 (Oracle Cloud VPS launch retry)
```

State files at the root (`post-meta.json`, `carousel-meta.json`, `*-prepared.json`, `ig-queue-state.json`, `used-signals.json`, `metrics-history.json`) are pipeline ledgers — scripts own them; don't edit by hand.

## Environment

Secrets live in a local `.env` (never committed; GitHub Actions uses repo secrets). Main keys:

`ANTHROPIC_API_KEY` · `OPENAI_API_KEY` · `TAVILY_API_KEY` · `RESEND_API_KEY` / `RESEND_AUDIENCE_ID` · `NOTION_API_KEY` / `NOTION_IG_DB_ID` / `NOTION_METRICS_DB_ID` · `INSTAGRAM_ACCESS_TOKEN` / `INSTAGRAM_USER_ID` / `INSTAGRAM_API_BASE` · `LINKEDIN_ACCESS_TOKEN` · `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` · `BLOB_READ_WRITE_TOKEN` · `KIE_API_KEY` (+ `KIE_BROLL_MODEL`, `KIE_BROLL_RES`) · `SITE_URL` · `CAROUSEL_NOTIFY_EMAIL`

Run `node post-to-instagram.mjs check` to verify the IG credentials.
