#!/usr/bin/env bash
# Águia Edition — instala as duas IAs que o editor usa:
#   • Video-Use  (browser-use/video-use)  → corte/montagem da footage real
#   • HyperFrames (heygen-com/hyperframes) → animações, intros, lower thirds, overlays
set -e
cd "$(dirname "$0")"

echo "→ Checando requisitos…"
command -v node   >/dev/null || { echo "Falta Node.js 22+"; exit 1; }
command -v ffmpeg >/dev/null || { echo "Falta FFmpeg (brew install ffmpeg / apt install ffmpeg)"; exit 1; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' || { echo "Node 22+ é necessário (HyperFrames)"; exit 1; }

echo "→ Video-Use…"
if [ ! -d integrations/video-use ]; then
  git clone --depth 1 https://github.com/browser-use/video-use integrations/video-use
fi
(cd integrations/video-use && (command -v uv >/dev/null && uv sync || pip install -e . --break-system-packages))
# registra como skill no Claude Code (se existir)
mkdir -p "$HOME/.claude/skills"
ln -sfn "$PWD/integrations/video-use" "$HOME/.claude/skills/video-use"

echo "→ HyperFrames…"
npx -y hyperframes --help >/dev/null 2>&1 && echo "   CLI do HyperFrames OK" || echo "   (não consegui rodar 'npx hyperframes' agora; tente de novo com internet)"

echo
echo "Quase lá! Configure as chaves (opcionais, cada uma habilita um recurso):"
echo "  export ELEVENLABS_API_KEY=...   # Video-Use: transcrição com timestamps por palavra"
echo "  export ANTHROPIC_API_KEY=...    # modo IA livre: o Claude entende qualquer pedido"
echo "Depois:  npm start   →  http://localhost:4747"
