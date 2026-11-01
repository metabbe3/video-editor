// Edit engine — pure decision logic. No DOM, no fetch. Everything here is
// node-testable and encodes the verified numbers in ANALYSIS.md.
//
// The LLM never emits timestamps: it picks WHAT (word-index ranges); this
// module owns WHEN (word times -> energy snap -> pads -> clamps).

export const TUNING = {
  // silence / pause cutting (ANALYSIS.md §2)
  minSilence: 0.45,        // s — only trim pauses at least this long
  residualPause: 0.2,      // s — what a trimmed pause shrinks to
  pauseGapTrigger: 0.6,    // s — word-gap pause trigger (works w/o energy data)
  padLead: 0.04,           // s — kept audio before a word onset
  padTrail: 0.15,          // s — after offset (releases decay slower than onsets)
  minKeep: 0.12,           // s — keeps are word-bounded, not raw detections; 0.12 keeps
                           // designed residual-pause islands (0.2s) alive, kills artifacts
  snapWindow: 0.2,         // s — boundary snap search around energy minima
  joinFade: 0.012,         // s — audio-only fade at every join
  // whisper word-time compensation
  wordEndMaxExt: 0.3,      // s — word ends run 100-300ms early (§2)
  minWordMs: 50,           // drop shorter spans (hallucination guard)
  // FYP (§3 — tunable defaults, several "rules" are folklore; never hardcode tighter)
  targetLen: [21, 34],     // s
  maxPause: 3,             // s ceiling
  punch: { cutScale: 1.10, emphasisScale: 1.28, ms: 400 },
  captionMaxWords: 3,
  // loudness (§4)
  lufsTarget: -14,
  truePeakCeiling: 0.1,    // dBTP headroom
  // transitions (§2 auto-editor rule): dissolve only when the removed span was long
  transition: { ms: 120, minRemoved: 1.0 },
};

// Heuristic filler set (zero-key mode). GLM judges the nuanced cases ("like").
export const FILLER_RE = /^(u+m+|u+h+|e+r+m+|h+m+|m+-?h+m+|mhm|mm+|ah+|eh+|anu+|e+u+m+|e+hm+|hm+|y+a+h+o+|yaudah+|kira2|gitu deh|gitu dah)[.,!?]*$/i;
// Filler Indonesia (debat 1 Nov P1): 'gitu', 'nah', 'jadi', 'kan', 'ya' hanya filler
// di posisi ulang — jangan potong kata bermakna di kalimat. Deteksi frasa multi-kata:
export const FILLER_ID_PHRASES = [
  'nah jadi', 'jadi gimana', 'gimana ya', 'apa namanya', 'apa namanya ya',
  'gitu loh', 'gitu ya', 'gitu kan', 'kan gitu', 'ya kan', 'tapi ya',
  'jadi ya', 'kalau gitu', 'terus ya', 'pokoknya ya',
];
export const FILLERS_PHRASES = ['you know', 'i mean', 'sort of', 'kind of'];

/** phonetic brand-term corrections (word TEXTS only — timestamps untouched) */
const BRAND_MAP = {
  iphone: 'iPhone', 'ipad': 'iPad', 'macbook': 'MacBook', 'airpods': 'AirPods',
  applecare: 'AppleCare', 'applesupport': 'Apple Support', apple: 'Apple', epel: 'Apple', 'apel': 'Apple',
  magsafe: 'MagSafe', meksafe: 'MagSafe', 'mag-seif': 'MagSafe',
  sofwir: 'software', 'sofwer': 'software', softwer: 'software',
  'andro': 'Android', 'samsul': 'Samsung', 'xeomi': 'Xiaomi',
  'batrei': 'battery', 'updeit': 'update', 'apdeit': 'update', 'friz': 'freeze',
  'wifai': 'WiFi', 'blutut': 'Bluetooth', 'gejl': 'gagal', 'hp': 'HP',
  'tiktok': 'TikTok', 'youtube': 'YouTube', 'instagram': 'Instagram', 'whatsap': 'WhatsApp',
};

/** fix phonetic brand typos in word texts; returns the SAME array (mutated in place,
 *  timestamps never touched). Runs after freezeWords + after GLM word edits. */
export function fixPhonetics(words) {
  for (const w of words) {
    const key = w.w.toLowerCase().replace(/[.,!?;:]+$/, '');
    const fix = BRAND_MAP[key];
    if (fix && w.w !== fix) w.w = w.w.replace(new RegExp(`^${key}`, 'i'), fix);
  }
  return words;
}

/** Guard + freeze the raw transcript. THE array this returns is canonical:
 *  it is what we store, what we send to GLM, and what GLM indices address.
 *  Nothing may filter it afterwards. */
