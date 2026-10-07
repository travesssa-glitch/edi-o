// Águia Edition — utilidades de mídia (ffprobe, silêncio, filmstrip)
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const run = (cmd, args) => new Promise((res, rej) =>
  execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (e, out, err) => (e ? rej(new Error(err || e.message)) : res({ out, err }))));

async function probe(file) {
  const { out } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(out);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return {
    duration: parseFloat(j.format.duration) || 0,
    width: v?.width, height: v?.height,
    hasVideo: !!v, hasAudio: !!a,
    fps: v ? eval(v.avg_frame_rate || '30') : null, // "30000/1001"
  };
}

// Detecta trechos de fala (inverso dos silêncios) — base do corte automático estilo Video-Use
function detectSilences(file, noiseDb = -32, minDur = 0.45) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-i', file, '-af', `silencedetect=noise=${noiseDb}dB:d=${minDur}`, '-f', 'null', '-']);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', () => {
      const silences = [];
      let start = null;
      for (const line of err.split('\n')) {
        let m;
        if ((m = /silence_start: (-?[\d.]+)/.exec(line))) start = Math.max(0, parseFloat(m[1]));
        if ((m = /silence_end: ([\d.]+)/.exec(line)) && start !== null) { silences.push([start, parseFloat(m[1])]); start = null; }
      }
      resolve(silences);
    });
    p.on('error', reject);
  });
}

// Converte silêncios em trechos "mantidos", com folga (pad) para não cortar palavras
function keepRanges(silences, duration, pad = 0.12, minKeep = 0.25) {
  const keep = [];
  let cursor = 0;
  for (const [s, e] of silences) {
    const end = Math.min(duration, s + pad);
    if (end - cursor >= minKeep) keep.push([cursor, end]);
    cursor = Math.max(cursor, e - pad);
  }
  if (duration - cursor >= minKeep) keep.push([cursor, duration]);
  return keep;
}

// Filmstrip (miniaturas lado a lado) para a timeline
async function filmstrip(file, outJpg, duration, count = 12) {
  if (fs.existsSync(outJpg)) return;
  const step = Math.max(0.1, duration / count);
  await run('ffmpeg', ['-y', '-hide_banner', '-i', file, '-vf', `fps=1/${step.toFixed(3)},scale=160:-2,tile=${count}x1`, '-frames:v', '1', '-q:v', '5', outJpg]);
}

module.exports = { probe, detectSilences, keepRanges, filmstrip, run };
