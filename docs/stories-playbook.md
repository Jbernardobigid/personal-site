# Stories Playbook — Real-Life BTS → Blog/Newsletter/Podcast Funnel

Stories are greenfield on this account: no auto-publisher exists (`post-to-instagram.mjs`
only handles `IMAGE`/`CAROUSEL`/`REELS` media types — see §"Out of scope" below), and the
format itself resists automation — the entire value of a Story is that it reads as
unproduced, in-the-moment, and *today*. This is a manual playbook, not a pipeline.

**Why Stories at all:** the audience-simulation report (`docs/audience-simulation-report.md`)
and the account's real data agree that the highest-pull content is humor/relatable, history,
mind (reflection/mentality), and community — exactly the register Stories are best at,
because they don't need production. Feed posts (Reels/carousels) carry the polished,
plotted version of a subject; Stories carry the raw, daily proof that the subject is real
and lived, and they're the only surface where a direct link sticker can push someone to the
blog, the newsletter, or the podcast without cluttering a caption.

## Cadence

- **3-5 Stories per week**, tied to whatever is actually happening (a ride, a work day, a
  moment of doubt or a small win) — never manufactured for the sake of posting.
- **Pair with feed days when possible**: if Tuesday/Wednesday/Friday is a blog+carousel+Reel
  day (see the cron in `.github/workflows/blog-post.yml`), a same-day Story teasing that
  post's subject compounds reach instead of competing with it.
- **One BTS moment is enough.** 1-3 Story frames beats a 10-frame sequence — the account's
  own data rewards concreteness over volume everywhere else, and Stories are no exception.

## The four Story shapes

Pick whichever matches what's actually happening that day — don't force a shape onto a day
that doesn't have it.

| Shape | What it looks like | Best paired with |
|---|---|---|
| **Raw ride moment** | One clip/photo from mid-ride, unedited, caption sticker only | pov-ride, race-recap, data (Strava screenshot) |
| **Work/life crossover** | The tech-day → bike-afternoon split, shown not explained | bts-vlog, mind |
| **Unfiltered reflection** | Talking-to-camera or text-on-photo, right after a hard ride or a hard day | mind, transformation |
| **Group/community beat** | Café stop, rachão gathering, pre-ride banter | community, humor |

## Blog-subject teaser templates

Use these the morning a blog post publishes (09:00 BRT per the cron), or the evening before,
to seed curiosity before the carousel/Reel land:

1. **The unfinished thought** — post a single line from the subject without the resolution,
   sticker: "amanhã no blog ↗" or a direct link sticker to the post once it's live.
   > "Hoje percebi uma coisa no meio da subida que mudou como eu penso sobre treino. Vou
   > escrever sobre isso."
2. **The visual anchor** — a photo/clip of the moment that inspired the post, text overlay
   naming the tension, not the answer.
   > "Essa placa no meio do pedal não saiu da minha cabeça. Post novo saindo."
3. **The direct pull** — once the post is live, one Story with the link sticker and a single
   sentence, no re-explaining the whole post.
   > "Escrevi sobre isso hoje. Link pra ler completo 👆"

## CTA copy blocks (the three funnels)

Rotate — never stack more than one funnel ask per Story sequence. Matches the rotation logic
now in `generate-carousel.mjs` / `generate-video.mjs` captions (see `CROSS_CHANNEL_CTAS`).

**→ Blog** (link sticker to the post URL)
- "Leia o post completo 👆"
- "Escrevi sobre isso hoje. Link aqui em cima."
- "Se você já viveu isso, tem mais no blog 👆"

**→ Newsletter "A Interseção"** (link sticker to the newsletter signup/latest issue)
- "Toda semana eu escrevo sobre isso na newsletter. Link 👆"
- "Assina a Interseção pra não perder o próximo texto 👆"
- "Isso vira newsletter no domingo. Se inscreve 👆"

**→ Podcast** (link sticker to the podcast page / episode)
- "Tem episódio novo do podcast sobre isso. Link 👆"
- "Fala mais sobre isso no podcast, ouve no caminho do trabalho 👆"
- "Gravei um episódio inteiro sobre esse assunto 🎧 link 👆"

## Link-sticker guidance

- Instagram's native **link sticker** on Stories is the only mechanism needed — no swipe-up
  legacy flow, no linktree. Point it at the exact URL (blog post / newsletter page / podcast
  page), not the homepage.
- Keep sticker placement in the lower third, away from faces or key visual content.
- Don't put a link sticker on every frame of a multi-frame Story — one clear ask per sequence
  is enough; more reads as spam and IG's own delivery tends to suppress link-heavy Stories.

## Out of scope (v1)

Full `media_type: 'STORIES'` auto-publishing in `post-to-instagram.mjs` — plausible future
work (the Graph API supports it), but Stories' entire value here is being unproduced and
same-day, which cuts against the batch-and-approve rhythm the rest of the pipeline uses
(Notion queue → VPS poller). This playbook assumes Jorge posts Stories directly from his
phone.
