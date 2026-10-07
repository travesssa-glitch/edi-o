// Teste de fumaça: sobe o servidor, edita por comandos em português, renderiza e valida com ffprobe.
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 4799;
const base = `http://localhost:${PORT}`;
const J = async (url, body) => { const r = await fetch(base + url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}); return r.json(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log((c ? '  ✔ ' : '  ✘ ') + m); if (!c) process.exitCode = 1; };
const wait = async (id) => { for (;;) { const j = await J('/api/job?id=' + id); if (j.status !== 'running') return j; await sleep(300); } };
const dur = (f) => parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

(async () => {
  try { fs.unlinkSync(path.join(ROOT, 'project.json')); } catch {}
  // gera mídia sintética se não existir (vídeo contínuo + vídeo com "fala" e silêncios)
  const M = path.join(ROOT, 'media');
  const ff = (...a) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...a]);
  if (!fs.existsSync(path.join(M, 'teste_a.mp4'))) ff('-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(M, 'teste_a.mp4'));
  if (!fs.existsSync(path.join(M, 'teste_fala.mp4'))) ff('-f', 'lavfi', '-i', 'smptebars=size=1280x720:rate=30:duration=10', '-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,4),2),0.5*sin(2*PI*300*t),0)':d=10", '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(M, 'teste_fala.mp4'));
  const srv = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT, ANTHROPIC_API_KEY: '' } });
  await sleep(800);
  try {
    const media = await J('/api/media');
    ok(media.length >= 2, `mídia detectada (${media.map((m) => m.file).join(', ')})`);

    await J('/api/add-clip', { file: 'teste_a.mp4' });
    await J('/api/add-clip', { file: 'teste_fala.mp4' });
    let p = await J('/api/project');
    ok(p.clips.length === 2, '2 clips na timeline');

    let r = await J('/api/command', { text: 'faz um speed ramp de 1x para 0.3x no clip 1' });
    ok(r.project.clips[0].ramp && r.project.clips[0].ramp.to === 0.3, 'comando → speed ramp 1x→0.3x');

    r = await J('/api/command', { text: 'colorização cinematográfica em todos os clips' });
    ok(r.project.clips.every((c) => c.grade === 'cinematic'), 'comando → color grade cinematic em todos');

    r = await J('/api/command', { text: 'corta de 1 a 6 no clip 1' });
    ok(r.project.clips[0].out - r.project.clips[0].in === 5, 'comando → trim 1s–6s');

    r = await J('/api/command', { text: 'título: "ÁGUIA EDITION"' });
    ok(r.project.titles.length === 1, 'comando → título');

    r = await J('/api/command', { text: 'remove os silêncios do clip 2' });
    const j = await wait(r.jobId);
    ok(j.status === 'done' && j.result.project.clips.length > 2, `remoção de silêncio dividiu o clip (${j.result?.project.clips.length} clips) — ${j.result?.actions?.join(' ')}`);

    const { jobId } = await J('/api/render', { preset: 'ultrafast', crf: 28 });
    const rj = await wait(jobId);
    ok(rj.status === 'done', 'render FFmpeg concluído' + (rj.error ? ': ' + rj.error : ''));
    if (rj.status === 'done') {
      const out = path.join(ROOT, rj.result.url.replace(/^\//, ''));
      const real = dur(out), esperado = rj.result.duration;
      ok(Math.abs(real - esperado) < 0.5, `duração do MP4 (${real.toFixed(2)}s) bate com a timeline (${esperado.toFixed(2)}s)`);
      console.log('  → arquivo:', out);
    }
  } catch (e) { console.error(e); process.exitCode = 1; }
  srv.kill();
})();
