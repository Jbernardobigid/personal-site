# LinkedIn series: #EsportesNoLinkedIn

Started 2026-11-13, after the LinkedIn editorial workshop at the LinkedIn office (sports cohort, community manager Luiz Gustavo). Goal: LinkedIn Top Voice within 6 to 9 months.

## Launch log

- **2026-11-13**: series built. The first post (text, LA bike lanes and Latino workers) was published the same day at 11:36 BRT on Jorge's call: https://www.linkedin.com/feed/update/urn:li:share:7527016639092105216/
- **Queue after it:** photo (Tue 11/17), document/PDF carousel (Thu 11/19), video (Reel), photos, ai-image, then back to text.
- **Not yet proven live:** the REST post paths (document, photos, video). Their uploads work; the first post of each is the real test.
- **LinkedIn token expires ~2027-01-12.** Renew it at linkedin.com/developers/tools/oauth/token-generator (app JorgeEscreve; scopes openid, profile, w_member_social). Put it in `.env` directly, not in chat, then sync it to the VPS.
- **2026-11-17**: second post (photo, Cape Town) published by the scheduled 08:30 run, the first with no manual step: https://www.linkedin.com/feed/update/urn:li:share:7528419190656069633/
- **Luiz Gustavo's answer (2026-11-18)**: LinkedIn's sports curation looks for "conversas que valem ser destacadas": good content with relevant information. They watch the hashtag broadly; there is **no editorial calendar**, and whatever stands out appears in the curation. Takeaways: the comment thread is part of what gets curated, so reply fast and keep the closing question specific. #EsportesNoLinkedIn is how they find posts, so it stays first on every post. Follow the hashtag to see what gets featured, and do the daily commenting there.
- **2026-11-19: beat corrected to sport.** Two of the first three posts were urban mobility (LA bike lanes; Santos e-bike fines, tagged #MobilidadeUrbana #BicicletaEletrica). Jorge: sports only, mostly cycling, the niche that affects Black people, and not always about racism, the fight against it, or being a minority in sport: it can be more than that. Changes: the `access-equity` lens and its Ciclocidade / Observatório da Bicicleta feeds are gone; transport titles are dropped in code (`OFF_BEAT` in the beacon); mobility hashtags are stripped from the post; the screener tags each story's theme `identity` (about racism, representation, being a minority) or `sport` (everything else, including Black athletes when their identity is not the subject); identity stories get at most one post in three (`IDENTITY_EVERY`); a `ciclismo` fallback lens lets substantive tier-1 cycling stories with no identity keyword reach the screener; a lower-weight `black-athletes` lens covers other sports, which never outrank cycling.
- **2026-11-19: first REST post live** (document, Santos): https://www.linkedin.com/feed/update/urn:li:ugcPost:7529143964306710528/ . The post worked; its first comment got a 404 from v2 socialActions (legacy `urn:li:share` posts comment fine). `postComment` now falls back to `/rest/socialActions` and retries a not-found after 20s and 60s. Unproven until the next REST post (document, photos or video) comments on its own.
- **Profile assets:** cover options are in `brand_assets/LinkedIn/` (B recommended). The headline and "Sobre" drafts are in the 2026-11-13 session.

## What the pipeline does

| Step | Script | When (BRT) |
|---|---|---|
| Gather sports news (mostly cycling) through the Black cycling / African / Latin / Brazil / Black athletes lenses (PT, EN, ES), drop transport stories, screen with Haiku (relevance + identity/sport theme) | `linkedin-beacon.mjs` + `linkedin-beacon.json` | inside the build |
| Opus picks the story and angle, Tavily researches, Opus writes the post | `linkedin-writer.mjs` | inside the build |
| Rotate format (see below), build media (`linkedin-media.mjs`), queue a **Draft** card in Notion **IG Studio > LinkedIn Pipeline** | `prepare-linkedin.mjs` | Mon + Wed 19:00, n8n `WN80uKN1zvvqrRS4` |
| Publish ONE approved card, then post the sources as the first comment | `publish-linkedin.mjs` | Tue to Fri 08:30, n8n `bjhjku5vhY73W09h` |

Nothing reaches LinkedIn without approval. Edit Caption and First Comment in the card, then set Status = "Approved For Publishing". Normal rhythm: Monday's card goes out Tuesday, Wednesday's goes out Thursday. Late approvals go out on the next weekday slot, at most one a day.

## Rules baked into the writer (and why)

- **The beat is sport, not mobility.** Bike lanes, commuting, e-bike rules, traffic and delivery riders are off-beat even with a bicycle in the story. It is a sport series first, often through Black, African, Latin-American and Brazilian athletes: most posts are about the sport itself (races, performance, careers, teams and their business, events), and racism or representation is at most one post in three, only when the story is about that.
- **#EsportesNoLinkedIn on every post**, plus exactly 2 specific sport tags (mobility/transport tags are stripped). Research consensus: 3 to 5 tags maximum; past that, reach drops.
- **No links in the post body.** Third-party analyses put the reach penalty for external links around 50 to 60% (unconfirmed by LinkedIn, consistent across sources). Sources go in the first comment, which the publisher posts automatically.
- **Hook within roughly 210 characters**: that's what shows before "ver mais".
- **Value over promotion, an open question at the end**: straight from the workshop slides ("Consistência, Valor, Interação").
- **Every number has a year and a source.** An old stat presented as current is a false claim.
- **AI images never depict a real, identifiable person**, and the first comment says "Imagem ilustrativa gerada por IA". LinkedIn also labels C2PA content on its own.
- **Personal facts come only from Strava or the stated background.** The writer may not invent a ride or a race.

## What the automation cannot do (Jorge's part)

Top Voice is chosen by LinkedIn's editors, with no application and no follower threshold. Third-party summaries of the criteria point to consistency, originality, expertise and community engagement. The posts are the half that can be automated. The other half can't be:

1. **Reply to every comment in the first 1 to 2 hours** after the 08:30 slot. ("Responda seus comentários" is on the workshop slide.)
2. **Comment with substance on other people's posts in the sports cohort**, 10 to 15 minutes a day. A comment is reach on someone else's audience.
3. **Profile** (workshop slide "Otimize o seu perfil"): a headline that names the beat (cycling, representation, data/AI), a cover image of you riding, an About section that says what the series is, and Featured holding the best posts once they exist.
4. **Keep the channel with Luiz Gustavo open**: ask what the sports cohort measures and whether there is an editorial calendar (Tour, Olympics, Gran Fondo season) to lean into.
5. **Renew the LinkedIn token every 60 days.** It cannot be refreshed automatically. When it expires, the publish workflow turns red and the build puts a warning on the card.

## Formats (rotate by least recent use)

| Format | Source | Media |
|---|---|---|
| text | news | none |
| photo | news | 1 real photo of Jorge |
| document | news | PDF carousel cut from the post with the curated IG slide templates (IG handle swapped for the name). Top-engagement format in 2026 analyses. |
| video | newest published Reel not yet used | the Reel's mp4, copied to `linkedin/` before the 7-day `video/` Blob recycle |
| photos | news | 2 to 4 real photos, ideally one race day (REST multiImage) |
| ai-image | news | 1 gpt-image illustration at 4:5; the first comment discloses it |

Every REST upload path (image, document, video including processing) was verified against the live API on 2026-11-13. A post on the REST paths has not been created yet; the first real one is the test.

## Next steps worth building (not done)

- **A weekly engagement brief**: who in the cohort posted what, to comment on.
