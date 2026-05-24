---
name: Jorge Bernardo
description: Personal brand portfolio — Afrofuturista · Editorial · Preciso
colors:
  charred-earth: "#1e1a14"
  ancestral-root: "#5e412d"
  terracotta-signal: "#a0714f"
  night-intelligence: "#1c314a"
  dark-green-terroso: "#273F29"
  cool-ash: "#d9d9d9"
  pure-white: "#ffffff"
typography:
  display:
    fontFamily: "'Noto Serif Display', Georgia, serif"
    fontSize: "clamp(3.25rem, 6.5vw, 5.75rem)"
    fontWeight: 900
    lineHeight: 0.9
    letterSpacing: "-0.042em"
  headline:
    fontFamily: "'Noto Serif Display', Georgia, serif"
    fontSize: "clamp(2.25rem, 4vw, 3.75rem)"
    fontWeight: 900
    lineHeight: 1.05
    letterSpacing: "-0.032em"
  body:
    fontFamily: "'Lora', Georgia, serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.82
    letterSpacing: "normal"
  label:
    fontFamily: "'DM Mono', monospace"
    fontSize: "0.6875rem"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.14em"
rounded:
  sharp: "1px"
  none: "0px"
spacing:
  xs: "12px"
  sm: "24px"
  md: "40px"
  lg: "72px"
  xl: "88px"
components:
  button-primary:
    backgroundColor: "{colors.ancestral-root}"
    textColor: "{colors.pure-white}"
    rounded: "{rounded.sharp}"
    padding: "18px 40px"
  button-primary-hover:
    backgroundColor: "{colors.terracotta-signal}"
    textColor: "{colors.pure-white}"
  button-cta:
    backgroundColor: "transparent"
    textColor: "{colors.terracotta-signal}"
    rounded: "{rounded.sharp}"
    padding: "8px 20px"
  button-cta-hover:
    backgroundColor: "{colors.ancestral-root}"
    textColor: "{colors.pure-white}"
  tag:
    backgroundColor: "transparent"
    textColor: "{colors.terracotta-signal}"
    rounded: "{rounded.sharp}"
    padding: "7px 16px"
---

# Design System: Jorge Bernardo

## 1. Overview

**Creative North Star: "The Quiet Resistance"**

This system operates on a principle borrowed from Jorge's own brand guide: *"não se explica, se posiciona."* It doesn't explain itself. Every element earns its place through presence, not decoration. The design vocabulary is dark, warm, and surgical — it lives at the intersection Jorge lives at: corporate authority and cultural resistance, ancestral depth and algorithmic precision. The moodboard anchors are MR. ROBOT, Neo-Noir, and Afrofuturismo — not as aesthetic costumes, but as structural references for how power can speak quietly.

The system rejects the temptation to signal. Nothing shouts cultural identity; the terracotta is a color pulled from real clothing worn on real cobblestones in Madrid, not a diversity indicator. The Noto Serif Display is a liturgical column, not a headline trick. The grain on every surface is a film texture, not a design trend. The sum of these choices says what a LinkedIn profile cannot: this person builds things that cannot be reduced to a category.

Warm but deliberate. Every transition breathes — not elastic, not bouncy — but with the warmth of something handmade. The system never animates to please; it moves when it has a reason to move.

**Key Characteristics:**
- Dark warm ground (`#1e1a14`) — charred earth, not default dark mode
- Terracotta as the one warm signal — used in ≤20% of any surface, its restraint is the point
- Typography that mixes vertical authority (display) with literary warmth (body)
- Near-zero radius everywhere — 1px, almost surgical
- Grain texture as the depth layer — no traditional box-shadows
- DM Mono for all operational metadata — section numbers, labels, timestamps, tags
- Entrance motion via GSAP — staggered reveals, never gratuitous

## 2. Colors: The "Futuro Preto" Palette

Five official colors from the brand guide (developed by Demidias Hub), plus two site-specific derivations. Use only these. The official palette is named "Futuro Preto" — translated to describe Jorge's pillars: Black sophistication, emotional intelligence, urban ancestrality, strategic innovation.

### Primary
- **Ancestral Root** (`#5e412d`): The primary accent. Terracota Profundo from the brand guide. "Raiz, densidade, sabedoria, presença ancestral." Used for: CTA button backgrounds, left-accent pseudo-elements on hover rows, scrollbar thumb, grain overlay color tint. Its rarity makes it a signal — never use it as a fill for large surfaces.
- **Terracotta Signal** (`#a0714f`): The lighter terracotta. A site-specific derivation of Ancestral Root — used wherever the primary is too heavy. Label text, link colors, hover state color for headings, border tints. This is the active/interactive state color for most UI.