export function freezeWords(raw) {
  const src = raw
    .map((w) => ({ i: 0, w: String(w.w ?? w.text ?? '').trim(), start: +w.start, end: +w.end }))
    .filter((w) => w.w && Number.isFinite(w.start) && Number.isFinite(w.end));
  // monotonic clamp first
  for (let i = 1; i < src.length; i++) {
    if (src[i].start < src[i - 1].start) src[i].start = src[i - 1].start;
    if (src[i].end < src[i].start + 0.02) src[i].end = src[i].start + 0.02;
  }
  // drop sub-50ms spans, then re-index (this is the ONLY filtering pass)
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const w = src[i];
    if (w.end - w.start < TUNING.minWordMs / 1000) continue;
    // whisper end bias: extend up to half the gap to the next word, cap wordEndMaxExt
    const next = src[i + 1]; // original neighbor, so extensions don't compound
    const gap = next ? Math.max(0, next.start - w.end) : Infinity;
    w.end = w.end + Math.min(gap / 2, TUNING.wordEndMaxExt);
    out.push(w);
  }
  out.forEach((w, i) => (w.i = i));
  return out;
}

/** RMS-energy array (per hop) -> silence intervals, hysteresis + min duration. */
export function detectSilence(energy, hopSec, thresholdDb, { hysteresisDb = 3, minSilence = TUNING.minSilence } = {}) {
  const enter = dbToLin(thresholdDb), exit = dbToLin(thresholdDb + hysteresisDb);
  const out = [];
  let s = -1;
  const val = (i) => energy[i] ?? 0;
  for (let i = 0; i < energy.length; i++) {
    const v = val(i);
    if (s < 0 && v < enter) s = i;
    else if (s >= 0 && v > exit) {
      if ((i - s) * hopSec >= minSilence) out.push(interval(energy, s, i - 1, hopSec));
      s = -1;
    }
  }
  if (s >= 0 && (energy.length - s) * hopSec >= minSilence) out.push(interval(energy, s, energy.length - 1, hopSec));
  return out;
}
function interval(energy, a, b, hopSec) {
  let minAt = a, min = Infinity;
  for (let i = a; i <= b; i++) if (energy[i] < min) { min = energy[i]; minAt = i; }
  return { start: a * hopSec, end: (b + 1) * hopSec, minAt: minAt * hopSec };
}
export const dbToLin = (db) => 10 ** (db / 20);
export const linToDb = (v) => 20 * Math.log10(Math.max(v, 1e-12));

const PLOSIVE_RE = /^[ptkbdg]/i;

/** Adaptive pad calculation per word based on neighboring gaps and phonetics */
export function adaptivePads(word, prevWord = null, nextWord = null) {
  const gapPrev = prevWord && Number.isFinite(prevWord.end) ? Math.max(0, (word?.start ?? 0) - prevWord.end) : 0.5;
  const gapNext = nextWord && Number.isFinite(nextWord.start) ? Math.max(0, nextWord.start - (word?.end ?? 0)) : 0.5;
  let padLead = Math.min(0.12, Math.max(0.04, gapPrev * 0.25));
  let padTail = Math.min(0.18, Math.max(0.06, gapNext * 0.25));

  // Plosive (/p|t|k|b|d|g/ at word onset) -> minimum 80ms silence before burst
  const cleanWord = String(word?.w ?? '').replace(/^[^a-zA-Z]+/, '');
  if (PLOSIVE_RE.test(cleanWord)) {
    padLead = Math.max(padLead, 0.08);
  }
  return { padLead, padTail };
}

/**
 * Voice-activity guard: avoids placing a cut boundary inside a sustained
 * high-energy voicing plateau (> threshold * 0.5 for > 80ms across the boundary).
 * Shifts the boundary to the edge of the voiced segment.
 */
export function voiceActivityGuard(t, energy, hopSec, threshold = 0.02, mode = 'in') {
  if (!energy || !energy.length || hopSec <= 0) return t;
  const linThresh = threshold < 0 ? dbToLin(threshold) : (threshold ?? 0.02);
  const voiceThresh = linThresh * 0.5;
  const minDurationHops = Math.ceil(0.08 / hopSec); // > 80ms sustained

  const idx = Math.max(0, Math.min(energy.length - 1, Math.round(t / hopSec)));
  if (energy[idx] <= voiceThresh) return t; // not inside high energy segment

  // Find contiguous segment around idx where energy > voiceThresh
  let left = idx;
  while (left > 0 && energy[left - 1] > voiceThresh) left--;
  let right = idx;
  while (right < energy.length - 1 && energy[right + 1] > voiceThresh) right++;

  const segmentHops = right - left + 1;
  if (segmentHops >= minDurationHops) {
    if (mode === 'in') {
      return Math.max(0, left * hopSec);
    } else if (mode === 'out') {
      return Math.min(energy.length * hopSec, (right + 1) * hopSec);
    } else {
      const distL = idx - left;
      const distR = right - idx;
      return (distL <= distR ? left : right + 1) * hopSec;
    }
  }
  return t;
}

