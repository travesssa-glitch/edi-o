// Águia Edition — pontes para HyperFrames, Video-Use e IA (Claude)
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VIDEO_USE_DIR = path.join(ROOT, 'integrations', 'video-use');
const HF_DIR = path.join(ROOT, 'integrations', 'hyperframes-work');

const which = (bin) => new Promise((r) => execFile('sh', ['-c', `command -v ${bin}`], (e, o) => r(e ? null : o.trim())));

async function status() {
  return {
    ffmpeg: !!(await which('ffmpeg')),
    node: process.version,
    claudeCli: !!(await which('claude')),
    videoUseInstalled: fs.existsSync(path.join(VIDEO_USE_DIR, 'SKILL.md')),
    elevenLabsKey: !!process.env.ELEVENLABS_API_KEY,
    anthropicKey: !!process.env.ANTHROPIC_API_KEY,
    hyperframesProject: fs.existsSync(path.join(HF_DIR, 'package.json')) || fs.existsSync(path.join(HF_DIR, 'index.html')),
  };
}

function stream(cmd, args, opts, onLog) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, env: { ...process.env, ...(opts.env || {}) } });
    let out = '';
    const take = (d) => { out += d; onLog && onLog(d.toString()); };
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} saiu com código ${code}\n${out.slice(-1500)}`))));
  });
}

// ---------- HyperFrames: animações, intros, lower thirds ----------
// Compõe um HTML (padrão HyperFrames: data-start/data-duration/data-track-index + GSAP em timeline pausada)
function compositionHtml({ kind, text, sub, duration, width, height, accent }) {
  const W = width, H = height;
  const common = `<script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>`;
  const font = `font-family:'Inter','Helvetica Neue',Arial,sans-serif;`;
  if (kind === 'lower-third') {
    return `<div id="stage" data-composition-id="aguia-lower" data-start="0" data-width="${W}" data-height="${H}" style="position:relative;width:${W}px;height:${H}px;background:transparent;overflow:hidden;${font}">
  <div id="bar" class="clip" data-start="0" data-duration="${duration}" data-track-index="0" style="position:absolute;left:${W * 0.06}px;bottom:${H * 0.12}px;padding:18px 36px 18px 28px;border-left:8px solid ${accent};background:rgba(10,10,12,.82);color:#fff">
    <div id="t1" style="font-size:${H * 0.05}px;font-weight:800;letter-spacing:.5px">${text}</div>
    ${sub ? `<div id="t2" style="font-size:${H * 0.028}px;opacity:.8;margin-top:6px">${sub}</div>` : ''}
  </div>
  ${common}
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.from("#bar", { x: -${W * 0.2}, opacity: 0, duration: 0.7, ease: "power3.out" }, 0.1)
      .to("#bar", { x: -${W * 0.2}, opacity: 0, duration: 0.6, ease: "power3.in" }, ${Math.max(0.8, duration - 0.7)});
    window.__timelines = window.__timelines || {}; window.__timelines["aguia-lower"] = tl;
  </script>
</div>`;
  }
  // intro / título cinético (opaco)
  return `<div id="stage" data-composition-id="aguia-intro" data-start="0" data-width="${W}" data-height="${H}" style="position:relative;width:${W}px;height:${H}px;background:radial-gradient(circle at 50% 40%, #1b1b22, #050507);overflow:hidden;${font}">
  <div id="wrap" class="clip" data-start="0" data-duration="${duration}" data-track-index="0" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff">
    <div id="line" style="width:0;height:6px;background:${accent};margin-bottom:28px"></div>
    <div id="title" style="font-size:${H * 0.11}px;font-weight:900;letter-spacing:2px;text-transform:uppercase">${text}</div>
    ${sub ? `<div id="sub" style="font-size:${H * 0.034}px;opacity:.75;margin-top:18px;letter-spacing:6px;text-transform:uppercase">${sub}</div>` : ''}
  </div>
  ${common}
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.to("#line", { width: ${W * 0.18}, duration: 0.8, ease: "power3.out" }, 0)
      .from("#title", { y: 60, opacity: 0, scale: 0.9, duration: 0.9, ease: "power4.out" }, 0.3)
      .from("#sub", { opacity: 0, y: 20, duration: 0.7 }, 0.9)
      .to("#wrap", { opacity: 0, duration: 0.5 }, ${Math.max(1, duration - 0.5)});
    window.__timelines = window.__timelines || {}; window.__timelines["aguia-intro"] = tl;
  </script>
