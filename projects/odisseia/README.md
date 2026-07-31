# Odisseia Reel — one-off

Reel vertical pt-BR de ~60s que usa a estreia de *The Odyssey* (Nolan, 17/07/2026) para
argumentar a dívida documentada da mitologia grega com o Egito, e fecha com CTA de palavra-chave
para o relatório `/relatorios/o-que-apagaram-dos-nossos-deuses/`.

**Projeto isolado de propósito.** Não usa `generate-video.mjs`. Aquele pipeline é calibrado
para cadência diária (5 cenas rígidas, acoplado a blog/cycling, fila no Notion, rotação de CTA,
`ELEVEN_VOICE_SETTINGS` afinado ao clone do Jorge). Aqui as boas ideias dele foram **copiadas
como base**, não importadas: request stitching do TTS, legendas karaokê por timestamp de palavra
do Whisper, e o conserto do Ken Burns no `zoompan`.

## Regra dura

`research.json` é a **base de fatos congelada**. Nenhuma afirmação específica (número, nome, data)
pode entrar no roteiro sem estar lá. Na dúvida, narre em termos gerais ou corte a linha.
Fronteira crítica registrada no arquivo: Egito⇄Grécia foi *interpretatio* (contato, conquista,
comércio), **não escravidão**. Nunca sugerir o contrário.

Voz: sem travessões (—), primeira pessoa apontada para fora, frases curtas, gancho concreto.
Mesmas regras de `generate-post.mjs`, que aqui não são aplicadas por código nenhum.

## Ferramentas

| Etapa | Ferramenta | Saída |
|---|---|---|
| Fatos | Tavily via `research.mjs` | `research.json` |
| Roteiro | escrito à mão | `script.json` (6 beats, ~124 palavras) |
| Stills | gpt-image-2 `1024x1536` | `out/stills/` |
| Movimento | **Sora 2** (`input_reference`) | `out/motion/` |
| Narração | **ElevenLabs — Andréa** `f9bIZ86icwYeMIwU7aND` | `out/audio/beat-N.mp3` |
| Trilha | **ElevenLabs Music** | `out/audio/score.mp3` |
| SFX | **ElevenLabs Sound Generation** | `out/audio/sfx-N.mp3` |
| Legendas | Whisper (word timestamps) | karaokê queimado |
| Montagem | ffmpeg | `out/video.mp4` |

## Rodar

```bash
node projects/odisseia/lib/images.mjs      # stills (skip-if-exists, --force)
node projects/odisseia/lib/voice.mjs       # narração com stitching
node projects/odisseia/lib/audio.mjs both  # trilha + SFX
node projects/odisseia/lib/motion.mjs      # Sora nos beats com motion:true
node projects/odisseia/lib/assemble.mjs    # monta out/video.mp4
```

## Pegadinhas já pagas

- **gpt-image-2 rejeita estatuária clássica** como `safety_violations=[sexual]` sem menção
  explícita de drapeado. Todo figura grega leva a string `CLOTHED`.
- **Sora exige que o `input_reference` tenha exatamente as dimensões pedidas.** Os stills
  1024x1536 são reescalados e cortados para 720x1280 em `out/stills-916/` antes do envio.
- **Nenhuma pessoa real pode ser retratada** (Nyong'o, Damon etc). As esculturas são inventadas.

## CTA

O fecho pede "digita **mitologia**". Isso é atendido por `reply-to-comments.mjs` na raiz, que
agora usa uma tabela `TRIGGERS` (`censo` → relatório antigo, `mitologia` → este). O workflow n8n
`qF49GvzotbLh8DEM` faz `git reset --hard origin/main` antes de cada execução, então **push é o
deploy** — não há nada a mudar no n8n.

Casamento é por palavra inteira e sem acento: `mitologia`, `Mitologia.`, `MITOLOGIA!` casam;
`mitologias` e `mitológica` **não**.
