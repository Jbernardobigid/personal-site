# LinkedIn series: #EsportesNoLinkedIn

Started 2026-11-13, after the LinkedIn editorial workshop at the LinkedIn office (sports cohort, community manager Luiz Gustavo). Goal: LinkedIn Top Voice within 6 to 9 months.

## What the pipeline does

| Step | Script | When (BRT) |
|---|---|---|
| Gather cycling news through the Black / African / Latin / access lenses (PT, EN, ES), screen with Haiku | `linkedin-beacon.mjs` + `linkedin-beacon.json` | inside the build |
| Opus picks the story and angle, Tavily researches, Opus writes the post | `linkedin-writer.mjs` | inside the build |
| Rotate format (text, real photo, AI image), build media, queue a Notion **Draft** card (Type = LinkedIn) | `prepare-linkedin.mjs` | Mon + Wed 19:00, n8n `WN80uKN1zvvqrRS4` |
| Publish ONE approved card, then post the sources as the first comment | `publish-linkedin.mjs` | Tue to Fri 08:30, n8n `bjhjku5vhY73W09h` |

Nothing reaches LinkedIn without approval. Edit Caption and First Comment in the card, then set Status = "Approved For Publishing". Normal rhythm: Monday's card goes out Tuesday, Wednesday's goes out Thursday. Late approvals go out on the next weekday slot, at most one a day.

## Rules baked into the writer (and why)

- **#EsportesNoLinkedIn on every post**, plus exactly 2 specific tags. Research consensus: 3 to 5 tags maximum; past that, reach drops.
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

## Next steps worth building (not done)

- **Document/carousel posts (PDF).** Consistently the highest-engagement format in 2026 analyses (about 6.6%). The renderer (`generate-carousel.mjs`) and the PDF poster (`post-to-linkedin-document.mjs`) already exist.
- **Repurpose the cycling Reels as native LinkedIn video.** Same topics, already in PT-BR.
- **Multi-image posts** (2 to 4 race photos) via the REST `multiImage` content type. Untested until the token is renewed.
- **A weekly engagement brief**: who in the cohort posted what, to comment on.
