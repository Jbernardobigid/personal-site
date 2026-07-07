# Carousel Reframe Playbook — Phase 3.5 Step 1 (2026-07-07)

The structural pattern for the redesigned blog→carousel pipeline. Sources: the
account's own audit (`ig-audit-report.md`, 2026-06-11), the @aprendizdeciclista
external reference (spec'd in `infra/vps/phase-3.5-carousel-redesign.md`), and
copywriting/carousel-format research (no IG scrape — Jorge opted out of Apify).

## The device

**"Não é sobre X. É sobre Y."** — X is the mundane, painful, or dismissive
surface framing; Y is the identity-affirming deeper truth. It works as a
pattern interrupt (violates the expectation set by X) and lands as an identity
mirror: the reader doesn't learn something, they *recognize themselves*.

Proof on this account (N=1 but decisive): the 2026-04-24 carousel — "Tem pedal
que ninguém vê. Mas é ali que você se encontra." — did **2.3x reach, 12.5x
saves, 13x shares** vs the carousel baseline, with zero "Link na bio".

## What the account's own data says earns saves vs shares

- **Shares** go to identity statements people repost to speak *for them*
  ("Respeite o ciclista, nós só queremos voltar pra casa" — 250 shares).
  Second person or first-person-plural, declarative, no hedging.
- **Saves** go to content with a usable or re-readable core ("Comece mais
  devagar do que você imagina" — 163 saves). Something worth returning to.
- The failing carousels (black-identity avg 0 saves, technology 0.3) are
  third-person *analysis* — informative, nothing to screenshot, nothing that
  says "this is me".
- The reframe format targets both: each slide is a shareable line; the arc as
  a whole is the save.

## Slide architecture (6–8 slides)

| Slide | Role | Copy shape |
|---|---|---|
| 1 — Cover | Pattern interrupt. The X half alone, or the full reframe. | "Não é sobre {X}." — max ~8 words, no context, no explainer |
| 2 | Complete or deepen the flip | "É sobre {Y}." |
| 3–5/6 | One reframe beat per slide, escalating outer → inner (fact of life → what it costs → who you become) | 1–2 lines, 12–16 words max, second person, present tense |
| 7 — Recognition | The "this is me" trigger — the most screenshot-able slide | "Se você já viveu isso, sabe." register |
| 8 — CTA (baked in) | Share/save ask lives IN the slide art, not only the caption | "Envia pra quem precisa ler isso." / "Salva pra lembrar depois." |

Rules:
- **One idea per slide.** If a slide needs a subordinate clause, split it.
- **No statistics, no citations, no lecture register** inside the slides —
  that material stays in the blog/newsletter where it already performs.
- **No "Link na bio" anywhere in the slides.** The carousel's job is
  saves/shares, not clicks. The blog link stays in the bio and caption tail.

## Visual grammar

Borrowed structurally from @aprendizdeciclista (10 slides, art style rotates
per slide, text treatment constant, share-CTA in the final image):

- **Hold the text treatment constant** across all slides — same type scale,
  same box/overlay position rhythm — so swiping feels like one voice speaking.
- **Vary the canvas slide-to-slide** so the swipe has visual momentum:
  alternate background variants (navy ↔ cream), photo slides ↔ typographic
  slides. Never two identical canvases in a row.
- All inside Futuro Preto: existing gradient recipes, SVG grain, inset
  frame/corner brackets, Cormorant/Montserrat pairing. The *structure* is
  borrowed; the visual language is not.

## Caption pattern

- Open with the reframe restated in first person (Jorge's voice), 2–3 short
  paragraphs max.
- **One explicit comment-bait question** ("Qual foi a última vez que…?") —
  not rhetorical, answerable in one line.
- Blog link mention allowed here (tail), never in the slides.
- Tighter hashtags: 4–5 specific tags for the post's actual subject, not the
  generic pillar block.

## Editorial filter (Step 2 criteria — Jorge sanity-checks)

A post qualifies for a reframe carousel only if it passes ALL three:

1. **Flip test** — the core idea states cleanly as "Não é sobre X. É sobre
   Y." where Y affirms the reader's identity/dignity. If the flip has to be
   forced, fail.
2. **Recognition test** — the target follower sees *their own lived
   experience* in it ("se você já viveu isso, sabe"), not a topic they're
   learning about. Third-person analysis fails.
3. **Screenshot test** — at least one line someone would screenshot or DM to
   a friend. If every line is informational, fail.

Fails → the post falls back to a **single-image post** (existing single
templates), so the feed stays active every blog cycle. Approved by Jorge
2026-07-07, along with the three criteria as written.

## Measurement (Step 5)

Compare new-format carousels against the frozen baselines: CAROUSEL_ALBUM avg
(reach 313 / saved 0.8 / shares 3.1) and black-identity pillar (149 / 0 /
1.2). Existing `ig-insights.mjs` tooling; no new infra. The bet is confirmed
if reframe carousels consistently clear the format average on saves+shares.

## Research sources (web)

- [TrueFuture Media — Instagram Carousel Strategy 2026](https://www.truefuturemedia.com/articles/instagram-carousel-strategy-2026)
- [PostNitro — Guide to the Perfect Instagram Carousel Post in 2026](https://postnitro.ai/blog/post/instagram-carousel-post)
- [Slidy Creator — Instagram Carousel Trends in 2026](https://slidycreator.com/blog/instagram-carousel-trends/)
- [Buffer — Social Media Hooks: 6 Psychological Techniques](https://buffer.com/resources/social-media-hooks/)
- [Rob Palmer — Copywriting Hooks: 47 Proven Opening Lines](https://robpalmer.com/blog/copywriting-hooks)
- [Neal O'Grady — 10 Ways to Write Hooks](https://www.nealsnewsletter.com/p/10-ways-to-hook-people-with-examples)