/**
 * Asymmetric energy snap:
 * - cut-IN: snaps to energy rising edge (attack) after the local minimum
 * - cut-OUT: snaps to energy falling edge (release)
 * Includes Whisper drift guard against wordBoundary and voice activity guard.
 */
export function snapAsymmetricBoundary(t, energy, hopSec, {
  mode = 'in',
  wordBoundary = null,
  threshold = 0.02,
  window = TUNING.snapWindow,
} = {}) {
  if (!energy || !energy.length || hopSec <= 0) return t;

  const guarded = voiceActivityGuard(t, energy, hopSec, threshold, mode);
  if (guarded !== t) return guarded;

  const c = Math.round(t / hopSec);
  const r = Math.round(window / hopSec);
  const startIdx = Math.max(0, c - r);
  const endIdx = Math.min(energy.length - 1, c + r);
  const linThresh = threshold < 0 ? dbToLin(threshold) : (threshold ?? 0.02);

  let bestIdx = c;
  if (mode === 'in') {
    let minIdx = startIdx, minVal = Infinity;
    for (let i = startIdx; i <= endIdx; i++) {
      if (energy[i] < minVal) { minVal = energy[i]; minIdx = i; }
    }
    const riseThresh = minVal + 0.15 * Math.max(1e-4, linThresh * 0.5 - minVal);
    let edgeIdx = minIdx;
    for (let i = minIdx; i <= endIdx; i++) {
      if (energy[i] > riseThresh && i > minIdx) {
        edgeIdx = i;
        break;
      }
    }
    bestIdx = edgeIdx;
  } else {
    let minIdx = endIdx, minVal = Infinity;
    for (let i = endIdx; i >= startIdx; i--) {
      if (energy[i] < minVal) { minVal = energy[i]; minIdx = i; }
    }
    const fallThresh = minVal + 0.15 * Math.max(1e-4, linThresh * 0.5 - minVal);
    let edgeIdx = minIdx;
    for (let i = minIdx; i >= startIdx; i--) {
      if (energy[i] > fallThresh && i < minIdx) {
        edgeIdx = i + 1;
        break;
      }
    }
    bestIdx = edgeIdx;
  }

  let snapResult = bestIdx * hopSec;

  if (wordBoundary != null && Math.abs(snapResult - wordBoundary) > 0.06) {
    const wbIdx = Math.max(0, Math.min(energy.length - 1, Math.round(wordBoundary / hopSec)));
    const wbR = Math.round(0.04 / hopSec);
    let wbMinVal = Infinity;
    for (let i = Math.max(0, wbIdx - wbR); i <= Math.min(energy.length - 1, wbIdx + wbR); i++) {
      if (energy[i] < wbMinVal) wbMinVal = energy[i];
    }
    const snapVal = energy[bestIdx] ?? Infinity;
    if (wbMinVal < linThresh || wbMinVal <= snapVal * 2.5) {
      snapResult = wordBoundary;
    }
  }

  return snapResult;
}

export function snapCutIn(t, energy, hopSec, opts = {}) {
  return snapAsymmetricBoundary(t, energy, hopSec, { ...opts, mode: 'in' });
}

export function snapCutOut(t, energy, hopSec, opts = {}) {
  return snapAsymmetricBoundary(t, energy, hopSec, { ...opts, mode: 'out' });
}

/** Per-file calibration: midpoint between quiet (room tone) and speech levels. */
export function calibrateThreshold(energy) {
  const sorted = Float64Array.from(energy).sort();
  const q = (p) => linToDb(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]);
  return (q(0.1) + q(0.9)) / 2;
}

/** Move a boundary to the nearest energy minimum within ±window (0.2s, §2). */
export function snapToEnergyMin(t, energy, hopSec, window = TUNING.snapWindow) {
  const c = Math.round(t / hopSec);
  const r = Math.round(window / hopSec);
  let best = t, bestV = Infinity;
  for (let i = Math.max(0, c - r); i <= Math.min(energy.length - 1, c + r); i++) {
    if (energy[i] < bestV) { bestV = energy[i]; best = i * hopSec; }
  }
  return best;
}