### Secondary
- **Night Intelligence** (`#1c314a`): Azul Noite Refinado from the brand guide. "Estratégia, introspecção, inteligência, futuro." Used as an alternate surface in the Stats section. Carries the data-and-technology dimension of the brand without competing with the terracotta.
- **Dark Green Terroso** (`#273F29`): Verde Escuro Terroso from the brand guide. "Estabilidade, regeneração, inteligência emocional." Currently unused on the site — reserved for future surfaces where ancestral depth without terracotta warmth is needed.

### Neutral
- **Charred Earth** (`#1e1a14`): Site-specific derivation of Preto Absoluto. The page background. Warm near-black — not `#000000`, which is too cold. The warmth is load-bearing: it makes the terracotta feel like it belongs.
- **Pure White** (`#ffffff`): Primary text on dark surfaces. Headlines, body text at full opacity.
- **Cool Ash** (`#d9d9d9`): Neutro Urbano from the brand guide. Secondary text — article descriptions, supporting copy. Never used as a background.
- **Mid White** (`rgba(255,255,255,0.45)`): Body text at reduced emphasis — career descriptions, about body, cycling narrative. Not a separate color token but a recurring opacity pattern.
- **Border Subtle** (`rgba(255,255,255,0.09)`): Section dividers, form field underlines, table borders. Barely visible.
- **Border Terra** (`rgba(160,113,79,0.25)`): Warm-tinted dividers used wherever a border carries brand identity — tag outlines, CTA borders, contact link underlines.

### Named Rules

**The One Signal Rule.** Terracotta (both `ancestral-root` and `terracotta-signal`) appears on ≤20% of any given surface. Its scarcity is the entire point. A screen that is predominantly terracotta has failed.

**The No Invented Colors Rule.** Use only the Futuro Preto palette. If a design requires a new color, it is a sign the design is wrong — not that the palette needs expanding. The brand guide is explicit: "Não use cores que não estão incluídas na paleta oficial."

**The Dark Green Reserve Rule.** `#273F29` is in the palette but not yet deployed. When a future section needs to convey ancestral stability without terracotta warmth — use it. Do not import it casually; it requires the same intentionality as every other color.

## 3. Typography

**Display Font:** Noto Serif Display Extra Condensed (Google Fonts), with Georgia, serif as fallback
**Body Font:** Lora (Google Fonts), with Georgia, serif as fallback
**Label / Mono Font:** DM Mono (Google Fonts), with monospace as fallback

**Character:** The pairing was deliberately specified in the personal brand guide. Noto Serif Display Extra Condensed was chosen for "presença vertical, imponente e refinada" — near-liturgical authority, columns that hold weight. Lora was chosen as "contraponto emocional e intelectual" — the voice that listens, builds bridges, carries narrative. DM Mono is the site's operational layer, unspecified by the brand guide but consistent with its neo-noir / techwear moodboard.

### Hierarchy

- **Display** (900, `clamp(3.25rem, 6.5vw, 5.75rem)`, line-height 0.9, letter-spacing −0.042em): Hero name, landmark cycling heading. Tight, uppercase, massive. Occupies space without apology. Used once per major section at most.
- **Headline** (900/300 italic mix, `clamp(2.25rem, 4vw, 3.75rem)`, line-height 1.05, letter-spacing −0.032em): Section headings. The pattern is bold uppercase + italic light for the em phrase — "Uma visão. *Muitas frentes.*" The italic light (`font-weight: 300`) carries the poetic dimension; the 900 carries the declaration.
- **Title** (700, `clamp(1.375rem, 2.2vw, 2rem)`, line-height 1.15, letter-spacing −0.02em): Role names in career rows, project names, contact link labels. Display family, but conversational scale.
- **Body** (400/500, `1.0625rem`–`1.125rem`, line-height 1.72–1.85): All narrative prose. Lora. Max line length 65ch where possible. Featured body (hero intro) runs larger: `clamp(1.375rem, 2.2vw, 1.875rem)`.
- **Label** (400, `0.625rem`–`0.6875rem`, letter-spacing 0.12–0.18em, uppercase): DM Mono. Section numbers (— 01, — 02), nav links, tag text, timestamps, eyebrows, metadata. The system's operational layer. Never longer than ~40 characters.

### Named Rules

**The Italic Contrast Rule.** Within display and headline type, `font-style: italic` combined with `font-weight: 300` signals the poetic or human dimension of a phrase. The bold-uppercase carries the declaration; the italic carries the qualification. Never italicize at 900 weight — it undermines both.

**The No-Scale Collapse Rule.** Headings use fluid `clamp()` between a floor and ceiling. Never set a heading at a fixed px value — it collapses at viewport edges. The ratio between display and body is ≥2.5× at all sizes.

**The Mono Label Ceiling Rule.** DM Mono labels never exceed 11px / 0.6875rem. Above that size, the mono character reads as code, not operational metadata. For larger mono text, reconsider whether it should be mono at all.