</div>`;
}

async function runHyperframes({ kind = 'intro', text, sub = '', duration = 4, width = 1920, height = 1080, accent = '#f5b301', mediaDir, onLog }) {
  fs.mkdirSync(HF_DIR, { recursive: true });
  const html = compositionHtml({ kind, text, sub, duration, width, height, accent });
  fs.writeFileSync(path.join(HF_DIR, 'index.html'), html);
  const name = `hf-${kind}-${Date.now()}.mp4`;
  const out = path.join(mediaDir, name);
  // CLI do HyperFrames (Node 22+ e FFmpeg). Ver: https://github.com/heygen-com/hyperframes
  await stream('npx', ['-y', 'hyperframes', 'render', '--output', out], { cwd: HF_DIR }, onLog);
  if (!fs.existsSync(out)) throw new Error('HyperFrames terminou mas o MP4 não foi encontrado. Rode "npx hyperframes render --help" para ver os flags da sua versão.');
  return { file: name, html: path.join(HF_DIR, 'index.html') };
}

// ---------- Video-Use: montagem/edição completa pelo agente ----------
async function runVideoUse({ prompt, mediaDir, onLog }) {
  const st = await status();
  if (!st.claudeCli) throw new Error('Claude Code (CLI "claude") não encontrado. Instale-o e rode ./setup.sh de novo.');
  if (!st.videoUseInstalled) throw new Error('Video-Use não instalado. Rode ./setup.sh (clona o repo em integrations/video-use).');
  if (!st.elevenLabsKey) throw new Error('Falta ELEVENLABS_API_KEY no ambiente (o Video-Use usa o ElevenLabs Scribe para transcrever).');
  const brief = `${prompt}\n\nUse a skill video-use em ${VIDEO_USE_DIR}. Leia SKILL.md e os helpers/. As fontes estão neste diretório; salve a saída em ./edit/final.mp4.`;
  await stream('claude', ['-p', brief, '--allowedTools', 'Bash,Read,Write,Edit'], { cwd: mediaDir }, onLog);
  const final = path.join(mediaDir, 'edit', 'final.mp4');
  if (!fs.existsSync(final)) throw new Error('O agente terminou mas edit/final.mp4 não apareceu.');
  const dest = `videouse-${Date.now()}.mp4`;
  fs.copyFileSync(final, path.join(mediaDir, dest));
  return { file: dest };
}

// ---------- Modo IA (Claude via API): pedidos livres → novo estado do projeto ----------
async function aiPlan(project, text, selectedId) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const system = `Você é o cérebro de edição do "Águia Edition". Recebe o projeto (JSON) e um pedido em português e devolve APENAS um JSON {"project": <projeto modificado>, "summary": "o que foi feito"}.
Esquema de clip: {id,name,src,in,out,speed?,ramp?:{from,to,steps,curve:"ease"|"linear"},grade?:"none|cinematic|teal-orange|punch|warm|cold|bw|vintage|neutral",volume?,mute?,fade?}.
titles: [{id,text,start,duration,position:"center|lower|top",size}]. Tempos de clip (in/out) são segundos na fonte. Não invente arquivos; só reordene/corte/ajuste os clips existentes.`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.AGUIA_MODEL || 'claude-sonnet-5-5', max_tokens: 4000, system,
      messages: [{ role: 'user', content: JSON.stringify({ selectedId, project, pedido: text }) }] }),
  });
  if (!r.ok) throw new Error('API Anthropic: ' + r.status + ' ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  const raw = j.content.map((c) => c.text || '').join('');
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) throw new Error('Resposta da IA sem JSON.');
  return JSON.parse(m[0]);
}

module.exports = { status, runHyperframes, runVideoUse, aiPlan, VIDEO_USE_DIR };
