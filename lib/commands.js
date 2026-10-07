// Águia Edition — interpretador de comandos em linguagem natural (pt-BR)
// Modo local (sem internet/IA): regras. Modo IA: se ANTHROPIC_API_KEY existir, o servidor
// delega o texto ao Claude, que devolve a mesma lista de "ações" (ver aiPlan em server.js).
const { GRADES, clipOutputDuration } = require('./render');

const num = (s) => parseFloat(String(s).replace(',', '.'));
const GRADE_ALIASES = {
  cinematografic: 'cinematic', cinematic: 'cinematic', cinema: 'cinematic', filme: 'cinematic',
  'teal': 'teal-orange', laranja: 'teal-orange', punch: 'punch', vibrante: 'punch', contraste: 'punch',
  quente: 'warm', warm: 'warm', frio: 'cold', fria: 'cold', cold: 'cold',
  'preto e branco': 'bw', 'p&b': 'bw', bw: 'bw', vintage: 'vintage', retro: 'vintage', neutro: 'neutral', neutral: 'neutral',
  remover: 'none', nenhum: 'none',
};

function pickGrade(t) {
  const keys = Object.keys(GRADE_ALIASES).sort((a, b) => b.length - a.length);
  for (const k of keys) if (t.includes(k)) return GRADE_ALIASES[k];
  return null;
}

// Seleciona o clip alvo: "clip 2", "último clip", senão o selecionado, senão todos
function targets(project, t, selectedId) {
  const m = /clip\s*(\d+)/.exec(t);
  if (m) return project.clips.filter((_, i) => i === Number(m[1]) - 1);
  if (/(ultimo|último)/.test(t)) return project.clips.slice(-1);
  if (/(primeiro)/.test(t)) return project.clips.slice(0, 1);
  if (/(todos|tudo|todo o|vídeo inteiro|video inteiro)/.test(t)) return project.clips;
  const sel = project.clips.find((c) => c.id === selectedId);
  return sel ? [sel] : project.clips;
}

