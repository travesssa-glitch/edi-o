// Águia Edition — servidor local. Sem dependências externas (só Node 22 + FFmpeg).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { render, GRADES, clipOutputDuration } = require('./lib/render');
const { interpret } = require('./lib/commands');
const media = require('./lib/media');
const integ = require('./lib/integrations');

const PORT = process.env.PORT || 4747;
const ROOT = __dirname;
const MEDIA = path.join(ROOT, 'media');
const OUTPUT = path.join(ROOT, 'output');
const PROJECT_FILE = path.join(ROOT, 'project.json');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.jpg': 'image/jpeg', '.png': 'image/png', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' };

const emptyProject = () => ({ name: 'Projeto Águia', width: 1920, height: 1080, fps: 30, clips: [], titles: [], overlays: [] });
let project = fs.existsSync(PROJECT_FILE) ? JSON.parse(fs.readFileSync(PROJECT_FILE, 'utf8')) : emptyProject();
const save = () => fs.writeFileSync(PROJECT_FILE, JSON.stringify(project, null, 2));
const jobs = {}; // id -> {status, progress, log, result, error}
const uid = () => Math.random().toString(36).slice(2, 9);

const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { const b = []; req.on('data', (d) => b.push(d)); req.on('end', () => r(Buffer.concat(b))); });
const readJson = async (req) => { const b = await readBody(req); return b.length ? JSON.parse(b.toString()) : {}; };
const safeName = (n) => path.basename(String(n)).replace(/[^\w.\-]+/g, '_');

function serveFile(req, res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'não encontrado' });
  const stat = fs.statSync(file), type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m[1] ? parseInt(m[1]) : 0, end = m[2] ? parseInt(m[2]) : stat.size - 1;
    res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  }
}

async function listMedia() {
  const out = [];
  for (const f of fs.readdirSync(MEDIA)) {
    const p = path.join(MEDIA, f);
    if (!fs.statSync(p).isFile() || !/\.(mp4|mov|mkv|webm|m4v|avi|mp3|wav|m4a)$/i.test(f)) continue;
    try {
      const info = await media.probe(p);
      if (info.hasVideo) media.filmstrip(p, path.join(MEDIA, '.strip-' + f + '.jpg'), info.duration).catch(() => {});
      out.push({ file: f, ...info, strip: '/media/.strip-' + f + '.jpg' });
    } catch { /* ignora arquivos ilegíveis */ }
  }
  return out;
}

function addClip(file, info) {
  const n = project.clips.length + 1;
  project.clips.push({ id: 'c' + uid(), name: `Clip ${n}`, src: file, in: 0, out: +info.duration.toFixed(3), speed: 1, grade: 'none', volume: 1 });
}

function newJob(fn) {
  const id = uid();
  jobs[id] = { status: 'running', progress: 0, log: '' };
  Promise.resolve().then(() => fn(jobs[id])).then((r) => { jobs[id].status = 'done'; jobs[id].progress = 1; jobs[id].result = r; })
    .catch((e) => { jobs[id].status = 'error'; jobs[id].error = e.message; });
  return id;
}

// executa ações "pesadas" que o interpretador não resolve sozinho
async function runHeavy(a, job) {
  if (a.type === 'split') {
    const c = project.clips.find((x) => x.id === a.id) || project.clips[0];
    if (!c) return 'Nada para dividir.';
    const at = c.in + a.at;
    if (at <= c.in || at >= c.out) return 'Ponto de divisão fora do clip.';
    const i = project.clips.indexOf(c);
    project.clips.splice(i + 1, 0, { ...c, id: 'c' + uid(), name: c.name + 'b', in: at });
    c.out = at;
    return `Clip dividido em ${a.at}s.`;
  }
  if (a.type === 'remove-silence') {
    const list = project.clips.filter((x) => (a.ids || []).includes(x.id));
    let removed = 0;
    for (const c of list) {
      const file = path.join(MEDIA, c.src);
      const sil = await media.detectSilences(file);
      const rel = sil.filter(([s, e]) => e > c.in && s < c.out).map(([s, e]) => [Math.max(s, c.in), Math.min(e, c.out)]);
      const keep = media.keepRanges(rel.map(([s, e]) => [s - c.in, e - c.in]), c.out - c.in).map(([s, e]) => [s + c.in, e + c.in]);
      if (!keep.length) continue;
      const idx = project.clips.indexOf(c);
      const pieces = keep.map(([s, e], k) => ({ ...c, id: 'c' + uid(), name: `${c.name}.${k + 1}`, in: +s.toFixed(3), out: +e.toFixed(3) }));
      removed += (c.out - c.in) - pieces.reduce((t, p) => t + (p.out - p.in), 0);
      project.clips.splice(idx, 1, ...pieces);
    }
    return `Silêncios removidos: ${removed.toFixed(1)}s cortados.`;
  }
  if (a.type === 'hyperframes') {
    const q = /["“']([^"”']+)["”']/.exec(a.prompt);
    const kind = /lower/i.test(a.prompt) ? 'lower-third' : 'intro';
    const r = await integ.runHyperframes({ kind, text: q ? q[1] : 'ÁGUIA EDITION', sub: '', duration: 4, width: project.width, height: project.height, mediaDir: MEDIA, onLog: (l) => (job.log += l) });
    const info = await media.probe(path.join(MEDIA, r.file));
    if (kind === 'intro') { addClip(r.file, info); const c = project.clips.pop(); c.name = 'Intro HyperFrames'; project.clips.unshift(c); }
    else (project.overlays = project.overlays || []).push({ id: 'o' + uid(), src: r.file, start: 1, duration: Math.min(4, info.duration), x: 0, y: 0 });
    return `Animação (${kind}) gerada pelo HyperFrames: ${r.file}`;
  }
  if (a.type === 'video-use') {
    const r = await integ.runVideoUse({ prompt: a.prompt, mediaDir: MEDIA, onLog: (l) => (job.log += l) });
    const info = await media.probe(path.join(MEDIA, r.file));
    project.clips = []; addClip(r.file, info); project.clips[0].name = 'Montagem Video-Use';
    return `Montagem do Video-Use importada: ${r.file}`;
  }
  return '';
}