/** Zero-key baseline: keep-ranges from words (+ optional silence/energy). */
export function heuristicKeeps(words, duration, { silence = [], energy = null, hopSec = 0.02, tuning = TUNING } = {}) {
  const removals = [];
  const add = (start, end, why) => { if (end - start > 0.02) removals.push({ start, end, why }); };

  // 1. standalone filler words — cut TIGHT at word boundaries (word removal, not
  // silence removal: the big pads would eat most of a 0.2s "um")
  for (const w of words) if (FILLER_RE.test(w.w)) add(w.start - 0.02, w.end + 0.06, `filler: ${w.w}`);

  // 1b. Indonesian filler PHRASES (multi-word) — joined lowercase text, position-aware
  // (debat 1 Nov P1: 'nah jadi', 'gitu ya', 'apa namanya' dsb.)
  const textAt = (i) => words[i].w.toLowerCase().replace(/[.,!?;:]+$/, '');
  for (let i = 0; i < words.length - 1; i++) {
    for (const ph of FILLER_ID_PHRASES) {
      const parts = ph.split(' ');
      let match = true;
      for (let j = 0; j < parts.length; j++) {
        if (i + j >= words.length || textAt(i + j) !== parts[j]) { match = false; break; }
      }
      if (match) { add(words[i].start - 0.02, words[i + parts.length - 1].end + 0.06, `filler-id: ${ph}`); i += parts.length - 1; break; }
    }
  }

  // 2. long pauses from the silence map (cut centered on the energy minimum)
  for (const s of silence) {
    if (s.end - s.start < tuning.minSilence) continue;
    const half = tuning.residualPause / 2;
    add(s.start, (s.minAt ?? (s.start + s.end) / 2) - half, 'pause');
    add((s.minAt ?? (s.start + s.end) / 2) + half, s.end, 'pause');
  }

  // 3. word-gap pauses (transcript-only fallback; also trims breath the detector missed)
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap > tuning.pauseGapTrigger) {
      const half = tuning.residualPause / 2;
      const mid = (words[i - 1].end + words[i].start) / 2;
      add(words[i - 1].end, mid - half, 'gap');                    // front of the gap
      add(mid + half, words[i].start - tuning.padLead, 'gap');     // back of the gap
    }
  }

  let keeps = invert(removals, duration);
  // snap boundaries using wave-aware asymmetric snapping when energy curve is available
  if (energy) {
    const thresh = calibrateThreshold(energy);
    keeps = keeps.map((k) => ({
      ...k,
      in: Math.max(0, snapCutIn(k.in, energy, hopSec, { threshold: thresh })),
      out: Math.min(duration, snapCutOut(k.out, energy, hopSec, { threshold: thresh })),
    }));
  }
  return normalizeKeeps(keeps, duration, tuning);
}

function invert(removals, duration) {
  const sorted = removals.sort((a, b) => a.start - b.start)
    .reduce((acc, r) => {
      const last = acc[acc.length - 1];
      if (last && r.start <= last.end) { last.end = Math.max(last.end, r.end); last.why ||= r.why; }
      else acc.push({ ...r });
      return acc;
    }, []);
  const keeps = [];
  let t = 0;
  for (const r of sorted) { if (r.start > t) keeps.push({ in: t, out: r.start, why: 'speech' }); t = Math.max(t, r.end); }
  if (t < duration) keeps.push({ in: t, out: duration, why: 'speech' });
  return keeps;
}

/**
 * Normalize keeps while PRESERVING INPUT (play) ORDER — sequences may be
 * non-chronological (cold opens). Overlap/bridge decisions are made against a
 * sorted shadow; overlapping entries are trimmed (never merged — merging a
 * [100-102, 10-20] sequence would delete content), tiny ones absorbed.
 */
export function normalizeKeeps(keeps, duration, tuning = TUNING) {
  const valid = keeps
    .filter((k) => k.out > k.in)
    .map((k) => ({ ...k, in: Math.max(0, k.in), out: Math.min(duration, k.out), _drop: false }));
  const sorted = [...valid].sort((a, b) => a.in - b.in);
  let lastAccepted = null;
  for (const k of sorted) {
    if (k.out - k.in < tuning.minKeep) { k._drop = true; continue; }
    if (lastAccepted && k.in <= lastAccepted.out + tuning.minKeep) {
      // chronological bridge/overlap: extend the neighbor, absorb this entry
      // (content plays once; the surviving keep keeps its own sequence slot)
      lastAccepted.out = Math.max(lastAccepted.out, k.out);
      lastAccepted.why ||= k.why;
      k._drop = true;
    } else lastAccepted = k;
  }
  return valid.filter((k) => !k._drop && k.out > k.in);
}

