# 🦅 Águia Edition

Editor de vídeo estilo Premiere (timeline, preview, inspetor) com IA integrada. Você fala o que quer, a Águia edita.

- **Corte e montagem da footage real** → [Video-Use](https://github.com/browser-use/video-use) (via Claude Code)
- **Animações, intros, lower thirds, overlays** → [HyperFrames](https://github.com/heygen-com/hyperframes)
- **Motor de render próprio** (FFmpeg): cortes, speed ramp, color grade, fades, títulos, overlays

## Rodar

```bash
./setup.sh          # clona o Video-Use e checa o HyperFrames (precisa de internet)
npm start           # abre em http://localhost:4747
npm test            # teste ponta a ponta (edita por comando e renderiza um MP4)
```

Requisitos: Node 22+, FFmpeg. Nenhuma dependência npm.

Chaves opcionais (cada uma liga um recurso):

| Variável | Habilita |
|---|---|
| `ANTHROPIC_API_KEY` | **Modo IA livre**: o Claude entende qualquer pedido em português e reescreve a timeline |
| `ELEVENLABS_API_KEY` | **Video-Use**: transcrição por palavra (ElevenLabs Scribe) para cortes precisos |

## O que você pode pedir (modo local, sem chave)

| Comando | Efeito |
|---|---|
| `speed ramp de 1x para 0.3x` | rampa suave de velocidade (curva smoothstep, 12 passos) |
| `velocidade 2x` / `câmera lenta` | velocidade constante (áudio acompanha, sem mudar o tom) |
| `colorização cinematográfica` | looks: cinematic, teal-orange, punch, warm, cold, bw, vintage, neutral |
| `corta de 5 a 12` / `remove os primeiros 3 segundos` | trim |
| `remove os silêncios` | jump cut automático (FFmpeg silencedetect) |
| `título: "Meu vídeo"` | título com fade, renderizado no export |
| `cria uma intro "ÁGUIA"` | anima com HyperFrames e entra no início da timeline |
| `monta o vídeo todo…` | entrega ao agente Video-Use |

Alvos: `clip 2`, `último clip`, `todos os clips`; sem alvo, vale o clip selecionado.

## Arquitetura

```
public/index.html     UI: bin de mídia · preview · inspetor · timeline · barra de comandos IA
server.js             API local (projeto, upload, comandos, jobs de render)
lib/commands.js       linguagem natural pt-BR → ações na timeline
lib/render.js         timeline → filtergraph FFmpeg (speed ramp, grade, drawtext, overlay)
lib/media.js          ffprobe, detecção de silêncio, filmstrip
lib/integrations.js   pontes: HyperFrames (npx), Video-Use (claude -p), Claude API
```

## Status honesto

| Parte | Estado |
|---|---|
| Timeline, preview, inspetor, trim/split/reordenar | ✅ testado |
| Speed ramp, color grade, fade, títulos, export MP4 | ✅ testado (`npm test`) |
| Remoção de silêncio | ✅ testado |
| Ponte HyperFrames | ⚠️ código escrito seguindo o CLI documentado, **não executado** (o npm estava bloqueado no ambiente onde construí). Se o flag `--output` for diferente na sua versão, ajuste em `lib/integrations.js` |
| Ponte Video-Use | ⚠️ **não executada** (precisa do Claude Code CLI + chave ElevenLabs) |
| Modo IA livre (Claude API) | ⚠️ **não executado** (precisa da sua chave) |
| Preview do color grade | aproximação em CSS; o export usa a cadeia FFmpeg real |

## Ainda não é um Premiere

Sem trim por arraste nas bordas, sem múltiplas trilhas de vídeo, sem keyframes visuais de ramp e sem transições entre clips. Próximos passos naturais.

Dados de teste: `ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30:duration=12 -f lavfi -i sine=frequency=440:duration=12 -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac media/teste.mp4`
