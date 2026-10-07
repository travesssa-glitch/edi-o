// Águia Edition — motor de render (FFmpeg)
// Converte o "projeto" (timeline de clips + overlays) em um comando FFmpeg.
const { spawn } = require('child_process');
const path = require('path');

// ---------- Color grading presets (cadeias FFmpeg) ----------
const GRADES = {
  none: '',
  cinematic: 'eq=contrast=1.08:saturation=0.92:gamma=0.97,colorbalance=rs=0.06:gs=0.0:bs=-0.06:rm=0.04:bm=-0.04:rh=0.05:bh=-0.05,curves=preset=medium_contrast',
  'teal-orange': 'colorbalance=rs=-0.08:gs=0.0:bs=0.10:rh=0.12:gh=0.02:bh=-0.10,eq=contrast=1.10:saturation=1.15',
  punch: 'eq=contrast=1.15:saturation=1.25:brightness=0.02,unsharp=5:5:0.6',
  warm: 'colorbalance=rs=0.08:rm=0.06:rh=0.04:bs=-0.08:bm=-0.06:bh=-0.04,eq=saturation=1.08',
  cold: 'colorbalance=rs=-0.06:rm=-0.04:bs=0.08:bm=0.06,eq=saturation=0.95',
  bw: 'hue=s=0,eq=contrast=1.15',
  vintage: 'curves=preset=vintage,eq=saturation=0.85,noise=alls=8:allf=t',
  neutral: 'eq=contrast=1.04:saturation=1.05',
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// atempo só aceita 0.5..2.0 por estágio → encadeia
function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s > 2.0) { parts.push('atempo=2.0'); s /= 2.0; }
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  parts.push(`atempo=${s.toFixed(5)}`);
  return parts.join(',');
}

// Expande um clip em sub-segmentos (cada um com velocidade constante).
// Speed ramp: clip.ramp = { from, to, steps, curve } → interpola a velocidade ao longo da fonte.
function expandClip(clip) {
  const dur = clip.out - clip.in;
  if (clip.ramp) {
    const { from = 1, to = 1, steps = 10, curve = 'ease' } = clip.ramp;
    const segs = [];
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const k = curve === 'ease' ? t * t * (3 - 2 * t) : t; // smoothstep
      const speed = clamp(from + (to - from) * k, 0.1, 16);
      segs.push({
        in: clip.in + (dur * i) / steps,
        out: clip.in + (dur * (i + 1)) / steps,
        speed,
      });
    }
    return segs;
  }
  return [{ in: clip.in, out: clip.out, speed: clamp(clip.speed || 1, 0.1, 16) }];
}

// Duração final (em segundos) de um clip depois de speed/ramp
function clipOutputDuration(clip) {
  return expandClip(clip).reduce((a, s) => a + (s.out - s.in) / s.speed, 0);
}

function esc(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\u2019").replace(/%/g, '\\%');
}