/** GLM keep-range response -> validated keeps/emphases/brollHints. Never trusts input. */
export class ValidationError extends Error {}

export function applyGlm(response, words, duration, { energy = null, hopSec = 0.02, tuning = TUNING } = {}) {
  let obj = response;
  if (typeof obj === 'string') obj = JSON.parse(salvageJsonArrays(obj));
  if (!obj || typeof obj !== 'object') throw new ValidationError('response is not an object');
  const n = words.length;
  const wild = (i) => !Number.isFinite(i) || i < -n * 0.05 || i > n * 1.05; // >5% out of range: drop, don't clamp

  const parseKeeps = (list) => {
    const keeps = [];
    for (const k of list || []) {
      const from = Math.floor(Number(k?.from)), to = Math.floor(Number(k?.to));
      if (wild(from) || wild(to)) continue;
      const f = Math.max(0, Math.min(n - 1, from));
      const t = Math.max(0, Math.min(n - 1, to));
      const [a, b] = t < f ? [t, f] : [f, t];
      let inT = words[a].start - tuning.padLead;
      let outT = words[b].end + tuning.padTrail;
      if (tuning.adaptivePads) {
        const prevWord = a > 0 ? words[a - 1] : null;
        const nextWord = b < n - 1 ? words[b + 1] : null;
        const pads = adaptivePads(words[a], prevWord, nextWord);
        inT = words[a].start - pads.padLead;
        outT = words[b].end + pads.padTail;
      }
      if (energy) {
        const thresh = calibrateThreshold(energy);
        inT = snapCutIn(inT, energy, hopSec, { wordBoundary: words[a].start, threshold: thresh });
        outT = snapCutOut(outT, energy, hopSec, { wordBoundary: words[b].end, threshold: thresh });
      }
      const score = Math.max(0, Math.min(100, Math.round(Number(k?.score) || 0)));
      keeps.push({ in: Math.max(0, inT), out: Math.min(duration, outT), why: `glm: ${k?.why || ''}`.trim(), words: [a, b], score });
    }
    return normalizeKeeps(keeps, duration, tuning);
  };

  const emphases = [...new Set((Array.isArray(obj.emphases) ? obj.emphases : [])
    .map((i) => Math.floor(Number(i))).filter((i) => Number.isFinite(i) && i >= 0 && i < n))];
  const brollHints = (Array.isArray(obj.brollHints) ? obj.brollHints : [])
    .map((h) => {
      const from = Math.max(0, Math.min(n - 1, Math.floor(Number(h?.from) || 0)));
      const to = Math.max(from, Math.min(n - 1, Math.floor(Number(h?.to) || from)));
      return { from, to, topic: String(h?.topic || '').slice(0, 80) };
    })
    .filter((h) => h.from !== h.to);
  const passthrough = (list) => (Array.isArray(list) ? list : [])
    .map((h) => {
      const from = Math.floor(Number(h?.from)), to = Math.floor(Number(h?.to));
      if (wild(from) || wild(to)) return null;
      const a = Math.max(0, Math.min(n - 1, from));
      const b = Math.max(a, Math.min(n - 1, to));
      return { from: a, to: b, title: String(h?.title || '').slice(0, 60), why: String(h?.why || '').slice(0, 80) };
    })
    .filter((x) => x && x.to > x.from);
  const meta = {
    emphases,
    brollHints,
    chapters: passthrough(obj.chapters).map((c) => ({ from: c.from, to: c.to, title: c.title })),
    suggestedCuts: passthrough(obj.suggestedCuts).map((c) => ({ from: c.from, to: c.to, why: c.why })),
    hookTitle: typeof obj.hookTitle === 'string' ? obj.hookTitle.slice(0, 90) : '',
    selfCritique: typeof obj.selfCritique === 'string' ? obj.selfCritique.slice(0, 300) : '',
    confidence: Math.max(0, Math.min(1, Number(obj.confidence) || 0)),
    debateLog: (Array.isArray(obj.debate_log) ? obj.debate_log : []).map((d) => ({
      blockId: String(d?.blockId || '').slice(0, 20),
      rhythmArgument: String(d?.rhythmArgument || '').slice(0, 160),
      scriptwriterCounter: String(d?.scriptwriterCounter || '').slice(0, 160),
      managerialVerdict: String(d?.managerialVerdict || '').slice(0, 160),
      scoreImpact: String(d?.scoreImpact || '').slice(0, 30),
    })).filter((d) => d.rhythmArgument || d.managerialVerdict),
  };

  if (Array.isArray(obj.clips) && obj.clips.length) {
    const variants = obj.clips
      .map((c) => ({
        title: String(c?.title || 'clip').slice(0, 60),
        hookTitle: String(c?.hookTitle || '').slice(0, 90),
        keeps: parseKeeps(c?.keeps),
        score: Math.max(0, Math.min(100, Math.round(Number(c?.score) || 0))),
      }))
      .filter((v) => v.keeps.length);
    if (!variants.length) throw new ValidationError('response clips[] contain no valid keeps');
    return { variants, ...meta };
  }
  if (Array.isArray(obj.keeps) && obj.keeps.length) {
    const keeps = parseKeeps(obj.keeps);
    if (!keeps.length) throw new ValidationError('response has no valid keeps');
    return { variants: [{ title: 'edit', hookTitle: meta.hookTitle, keeps, score: 0 }], keeps, ...meta };
  }
  throw new ValidationError('response has no keeps[] or clips[]');
}

