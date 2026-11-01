// Captions — word-level state machine + Strategy templates.
// Each template owns its CHUNKING POLICY (words per line) and its DRAW.
// Words carry ms-accurate {text,start,end,isKeyword} so past/active/future is exact.

import { spring } from '../../../engine/motion.js';

export const CAPTION_STYLES = {
  hormozi: {
    label: 'Hormozi / Impact', wordsPerLine: 3, upper: true,
    font: (s) => `900 ${s}px Montserrat, Impact, system-ui, sans-serif`,
    base: '#FFFFFF', active: '#FFE600', keyword: '#00FF66',
  },
  karaoke: {
    label: 'Sliding Pill', wordsPerLine: 4, upper: false,
    font: (s) => `700 ${s}px system-ui, sans-serif`,
    base: '#FFFFFF', active: '#FFE600', keyword: '#00FF66', pill: true,
  },
  glass: {
    label: 'Frosted Glass', wordsPerLine: 7, upper: false,
    font: (s) => `500 ${s * 0.82}px system-ui, sans-serif`,
    base: '#F5F4EF', active: '#F5F4EF', keyword: '#FFD9A8', clause: true, slide: true,
  },
  pop: {
    label: 'Kinetic Pop & Tilt', wordsPerLine: 1, upper: true,
    font: (s) => `800 ${s * 1.1}px system-ui, sans-serif`,
    base: '#FFFFFF', active: '#FFE600', keyword: '#00FF66', tilt: true,
  },
  clean: {
    label: 'YouTube Clean', wordsPerLine: 12, upper: false, sentence: true,
    font: (s) => `500 ${s * 0.72}px Lora, Georgia, serif`,
    base: '#FAF9F5', active: '#FAF9F5', keyword: '#FAF9F5', vignette: true,
  },
};

/** word-level states for one caption line at time t (seconds) */
export function wordStates(line, t) {
  return line.map((w) => ({
    ...w,
    state: t < w.start ? 'future' : t <= w.end + 0.05 ? 'active' : 'past',
    p: Math.max(0, Math.min(1, (t - w.start) / Math.max(0.05, w.end - w.start))),
  }));
}

/** chunk kept words per the template's policy (punctuation + width breaks).
 *  Each word carries its ORIGINAL index (red-team #2: keyword matching is
 *  index-based) and edited-time bounds for the state machine. */
export function chunkWords(words, tl, style) {
  const kept = words
    .map((w, i) => ({ w, i, e: tl.sourceToEdited(w.start) }))
    .filter((x) => x.e != null)
    .sort((a, b) => a.e - b.e);
  const maxWords = style.wordsPerLine;
  const breakRe = style.clause ? /[.!?…,;:]$/ : style.sentence ? /[.!?…]$/ : null;
  const lines = [];
  let cur = [];
  const flush = () => { if (cur.length) lines.push(cur); cur = []; };
  for (const { w, i } of kept) {
    const seg = tl.segmentIndexAtSource(w.start);
    const last = cur[cur.length - 1];
    const punct = breakRe && last && breakRe.test(last.text);
    const jumped = last && tl.segmentIndexAtSource(this_srcStart(last)) !== seg;
    if (cur.length >= maxWords || (cur.length && (punct || jumped))) flush();
    cur.push({ text: w.w, i, start: tl.sourceToEdited(w.start), end: tl.sourceToEdited(w.end), isKeyword: w.isKeyword, src: w.start });
  }
  flush();
  return lines;
}
const this_srcStart = (word) => word.src ?? 0;

/** one line, drawn per template */
export function drawLine(ctx, line, t, style, box) {
  const { w, h, baseY, size } = box;
  const states = wordStates(line, t);
  const active = states.find((s) => s.state === 'active');
  if (!active && style.id === 'pop') return; // pop shows only the active word

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  if (style.vignette) {
    const g = ctx.createLinearGradient(0, h * 0.8, 0, h);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = g;
    ctx.fillRect(0, h * 0.8, w, h * 0.2);
  }

  const text = (s) => (style.upper ? s.text.toUpperCase() : s.text);
  ctx.font = style.font(size);
  const gap = ctx.measureText(' ').width * (style.clause ? 0.7 : 1);
  const widths = states.map((s) => ctx.measureText(text(s)).width);
  const total = widths.reduce((a, b) => a + b, 0) + gap * (states.length - 1);

  if (style.pill && active) {
    // rounded pill slides between words
    const i = states.indexOf(active);
    let x = (w - total) / 2;
    for (let j = 0; j < i; j++) x += widths[j] + gap;
    const ease = (v) => 1 - Math.exp(-v * 6);
    ctx.fillStyle = 'rgba(20,20,18,0.85)';
    const px = x - 14 + (widths[i] + 28) * ease(active.p) * 0; // anchor at active word
    roundRect(ctx, x - 14, baseY - size * 0.72, widths[i] + 28, size * 1.44, 12);
    ctx.fill();
  }
  if (style.clause) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    roundRect(ctx, (w - total) / 2 - 22, baseY - size * 0.72, total + 44, size * 1.44, 14);
    ctx.fill();
  }

  let x = (w - total) / 2;
  const cy = baseY;
  states.forEach((s, i) => {
    const isActive = s.state === 'active';
    ctx.save();
    ctx.translate(x + widths[i] / 2, cy);
    if (isActive && !style.clause) {
      const scale = 1 + Math.sin(s.p * Math.PI) * 0.16;
      ctx.scale(scale, scale);
    }
    if (style.tilt) ctx.rotate((i % 2 ? 3 : -3) * Math.PI / 180);
    if (style.slide && s.state !== 'past') {
      ctx.globalAlpha = Math.min(1, s.p * 2.2);
      ctx.translate(0, (1 - Math.min(1, s.p * 2.2)) * 4);
    }
    ctx.font = style.font(size);
    ctx.fillStyle = isActive ? (s.isKeyword ? style.keyword : style.active) : style.base;
    if (!style.clause) {
      ctx.strokeStyle = 'rgba(0,0,0,0.92)';
      ctx.lineWidth = size * 0.16;
      ctx.strokeText(text(s), 0, 0);
    }
    ctx.fillText(text(s), 0, 0);
    ctx.restore();
    x += widths[i] + gap;
  });
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