## 4. Elevation

This system is flat-by-default. Depth comes from three sources: tonal layering (dark surface variants), opacity stacking (rgba overlays), and the SVG fractal grain texture applied globally at 2.5% opacity. There are no traditional `box-shadow` declarations anywhere in the codebase — this is a deliberate architectural decision consistent with the Neo-Noir / MR. ROBOT moodboard, where surfaces are dense and textural rather than lifted and floated.

### Elevation Vocabulary

- **Ground layer** (`#1e1a14`): The page surface. Everything sits on this.
- **Alternate surface** (`#1c314a`, Night Intelligence): The Stats section. A tonal shift, not a shadow. Signals a change in register — data, numbers, system-level content.
- **Hover tint** (`rgba(94,65,45,0.08)`): Applied to career rows and other interactive rows on hover. A barely-visible terracotta wash that says "this is active" without lifting.
- **Nav elevated state** (`rgba(0,0,0,0.85)` + `backdrop-filter: blur(12px)`): The only component that reads as physically above the page. Applied on scroll. This is the system's one "floating" layer.
- **Grain texture** (`SVG fractalNoise`, 2.5% opacity, fixed): The atmospheric depth layer. Applied to `body::after` with `position: fixed`. Creates film-like texture across all surfaces without altering any color.

### Named Rules

**The No-Shadow Rule.** Do not add `box-shadow` to components. If a component needs depth, use tonal background variants, border treatments, or the grain layer. A box-shadow in this system reads as a design error, not a design choice.

**The One Float Rule.** The scrolled nav is the only component with `backdrop-filter: blur`. Adding blur to cards, modals, or sections introduces glassmorphism — which is on the shared absolute ban list. One float, no glass.

## 5. Components

### Buttons

Sharp-edged, mono-typed, uppercase — every button in this system reads as a controlled action, not an invitation.

- **Shape:** Near-zero radius (1px). Not zero — zero reads as a CSS oversight. 1px says intentional.
- **Primary** (form submit): `background: #5e412d` (Ancestral Root), `color: #ffffff`, DM Mono 11px, `letter-spacing: 0.16em`, `text-transform: uppercase`, `padding: 18px 40px`. Contains a `→` arrow that gains `gap` on hover.
- **Primary hover:** `background: #a0714f` (Terracotta Signal), gap increases 2px. Transition `0.25s ease`.
- **CTA / Ghost** (nav and back links): `background: transparent`, `color: #a0714f`, `border: 1px solid rgba(160,113,79,0.25)`, same mono/uppercase spec, `padding: 8px 20px`.
- **CTA hover:** `background: #5e412d`, `color: #ffffff`, border shifts to match.
- **Disabled:** `opacity: 0.5`. No state change beyond opacity.

### Tags / Chips

- **Style:** Transparent background, `color: #a0714f`, `border: 1px solid rgba(160,113,79,0.25)`, `border-radius: 1px`, DM Mono 10px, `letter-spacing: 0.14em`, uppercase, `padding: 7px 16px`.
- **Hover (hero tags):** `background: #5e412d`, `color: #ffffff`. Same warm fill as primary button hover — the system is consistent.
- **Passive (lang pills):** Same spec, no hover state. Used for informational classification, not action.

### Cards / Containers

Cards are not used in this system. The **list row** is the canonical container pattern — a full-width horizontal entry with a bottom border divider, hover tint, and left-accent pseudo-element.

- **Career row:** `border-bottom: 1px solid rgba(255,255,255,0.09)`. Hover: `background: rgba(94,65,45,0.08)`, left `::before` pseudo grows to `width: 3px` in `#a0714f`. Transition: `0.35s cubic-bezier(.25,.46,.45,.94)`.
- **Work item (link row):** `border-bottom: 1px solid rgba(255,255,255,0.09)`. Hover: bottom `::before` pseudo expands `width: 0 → 100%` in `#a0714f`. No background tint — the underline alone signals the interaction.

**The No-Card Rule.** Do not introduce card components with border, background, shadow, and radius. This system uses row lists, photo panels, and full-bleed sections. A card grid is the primary anti-reference aesthetic (Generic SaaS Portfolio).

### Inputs / Fields

- **Style:** No background, no surrounding border. Bottom border only: `border-bottom: 1px solid rgba(255,255,255,0.09)`. `padding: 12px 0`. Lora font, 16px, `color: #ffffff`.
- **Placeholder:** `color: rgba(255,255,255,0.18)`, italic.
- **Focus:** `border-color: #a0714f` (Terracotta Signal). No glow, no box-shadow. The color shift is the entire focus indicator.
- **Invalid:** `border-color: #c0392b`. Same underline mechanic.
- **Textarea:** Same spec, `resize: none`, fixed height 120px.

