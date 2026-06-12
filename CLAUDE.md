# CLAUDE.md — jorgebernardo.tech

## What This Repo Is

Two things live here — see [README.md](README.md) for the full map:

1. **The site** — [index.html](index.html), a single-page pt-BR editorial portfolio. Hand-written HTML/CSS (no framework, **no Tailwind** — the CSP in `vercel.json` doesn't allow it), GSAP 3 + ScrollTrigger for motion, deployed on Vercel.
2. **The content engine** — Node scripts (`*.mjs`) that generate blog posts (GitHub Actions cron), Instagram carousels, educational videos, and publish to Instagram/LinkedIn through a Notion approval queue. Secrets in local `.env` via `load-env.mjs`.

## Always Do First
- **Invoke the `frontend-design` skill** before writing any frontend code, every session, no exceptions.
- Read [docs/PRODUCT.md](docs/PRODUCT.md) before any design decision — it is the brand bible (palette, typography, logo rules, photography, anti-references).

## Brand System (fixed — do not invent)
- **Palette "Futuro Preto":** Terracota `#5e412d`, Preto `#000000`, Azul Noite `#1c314a`, Verde Escuro `#273F29`, Neutro `#D9D9D9`. Site derivations in use: base background `#1e1a14`, light terracotta accent `#a0714f`. No colors outside the palette.
- **Typography:** Noto Serif Display (display/headings) + Lora (body) + DM Mono (accents). Do not substitute or use a single font for everything.
- **Assets:** Always check `brand_assets/` before designing — logos, brand guide pages, and a large photo library (start at `brand_assets/Fotos/INVENTORY.md`). Use real assets, not placeholders, when they exist.
- DePretoPraPreto has its own loud visual identity — never import it into the personal site.

## Local Server
- **Always serve on localhost** — never screenshot a `file:///` URL.
- Start the dev server: `node serve.mjs` (serves the project root at `http://localhost:3000`)
- If the server is already running, do not start a second instance.

## Screenshot Workflow
- Puppeteer is installed in `node_modules/`. Chrome cache is at `C:/Users/Jorge Bernardo/.cache/puppeteer/chrome/win64-148.0.7778.167/chrome-win64/chrome.exe`. If not found, install it and cache it following the same folder structure.
- **Always screenshot from localhost:** `node screenshot.mjs http://localhost:3000`
- Screenshots save to `./temporary screenshots/screenshot-N.png` (auto-incremented). Optional label: `node screenshot.mjs <url> label` → `screenshot-N-label.png`.
- After screenshotting, read the PNG with the Read tool and analyze it.
- When comparing, be specific: "heading is 32px but reference shows ~24px", "card gap is 16px but should be 24px".
- Check: spacing/padding, font size/weight/line-height, colors (exact hex), alignment, border-radius, shadows, image sizing.
- For mobile horizontal-scroll bugs: `node overflow-check.mjs http://localhost:3000 375` pinpoints overflowing elements.

## Reference Images
- If a reference image is provided: match layout, spacing, typography, and color exactly. Do not improve or add to the design.
- If no reference image: design from scratch with high craft, within the brand system above.
- Screenshot your output, compare against reference, fix mismatches, re-screenshot. At least 2 comparison rounds. Stop only when no visible differences remain or the user says so.

## Content Pipelines — rules of engagement
- **Blog posts are auto-generated** (`generate-post.mjs`, cron in `.github/workflows/blog-post.yml`). Never hand-write or hand-edit a post — fix the generator and regenerate.
- Carousel templates in `templates/html/` are generated from Canva by `agent-templates.mjs` — regenerate rather than hand-tweaking, unless making a deliberate local fix.
- Root JSON state files (`post-meta.json`, `carousel-meta.json`, `*-prepared.json`, `ig-queue-state.json`, `used-signals.json`, `metrics-history.json`) are pipeline ledgers owned by the scripts — don't edit by hand.
- `social/` is the IG media staging area (must be committed/pushed so Vercel serves public URLs). Folders are deletable after the post is live. Store nothing else there.
- `.env` holds all secrets and is never committed. GitHub Actions uses repo secrets.
- n8n only triggers the orchestrators (`prepare-carousel.mjs`, `prepare-video.mjs`, `publish-approved.mjs`, `refresh-ig-token.mjs`) — keep deterministic logic in the scripts, not in n8n.

## Anti-Generic Guardrails
- **Colors:** Only the brand palette. Never generic framework defaults (indigo/blue).
- **Shadows:** Never flat one-liner shadows. Use layered, color-tinted shadows with low opacity.
- **Typography:** Tight tracking (`-0.03em`) on large headings, generous line-height (`1.7`) on body. Display serif for headings, Lora for body — never one font for both.
- **Gradients:** Layer multiple radial gradients. Add grain/texture via SVG noise filter for depth.
- **Animations:** Only animate `transform` and `opacity`. Never `transition-all`. Use spring-style easing.
- **Interactive states:** Every clickable element needs hover, focus-visible, and active states. No exceptions.
- **Images:** Add a gradient overlay (`bg-gradient-to-t from-black/60` equivalent) and a color treatment layer with `mix-blend-multiply`.
- **Spacing:** Intentional, consistent spacing tokens — not arbitrary steps.
- **Depth:** Surfaces have a layering system (base → elevated → floating), not all at the same z-plane.

## Hard Rules
- Do not add sections, features, or content not in the reference
- Do not "improve" a reference design — match it
- Do not stop after one screenshot pass
- Do not use `transition-all`
- Do not introduce Tailwind or any CSS framework — the site is hand-written CSS and the CSP would block the CDN anyway
- Do not use colors outside the "Futuro Preto" palette