/** Repair JSON truncated mid-array: keep only up to the last complete element. */
export function salvageJsonArrays(text) {
  let s = text.trim().replace(/^```(json)?|```$/g, '').trim();
  try { JSON.parse(s); return s; } catch { /* repair below */ }
  for (const key of ['suggestedCuts', 'chapters', 'brollHints', 'emphases', 'keeps', 'clips']) {
    const keyAt = s.indexOf(`"${key}"`);
    if (keyAt < 0) continue;
    const ob = s.indexOf('[', keyAt);
    if (ob < 0) continue;
    let depth = 0, inStr = false, esc = false, lastEl = -1, complete = false;
    for (let i = ob; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        depth--;
        if (depth === 0 && c === ']') { complete = true; break; }
        if (depth === 1 && c === '}') lastEl = i;
      }
    }
    if (complete) continue;
    s = lastEl >= 0 ? s.slice(0, lastEl + 1) + ']' : s.slice(0, ob + 1) + ']';
    break;
  }
  const open = (s.match(/\{/g) || []).length, close = (s.match(/\}/g) || []).length;
  if (open > close) s += '}'.repeat(open - close);
  return s;
}

/** FYP pass: hook trim, target length, join punch-ins, emphasis punches, B-roll slots. */
export function planFyp(keeps, words, tl, { emphases = [], brollHints = [], tuning = TUNING } = {}) {
  if (!words?.length) return { emphases, brollHints }; // guard: no transcript yet — nothing to plan
  const kept = keeps.slice();
  // hook: first keep starts at its first word onset (no dead air at t=0)
  const first = kept[0];
  if (first) {
    const w0 = words.find((w) => w.start >= first.in - 0.01 && w.end <= first.out + 0.01);
    if (w0) first.in = Math.max(first.in, w0.start - 0.06);
  }
  // target length: drop lowest word-density keeps (never the hook) until <= max.
  // noTrim presets (long-form assembly) never force-shrink — chapters survive.
  if (!tuning.noTrim) {
    const counts = new Map();
    for (const w of words) {
      for (let i = 0; i < kept.length; i++) {
        const k = kept[i];
        if (w.start >= k.in && w.end <= k.out) { counts.set(i, (counts.get(i) || 0) + 1); break; }
      }
    }
    while (kept.length > 1 && kept.reduce((a, k) => a + k.out - k.in, 0) > tuning.targetLen[1]) {
      let worst = 1, worstScore = Infinity;
      for (let i = 1; i < kept.length; i++) {
        const d = (counts.get(i) || 0) / (kept[i].out - kept[i].in);
        if (d < worstScore) { worstScore = d; worst = i; }
      }
      kept.splice(worst, 1);
      counts.delete(worst);
    }
  }
  const T = tl(kept);
  const punches = [];
  if (tuning.joinPunches !== false) {
    const alt = [tuning.punch.cutScale, Math.min(1.15, tuning.punch.cutScale + 0.05)];
    let n = 0, lastAt = -Infinity;
    for (let i = 1; i < kept.length; i++) {
      const removed = kept[i].in - kept[i - 1].out;
      if (removed <= TUNING.transition.minRemoved) continue;
      const at = T.starts[i];
      if (at - lastAt < 0.4) continue;
      punches.push({ at, scale: alt[n++ % alt.length], ms: tuning.punch.ms, kind: 'cut' });
      lastAt = at;
    }
  }
  for (const wi of emphases) {
    const w = words[wi]; if (!w) continue;
    const at = T.sourceToEdited((w.start + w.end) / 2);
    if (at == null) continue;
    if (punches.some((p) => Math.abs(p.at - at) < 0.4)) continue;
    punches.push({ at, scale: tuning.punch.emphasisScale, ms: tuning.punch.ms, kind: 'emphasis' });
  }
  punches.sort((a, b) => a.at - b.at);
  const broll = brollHints.map((h) => {
    const at = T.sourceToEdited(words[h.from].start);
    if (at == null) return null;
    return { at, dur: Math.min(7, Math.max(3, words[h.to].end - words[h.from].start)), topic: h.topic };
  }).filter(Boolean);
  return { keeps: kept, punches, broll, timeline: T };
}