const routes = {
  'GET /api/project': async () => project,
  'POST /api/project': async (req) => { project = { ...emptyProject(), ...(await readJson(req)) }; save(); return { ok: true }; },
  'GET /api/media': async () => listMedia(),
  'GET /api/grades': async () => Object.keys(GRADES),
  'GET /api/integrations': async () => integ.status(),
  'POST /api/upload': async (req, res, url) => {
    const name = safeName(url.searchParams.get('name') || 'upload.mp4');
    const body = await readBody(req);
    fs.writeFileSync(path.join(MEDIA, name), body);
    const info = await media.probe(path.join(MEDIA, name));
    if (info.hasVideo) addClip(name, info);
    save();
    return { ok: true, file: name, project };
  },
  'POST /api/add-clip': async (req) => {
    const { file } = await readJson(req);
    const info = await media.probe(path.join(MEDIA, safeName(file)));
    addClip(safeName(file), info); save();
    return project;
  },
  'POST /api/command': async (req) => {
    const { text, selectedId } = await readJson(req);
    let notes = [], actions = [];
    // 1) modo IA (se houver chave) 2) modo local por regras
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const plan = await integ.aiPlan(project, text, selectedId);
        if (plan && plan.project) { project = { ...emptyProject(), ...plan.project }; save(); return { project, actions: [plan.summary || 'Edição aplicada pela IA'], notes: ['modo IA'] }; }
      } catch (e) { notes.push('IA indisponível (' + e.message.slice(0, 120) + '), usando modo local.'); }
    }
    const r = interpret(project, text, selectedId);
    notes.push(...r.notes);
    const sync = [], heavy = [];
    for (const a of r.actions) (typeof a === 'string' ? sync : heavy).push(a);
    actions = sync;
    if (!heavy.length) { save(); return { project, actions, notes }; }
    const jobId = newJob(async (job) => {
      const done = [];
      for (const h of heavy) done.push(await runHeavy(h, job));
      save();
      return { project, actions: [...sync, ...done.filter(Boolean)] };
    });
    save();
    return { project, actions, notes, jobId };
  },
  'POST /api/render': async (req) => {
    const opts = await readJson(req);
    const p = { ...project, preset: opts.preset || 'veryfast', crf: opts.crf ?? 20 };
    const file = `aguia-${Date.now()}.mp4`;
    const jobId = newJob(async (job) => {
      const r = await render(p, MEDIA, path.join(OUTPUT, file), (pr) => (job.progress = pr));
      return { url: '/output/' + file, duration: r.duration };
    });
    return { jobId };
  },
  'GET /api/job': async (req, res, url) => jobs[url.searchParams.get('id')] || { status: 'error', error: 'job não existe' },
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    const handler = routes[`${req.method} ${url.pathname}`];
    if (handler) return send(res, 200, await handler(req, res, url));
    if (url.pathname.startsWith('/media/')) return serveFile(req, res, path.join(MEDIA, safeName(decodeURIComponent(url.pathname.slice(7)))));
    if (url.pathname.startsWith('/output/')) return serveFile(req, res, path.join(OUTPUT, safeName(decodeURIComponent(url.pathname.slice(8)))));
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(ROOT, 'public', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    return serveFile(req, res, file);
  } catch (e) { send(res, 500, { error: e.message }); }
}).listen(PORT, () => console.log(`\n🦅 Águia Edition rodando em http://localhost:${PORT}\n`));