// Monta os argumentos do FFmpeg
function buildFfmpegArgs(project, mediaDir, outFile) {
  const W = project.width || 1920, H = project.height || 1080, FPS = project.fps || 30;
  const args = ['-y', '-hide_banner'];
  const inputs = []; // paths únicos
  const inputIndex = (p) => {
    let i = inputs.indexOf(p);
    if (i < 0) { inputs.push(p); i = inputs.length - 1; }
    return i;
  };

  const filters = [];
  const concatLabels = [];
  let segCount = 0;
  let timelineT = 0;
  const clipTimes = []; // início de cada clip na timeline final

  for (const clip of project.clips) {
    const src = path.join(mediaDir, clip.src);
    const idx = inputIndex(src);
    clipTimes.push(timelineT);
    const grade = GRADES[clip.grade] !== undefined ? GRADES[clip.grade] : (clip.grade || '');
    for (const seg of expandClip(clip)) {
      const v = `v${segCount}`, a = `a${segCount}`;
      let vf = `[${idx}:v]trim=start=${seg.in.toFixed(4)}:end=${seg.out.toFixed(4)},setpts=(PTS-STARTPTS)/${seg.speed.toFixed(5)},` +
               `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}`;
      if (grade) vf += ',' + grade;
      if (clip.fade) vf += `,fade=t=in:st=0:d=${clip.fade}`;
      filters.push(vf + `[${v}]`);
      const vol = clip.mute ? 0 : (clip.volume ?? 1);
      const af = `[${idx}:a]atrim=start=${seg.in.toFixed(4)}:end=${seg.out.toFixed(4)},asetpts=PTS-STARTPTS,${atempoChain(seg.speed)},` +
                 `aformat=sample_rates=48000:channel_layouts=stereo,volume=${vol},afade=t=in:st=0:d=0.03`;
      filters.push(af + `[${a}]`);
      concatLabels.push(`[${v}][${a}]`);
      timelineT += (seg.out - seg.in) / seg.speed;
      segCount++;
    }
  }

  if (!segCount) throw new Error('Timeline vazia: adicione clips antes de renderizar.');

  filters.push(`${concatLabels.join('')}concat=n=${segCount}:v=1:a=1[vcat][acat]`);
  let vlast = 'vcat';

  // Títulos / lower thirds (drawtext)
  (project.titles || []).forEach((t, i) => {
    const out = `vt${i}`;
    const size = t.size || 64;
    const y = t.position === 'lower' ? 'h-h/6' : t.position === 'top' ? 'h/8' : '(h-text_h)/2';
    const fontfile = t.font || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
    const alpha = `if(lt(t,${t.start}+0.4),(t-${t.start})/0.4,if(gt(t,${t.start + t.duration}-0.4),(${t.start + t.duration}-t)/0.4,1))`;
    filters.push(
      `[${vlast}]drawtext=fontfile='${fontfile}':text='${esc(t.text)}':fontsize=${size}:fontcolor=${t.color || 'white'}:` +
      `x=(w-text_w)/2:y=${y}:box=${t.box === false ? 0 : 1}:boxcolor=black@0.45:boxborderw=18:` +
      `enable='between(t,${t.start},${t.start + t.duration})':alpha='${alpha}'[${out}]`
    );
    vlast = out;
  });

  // Overlays (ex.: vídeos gerados pelo HyperFrames, com ou sem alpha)
  (project.overlays || []).forEach((o, i) => {
    const idx = inputIndex(path.join(mediaDir, o.src));
    const lab = `ov${i}`, out = `vo${i}`;
    filters.push(`[${idx}:v]setpts=PTS-STARTPTS+${o.start}/TB,scale=${o.w || W}:${o.h || H}[${lab}]`);
    filters.push(`[${vlast}][${lab}]overlay=${o.x ?? 0}:${o.y ?? 0}:enable='between(t,${o.start},${o.start + o.duration})':eof_action=pass[${out}]`);
    vlast = out;
  });

  for (const p of inputs) args.push('-i', p);
  args.push('-filter_complex', filters.join(';'), '-map', `[${vlast}]`, '-map', '[acat]',
    '-c:v', 'libx264', '-preset', project.preset || 'medium', '-crf', String(project.crf ?? 18), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outFile);
  return { args, totalDuration: timelineT, clipTimes };
}

function render(project, mediaDir, outFile, onProgress) {
  return new Promise((resolve, reject) => {
    let built;
    try { built = buildFfmpegArgs(project, mediaDir, outFile); } catch (e) { return reject(e); }
    const p = spawn('ffmpeg', ['-progress', 'pipe:1', '-nostats', ...built.args]);
    let err = '';
    p.stdout.on('data', (d) => {
      const m = /out_time_ms=(\d+)/.exec(d.toString());
      if (m && onProgress) onProgress(Math.min(1, m[1] / 1e6 / built.totalDuration));
    });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => code === 0 ? resolve({ outFile, duration: built.totalDuration }) : reject(new Error(err.split('\n').slice(-12).join('\n'))));
  });
}

module.exports = { GRADES, buildFfmpegArgs, render, expandClip, clipOutputDuration };