/**
 * Crossfade schedule from the keep SEQUENCE: a dissolve ending exactly at each
 * join whose removed span exceeded minRemoved. Joins are sequence-neighbors;
 * reorder joins have negative removed spans -> naturally hard cuts.
 */
export function transitionsFor(keep, { minRemoved = TUNING.transition.minRemoved, ms = TUNING.transition.ms } = {}) {
  const out = [];
  let cum = 0;
  for (let i = 0; i < keep.length; i++) {
    if (i > 0 && keep[i].in - keep[i - 1].out > minRemoved) out.push({ at: cum, ms });
    cum += (keep[i].out - keep[i].in) / (keep[i].speed > 0 ? keep[i].speed : 1) + (keep[i].freeze > 0 ? keep[i].freeze : 0);
  }
  return out;
}

/** sentence spans from transcript punctuation: [{from, to}] inclusive word indices */
export function sentenceSpans(words) {
  const spans = [];
  let start = 0;
  for (let i = 0; i < words.length; i++) {
    if (/[.!?…]$/.test(words[i].w) || i === words.length - 1) {
      if (i >= start) spans.push({ from: start, to: i });
      start = i + 1;
    }
  }
  return spans;
}

/**
 * Manual transcript edits win over BOTH the heuristic and GLM sources:
 * `keeps` force-keeps word indices (union), `cuts` force-cuts them (subtract).
 * Re-run on every source switch so user intent survives GLM/local toggling.
 */
export function applyManualOverrides(keeps, words, overrides = {}, duration) {
  const cuts = overrides.cuts || [];
  const force = overrides.keeps || [];
  if (!cuts.length && !force.length) return keeps;
  const dur = duration ?? keeps.reduce((a, k) => Math.max(a, k.out), 0);
  const seed = keeps.map((k) => ({ ...k }));
  for (const i of force) {
    const w = words[i];
    if (w) seed.push({ in: w.start - TUNING.padLead, out: w.end + TUNING.padTrail, why: 'manual' });
  }
  let merged = normalizeKeeps(seed, dur);
  for (const c of cuts) {
    // word indices OR {from,to} ranges (approved suggested cuts) — ranges get ONE
    // subtract so the span is removed atomically, then slivers are size-filtered
    // (no re-bridging: re-bridging would undo the cut the user just approved)
    if (typeof c === 'object' && c !== null && Number.isFinite(c.from) && Number.isFinite(c.to)) {
      const a = words[Math.max(0, Math.min(words.length - 1, c.from))];
      const b = words[Math.max(0, Math.min(words.length - 1, c.to))];
      if (a && b) merged = subtractRange(merged, Math.min(a.start, b.start) - 0.02, Math.max(a.end, b.end) + 0.06)
        .filter((k) => k.out - k.in >= TUNING.minKeep);
    } else {
      const w = words[c];
      if (w) merged = subtractRange(merged, w.start - 0.02, w.end + 0.06);
    }
  }
  // stale word ranges lie to the next GLM pass — recompute or drop
  return merged.map((k) => {
    const a = words.findIndex((w) => w.end > k.in);
    let b = -1;
    for (let i = words.length - 1; i >= 0; i--) if (words[i].start < k.out) { b = i; break; }
    return b >= a && a >= 0 ? { ...k, words: [a, b] } : { ...k, words: undefined };
  });
}

function subtractRange(keeps, s, e) {
  const out = [];
  for (const k of keeps) {
    if (e <= k.in || s >= k.out) { out.push(k); continue; }
    if (s > k.in) out.push({ ...k, out: s });
    if (e < k.out) out.push({ ...k, in: e });
  }
  return out.filter((k) => k.out - k.in > 0.02);
}

/** Derived view for the UI: the removed spans (what was cut and why). */
export function removedView(keeps, duration) {
  const out = [];
  let t = 0;
  for (const k of [...keeps].sort((a, b) => a.in - b.in)) {
    if (k.in > t) out.push({ start: t, end: k.in, why: k.why === 'speech' ? 'silence' : 'removed' });
    t = Math.max(t, k.out);
  }
  if (t < duration) out.push({ start: t, end: duration, why: 'tail' });
  return out;
}