function interpret(project, text, selectedId) {
  const t = text.toLowerCase();
  const actions = [];
  const notes = [];
  const tg = () => targets(project, t, selectedId);

  // --- Speed ramp ---
  if (/(speed\s*ramp|rampa|ramp)/.test(t)) {
    let from = 1, to = 0.3;
    const m = /de\s*(\d+[.,]?\d*)\s*x?\s*(?:para|pra|até|a)\s*(\d+[.,]?\d*)\s*x?/.exec(t);
    if (m) { from = num(m[1]); to = num(m[2]); }
    else if (/(acelera|rápido|rapido)/.test(t)) { from = 1; to = 3; }
    else if (/(desacelera|slow|lent[oa]|câmera lenta|camera lenta)/.test(t)) { from = 1; to = 0.3; }
    for (const c of tg()) { delete c.speed; c.ramp = { from, to, steps: 12, curve: 'ease' }; actions.push(`Speed ramp ${from}x → ${to}x no ${c.name}`); }
  }
  // --- Velocidade constante ---
  else if (/(velocidade|speed|acelera|desacelera|câmera lenta|camera lenta|slow ?motion|slowmo)/.test(t)) {
    let s = null;
    const m = /(\d+[.,]?\d*)\s*x/.exec(t) || /velocidade\s*(?:de|para|pra)?\s*(\d+[.,]?\d*)/.exec(t);
    if (m) s = num(m[1]);
    else if (/(câmera lenta|camera lenta|slow)/.test(t)) s = 0.5;
    else if (/acelera/.test(t)) s = 2;
    if (s) for (const c of tg()) { delete c.ramp; c.speed = s; actions.push(`Velocidade ${s}x no ${c.name}`); }
  }

  // --- Color grade ---
  if (/(color|cor\b|cores|colori|grade|grading|look|filtro|preto e branco|p&b)/.test(t)) {
    const g = pickGrade(t) || 'cinematic';
    for (const c of tg()) { c.grade = g; actions.push(`Color grade "${g}" no ${c.name}`); }
  }

  // --- Cortar / trim: "corta de 5 a 12", "corta os primeiros 3 segundos", "mantém de 2 até 9" ---
  let m;
  if ((m = /(?:corta|corte|mant[eé]m|trim|recorta)\w*\s*(?:de|do segundo)?\s*(\d+[.,]?\d*)\s*(?:s|seg)?\s*(?:a|até|ate|-)\s*(\d+[.,]?\d*)/.exec(t))) {
    const a = num(m[1]), b = num(m[2]);
    for (const c of tg()) {
      const base = c.in;
      c.in = base + a; c.out = Math.min(c.out, base + b);
      actions.push(`Trim ${a}s–${b}s no ${c.name}`);
    }
  } else if ((m = /(?:remove|tira|corta)\w*\s*(?:os\s*)?primeiros?\s*(\d+[.,]?\d*)/.exec(t))) {
    for (const c of tg()) { c.in += num(m[1]); actions.push(`Removidos ${m[1]}s do início de ${c.name}`); }
  } else if ((m = /(?:remove|tira|corta)\w*\s*(?:os\s*)?últimos?\s*(\d+[.,]?\d*)/.exec(t))) {
    for (const c of tg()) { c.out -= num(m[1]); actions.push(`Removidos ${m[1]}s do fim de ${c.name}`); }
  }

  // --- Dividir ---
  if ((m = /(?:divide|corta em|split|separa)\w*\s*(?:em|no|aos)?\s*(\d+[.,]?\d*)\s*(?:s|seg)?/.exec(t)) && !/primeiros|últimos|de \d/.test(t)) {
    actions.push({ type: 'split', at: num(m[1]), id: (tg()[0] || {}).id });
  }

  // --- Remover silêncio / limpar (delegado ao servidor: ffmpeg silencedetect) ---
  if (/(sil[eê]ncio|pausas|filler|vícios|vicios|limpa|limpar áudio|jump ?cut)/.test(t)) {
    actions.push({ type: 'remove-silence', ids: tg().map((c) => c.id) });
    notes.push('Detectando silêncios com FFmpeg…');
  }

  // --- Volume / mute ---
  if (/(mute|silencia|sem áudio|sem audio)/.test(t)) for (const c of tg()) { c.mute = true; actions.push(`Mudo: ${c.name}`); }
  if ((m = /volume\s*(?:para|pra|de|em)?\s*(\d+)\s*%?/.exec(t))) for (const c of tg()) { c.volume = num(m[1]) / 100; actions.push(`Volume ${m[1]}% no ${c.name}`); }

  // --- Fade ---
  if (/fade/.test(t)) for (const c of tg()) { c.fade = 0.6; actions.push(`Fade-in no ${c.name}`); }

  // --- Título / lower third ---
  if ((m = /(?:t[ií]tulo|lower third|legenda|texto)\s*[:\-]?\s*["“']([^"”']+)["”']/.exec(text)) || (m = /(?:t[ií]tulo|lower third|texto)\s*[:\-]\s*(.+)$/i.exec(text))) {
    const total = project.clips.reduce((a, c) => a + clipOutputDuration(c), 0);
    const start = /final|fim/.test(t) ? Math.max(0, total - 4) : 0.5;
    const position = /lower|rodapé|rodape|embaixo/.test(t) ? 'lower' : /topo/.test(t) ? 'top' : 'center';
    (project.titles = project.titles || []).push({ id: 't' + Date.now(), text: m[1].trim(), start, duration: 3.5, position, size: position === 'lower' ? 48 : 72 });
    actions.push(`Título "${m[1].trim()}" (${position}) em ${start.toFixed(1)}s`);
  }

  // --- Overlay/animação via HyperFrames ---
  if (/(anima[cç][aã]o|intro|overlay|motion graphic|hyperframes|lower[- ]third animad)/.test(t) && !/lower third\s*[:"]/.test(t)) {
    actions.push({ type: 'hyperframes', prompt: text });
    notes.push('Gerando animação com HyperFrames…');
  }

  // --- Montagem completa pelo agente (Video-Use) ---
  if (/(monta|montagem|edita tudo|editar tudo|edição completa|edicao completa|edita o vídeo|video-use|videouse)/.test(t)) {
    actions.push({ type: 'video-use', prompt: text });
    notes.push('Chamando o agente Video-Use para montar a edição…');
  }

  if (!actions.length) notes.push('Não entendi esse comando no modo local. Exemplos: "speed ramp de 1x para 0.3x", "colorização cinematográfica", "corta de 5 a 12", "remove os silêncios", "título: \\"Meu vídeo\\"". Com ANTHROPIC_API_KEY configurada, o modo IA entende pedidos livres.');
  return { actions, notes };
}

module.exports = { interpret, GRADES };