### Navigation

- **Default state:** Fixed, `height: 64px`, fully transparent background, no border. The page content is visible beneath.
- **Scrolled state:** `background: rgba(0,0,0,0.85)`, `border-bottom: 1px solid rgba(255,255,255,0.09)`, `backdrop-filter: blur(12px)`. Transition `0.4s ease`.
- **Nav links:** DM Mono 11px, 0.12em tracking, uppercase. `opacity: 0.4` default, `opacity: 1` hover. Underline `::after` pseudo in `#a0714f` expands on hover via `transform: scaleX(0 → 1)`.
- **Mobile drawer:** Full-screen overlay on `#1e1a14`. Links scale to `clamp(32px, 8vw, 64px)` Noto Serif Display 900. The drawer inverts the system — display type for navigation.

### Signature Component: Custom Cursor

- **Cursor dot:** 5px circle, `background: #a0714f`. Follows mouse position, `position: fixed`, `will-change: left, top`.
- **Cursor ring:** 34px circle, `border: 1px solid rgba(160,113,79,0.6)`. Lags slightly behind the dot — not via animation delay, but via JS interpolation.
- **Hovering state:** Ring expands to 56px, `border-color: #a0714f`, faint background tint `rgba(160,113,79,0.05)`.
- **Clicking state:** Ring contracts to 24px, `background: rgba(160,113,79,0.2)`.
- **On touch devices:** Cursor is hidden (`cursor: none` only on `hover: hover` and `pointer: fine` media query).

## 6. Do's and Don'ts

### Do:
- **Do** use only the five official Futuro Preto colors plus their site derivations. The brand guide is explicit: "Não use cores que não estão incluídas na paleta oficial."
- **Do** use `#1e1a14` as the page background — warm near-black, not `#000000` or `#0d0d0d`. The warmth makes the terracotta feel rooted, not pasted.
- **Do** use Noto Serif Display for all titles, headings, and display type. It was chosen for this identity specifically — "autoridade silenciosa, ideal para alguém que não se explica, se posiciona."
- **Do** keep border-radius at 1px everywhere. Rounding a button or card softens it in ways that contradict the brand voice.
- **Do** mix Noto Serif bold + italic-light for headings. The pattern "DECLARATION. *qualifier.*" is the typographic voice of this brand — use it.
- **Do** apply the SVG grain texture (`body::after`, `opacity: 0.025`, `position: fixed`) to any new full-page surface. Without it, the surface reads as flat modern dark mode, not this brand.
- **Do** use DM Mono for all labels, metadata, section numbers, tags, timestamps, and operational UI. It is the system's operational voice.
- **Do** use `clamp()` for all heading sizes. Never fixed px for headings.
- **Do** check `brand_assets/` before writing any `<img>` placeholder. A large professional photo library exists — use it.
- **Do** keep transitions warm but deliberate: `0.2s–0.4s ease` for state changes, `0.35s cubic-bezier(.25,.46,.45,.94)` for motion with character.

### Don't:
- **Don't** use `box-shadow` anywhere. Depth is grain + tonal layering. A shadow in this system is a design error.
- **Don't** add `backdrop-filter: blur` to any component except the scrolled nav. One float, no glass. Glassmorphism is on the absolute ban list.
- **Don't** build card grids. No border + background + shadow + radius card components. The system uses row lists and full-bleed sections — never uniform card grids.
- **Don't** make the site look like a Generic SaaS Portfolio (navy + white, feature list, CTA grid, Notion/Linear aesthetic). This is the primary anti-reference.
- **Don't** make it look like a LinkedIn-style resume — timeline-heavy, credential-first, corporate. Signals conformity, not vision.
- **Don't** use terracotta as a fill for large surfaces. Its rarity is its power. If a surface is predominantly terracotta, the system has failed.
- **Don't** import DePretoPraPreto's visual language (hot pink, electric blue, bold yellow, Adinkra symbols used decoratively) into the personal brand. They are deliberately distinct identities. The two gain authority by being different.
- **Don't** use `transition-all`. Specify exactly which properties transition.
- **Don't** use the default Tailwind palette (indigo-500, blue-600, etc.) as filler — these are specifically excluded by the brand guide.
- **Don't** add new fonts. The three-family system (Noto Serif Display + Lora + DM Mono) is specified by the brand identity document and complete.
- **Don't** use `gradient-text` (`background-clip: text`). Decorative, never meaningful. Absolute ban.
- **Don't** add `border-left` greater than 1px as a colored stripe on cards or callouts. Side-stripe borders are on the absolute ban list. Use the row hover pattern instead (background tint + left pseudo-element at exact 3px).
- **Don't** center-stack everything. Left-aligned asymmetric layouts are the system's default composition. A centered hero with icon-title-subtitle cards is a template, not a design.
