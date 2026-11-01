// AudioMix — BGM auto-ducking envelope + SFX scheduling. Pure (node-testable).

const dbToLin = (db) => 10 ** (db / 20);

/**
 * Per-`stepMs` gain envelope for a BGM bed under speech. Speaking windows are
 * word spans padded by `release`; between them the bed returns to idle with an
 * attack/release-ramped transition (no clicks).
 */
export function computeDuckEnvelope(words, tl, {
  stepMs = 50, activeDb = -20, idleDb = -8, attackMs = 120, releaseMs = 450,
} = {}) {
  // speaking spans in EDITED time
  const spans = [];
  for (const w of words) {
    const s = tl.sourceToEdited(w.start);
    const e = tl.sourceToEdited(w.end);
    if (s == null || e == null) continue;
    spans.push([s, e]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const total = tl.duration;
  const active = dbToLin(activeDb), idle = dbToLin(idleDb);
  const env = [];
  let cur = idle;
  for (let t = 0; t <= total; t += stepMs / 1000) {
    const speaking = spans.some(([s, e]) => t >= s - releaseMs / 1000 && t <= e + releaseMs / 1000);
    const target = speaking ? active : idle;
    // exponential approach — attack when going down (ducking in), release coming back
    const k = target < cur ? attackMs : releaseMs;
    cur += (target - cur) * Math.min(1, (stepMs / k) * 3);
    env.push(+cur.toFixed(4));
  }
  return env;
}

/** SFX events at every sequence join + every zoom punch (80ms pre-roll). */
export function scheduleSfx(edl, { kinds = { join: 'whoosh', punch: 'pop' } } = {}) {
  const events = [];
  const seen = new Set();
  const push = (at, kind) => {
    const key = `${kind}@${at.toFixed(2)}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push({ at: Math.max(0, at - 0.08), kind, gainDb: -14 });
  };
  for (let i = 1; i < edl.keep.length; i++) push(i * 0 + timelineJoinAt(edl, i), kinds.join);
  for (const p of edl.punches || []) push(p.at, kinds.punch);
  return events.sort((a, b) => a.at - b.at);
}

function timelineJoinAt(edl, i) {
  // join time = cumulative edited length up to segment i
  let cum = 0;
  for (let j = 0; j < i; j++) cum += edl.keep[j].out - edl.keep[j].in;
  return cum;
}

/** J-cut lead for tight joins: audio of the NEXT segment starts `lead` before its
 *  picture cut (sample math helper — returns the audio-side in-point per segment). */
export function audioInFor(keep, i, { lead = 0.2, tightMax = 0.6 } = {}) {
  if (i === 0) return keep[0].in;
  const removed = keep[i].in - keep[i - 1].out;
  return removed > 0 && removed <= tightMax ? keep[i].in - Math.min(lead, removed * 0.8) : keep[i].in;
}

/** synthesized SFX render into a PCM buffer — the procedural sound library:
 *  whoosh (swept bandpass noise), pop (sine tick), riser, impact, click, ting */
export const SFX_PRESETS = ['whoosh', 'pop', 'riser', 'impact', 'click', 'ting'];

export function renderSfx(kind, rate, gainDb) {
  const gain = dbToLin(gainDb);
  if (kind === 'pop') {
    const n = Math.round(0.008 * rate);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.sin(2 * Math.PI * 1200 * (i / rate)) * Math.sin(Math.PI * i / n) * gain;
    return out;
  }
  if (kind === 'click') {
    const n = Math.round(0.02 * rate);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i / n;
      out[i] = (Math.sin(2 * Math.PI * 2000 * p) * (1 - p) ** 2 * 0.35 + (Math.random() * 2 - 1) * (1 - p) ** 3 * 0.4) * gain;
    }
    return out;
  }
  if (kind === 'ting') {
    const n = Math.round(0.9 * rate);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const env = Math.exp(-t * 5);
      out[i] = (Math.sin(2 * Math.PI * 1568 * t) + 0.5 * Math.sin(2 * Math.PI * 3136 * t)) * env * gain * 0.5;
    }
    return out;
  }
  if (kind === 'impact') {
    const n = Math.round(0.5 * rate);
    const out = new Float32Array(n);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate, p = i / n;
      const a = 1 - Math.exp((-2 * Math.PI * (120 + 80 * (1 - p))) / rate);
      lp += a * ((Math.random() * 2 - 1) - lp);
      const thump = Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t * 5);
      out[i] = (lp * 0.7 + thump) * Math.exp(-t * 7) * gain;
    }
    return out;
  }
  if (kind === 'riser') { // whoosh's longer, amplitude-rising sibling
    const n = Math.round(0.8 * rate);
    const out = new Float32Array(n);
    let y = 0, lp = 0;
    for (let i = 0; i < n; i++) {
      const p = i / n;
      const env = p ** 2 * (1 - ((p - 1) ** 8)); // slow build, hard stop
      const f = 300 + 3000 * p ** 1.5;
      const a = 1 - Math.exp((-2 * Math.PI * f) / rate);
      const x = Math.random() * 2 - 1;
      y += a * (x - y);
      lp += a * (y - lp);
      out[i] = lp * env * gain;
    }
    return out;
  }
  // whoosh (default)
  const dur = 0.4, n = Math.round(dur * rate);
  const out = new Float32Array(n);
  let y = 0, lp = 0;
  for (let i = 0; i < n; i++) {
    const p = i / n;
    const env = Math.sin(Math.PI * p) ** 2;
    const f = 400 + 2400 * p;
    const a = 1 - Math.exp((-2 * Math.PI * f) / rate);
    const x = Math.random() * 2 - 1;
    y += a * (x - y);
    lp += a * (y - lp);
    out[i] = lp * env * gain;
  }
  return out;
}