// ---- loudness: BS.1770 K-weighting + gating (48 kHz, mono) ----
const K1 = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [1, -1.69065929318241, 0.73248077421585] };
const K2 = { b: [1, -2, 1], a: [1, -1.99004745483398, 0.99007225036621] };

export function biquad(x, { b, a }) {
  const y = new Float32Array(x.length);
  let z1 = 0, z2 = 0;
  const a1 = -a[1], a2 = -a[2];
  for (let i = 0; i < x.length; i++) {
    const v = x[i] * b[0] + z1;
    z1 = x[i] * b[1] + z2 + a1 * v;
    z2 = x[i] * b[2] + a2 * v;
    y[i] = v;
  }
  return y;
}

/** Integrated LUFS (gated). pcm must be 48 kHz mono. */
export function measureLufs(pcm, rate = 48000) {
  if (rate !== 48000) throw new Error('K-weighting coefficients are 48 kHz only');
  const k = biquad(biquad(pcm, K1), K2);
  const block = Math.round(0.4 * rate), hop = Math.round(0.1 * rate);
  const blocks = [];
  for (let i = 0; i + block <= k.length; i += hop) {
    let ms = 0;
    for (let j = i; j < i + block; j++) ms += k[j] * k[j];
    blocks.push(ms / block);
  }
  if (!blocks.length) return -70;
  const loud = (ms) => -0.691 + 10 * Math.log10(Math.max(ms, 1e-12));
  const absKept = blocks.filter((ms) => loud(ms) > -70);
  if (!absKept.length) return -70;
  const relThreshold = loud(absKept.reduce((a, ms) => a + ms, 0) / absKept.length) - 10;
  const relKept = absKept.filter((ms) => loud(ms) > relThreshold);
  const pool = relKept.length ? relKept : absKept;
  return loud(pool.reduce((a, ms) => a + ms, 0) / pool.length);
}

export function peakDb(pcm) {
  let p = 0;
  for (let i = 0; i < pcm.length; i++) p = Math.max(p, Math.abs(pcm[i]));
  return linToDb(p);
}

// ---- audio polish chain (pre-LUFS): 80 Hz high-pass + RMS-anchored soft-knee ----
// (reuses the module's private biquad from the K-weighting code above)

/** RBJ 80 Hz Butterworth high-pass (Q = 1/√2) at `rate`. */
export function highPass80(pcm, rate = 48000) {
  const w0 = (2 * Math.PI * 80) / rate;
  const cos = Math.cos(w0), sin = Math.sin(w0), Q = Math.SQRT1_2, alpha = sin / (2 * Q);
  const a0 = 1 + alpha;
  return biquad(pcm, {
    b: [(1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0],
    a: [1, (-2 * cos) / a0, (1 - alpha) / a0],
  });
}

/**
 * Soft-knee compressor ANCHORED to the program's own RMS (fixed thresholds
 * no-op quiet mics and pump hot ones). Threshold = RMS−6 dB, ratio 2:1,
 * attack ~8ms, release ~90ms, NO makeup gain — the LUFS stage sets level.
 */
export function compressProgram(pcm, rate = 48000, { ratio = 2, kneeDb = 6 } = {}) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  const rmsDb = linToDb(Math.sqrt(sum / Math.max(1, pcm.length)));
  const threshDb = rmsDb - 6;
  const atk = Math.max(1, Math.round(0.008 * rate));
  const rel = Math.max(1, Math.round(0.09 * rate));
  const out = new Float32Array(pcm.length);
  let env = 0; // dB above threshold, smoothed
  for (let i = 0; i < pcm.length; i++) {
    const db = linToDb(Math.abs(pcm[i])) - threshDb;
    const target = Math.max(0, db);
    const k = target > env ? atk : rel; // rise slow (attack), fall slower (release)
    env += (target - env) / k;
    const over = env - kneeDb / 2;
    const reduction = over > 0 ? (over + kneeDb / 2) * (1 - 1 / ratio) - kneeDb / 4 : over > -kneeDb / 2 ? ((over + kneeDb / 2) ** 2) / (2 * kneeDb) * (1 - 1 / ratio) : 0;
    out[i] = pcm[i] * dbToLin(-Math.max(0, reduction));
  }
  return out;
}

/** Gain (linear) to hit target LUFS with true-peak safety (§4). */
export function loudnessGain(pcm, rate = 48000, target = TUNING.lufsTarget) {
  const db = Math.min(target - measureLufs(pcm, rate), -peakDb(pcm) - TUNING.truePeakCeiling);
  return { gainLinear: dbToLin(db), gainDb: db };
}
