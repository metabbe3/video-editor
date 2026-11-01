// Timeline — the single shared timebase. Preview, render and export all map
// edited-time <-> source-time through this module so a cut lands in the same
// place everywhere. Frame and sample positions are derived from integers
// (frame index, sample index) — never accumulated floats.
//
// SEQUENCES: keep[] is an ORDERED SEQUENCE (cold opens may reorder). Segments
// play in input order; source times may jump backward between neighbors.
// Callers pass pre-normalized, non-overlapping keeps (edit-engine.normalizeKeeps).

import { speedCurveDuration } from './clip-ops.js';

export function buildTimeline(keep, { fps = 30 } = {}) {
  const segs = keep
    .filter((k) => k.out > k.in)
    .map((k) => {
      const curve = k.speedCurve && k.speedCurve.length >= 2 ? k.speedCurve : null;
      const rate = curve
        ? (k.out - k.in) / speedCurveDuration(k.out - k.in, curve)
        : (k.speed > 0 ? k.speed : 1); // QaGate blocks bad speeds; guard div-by-0 anyway
      const freeze = k.freeze > 0 ? k.freeze : 0; // seconds holding the OUT frame after the clip
      return {
        in: k.in, out: k.out, why: k.why, words: k.words, rate, freeze,
        speedCurve: curve, fadeIn: k.fadeIn, fadeOut: k.fadeOut,
        dur: (k.out - k.in) / rate + freeze,
      };
    }); // input order = play order
  let cum = 0;
  const starts = [];
  for (const s of segs) { starts.push(cum); cum += s.dur; }
  const duration = cum;
  const frameCount = Math.round(duration * fps);
  return {
    fps, segments: segs, starts, duration,
    frameCount,
    frameTime(i) { return i / fps; },
    frameUs(i) { return Math.round((i / fps) * 1e6); },
    sampleIndex(t, sampleRate) { return Math.round(t * sampleRate); },
    /** edited time -> {seg index, source time, frozen?}; t beyond end clamps to last frame */
    editedToSource(t) {
      if (!segs.length) return null;
      if (t >= duration) {
        const s = segs[segs.length - 1];
        return { seg: segs.length - 1, src: s.out };
      }
      let lo = 0, hi = segs.length - 1;
      while (lo < hi) { // last segment whose edited start <= t
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= t) lo = mid; else hi = mid - 1;
      }
      const s = segs[lo];
      const local = t - starts[lo];
      const playLen = (s.out - s.in) / s.rate;
      if (local >= playLen) return { seg: lo, src: s.out, frozen: true }; // freeze tail
      return { seg: lo, src: s.in + local * s.rate };
    },
    /** source time -> edited time, or null if removed. Order-agnostic full scan —
     *  sequences may place a later source span before an earlier one.
     *  Freeze tails are unreachable from source space (by design). */
    sourceToEdited(src) {
      for (let i = 0; i < segs.length; i++) {
        if (src >= segs[i].in && src <= segs[i].out) return starts[i] + (src - segs[i].in) / segs[i].rate;
      }
      return null;
    },
    segmentIndexAtSource(src) {
      for (let i = 0; i < segs.length; i++) if (src >= segs[i].in && src < segs[i].out) return i;
      return null;
    },
    segmentAt(t) {
      const m = this.editedToSource(t);
      return m ? m.seg : null;
    },
  };
}

/**
 * Word-pop caption chunks from kept words, in EDITED time (render-ready).
 * Groups 1..maxWords words, breaking on punctuation, long intra-gaps, AND
 * edited-time discontinuity (source-adjacent words in different sequence
 * segments must not share a chunk).
 */
export function buildCaptions(words, tl, { maxWords = 3, minDur = 0.12 } = {}) {
  const kept = words
    .map((w) => ({ w, t: tl.sourceToEdited(w.start) }))
    .filter((x) => x.t != null && x.w.keep !== false)
    .sort((a, b) => a.t - b.t);
  const chunks = [];
  let cur = null;
  let curSeg = -1;
  const flush = () => {
    if (!cur) return;
    const t0 = tl.sourceToEdited(cur[0].start);
    const t1 = Math.max(tl.sourceToEdited(cur[cur.length - 1].end), t0 + minDur);
    chunks.push({ text: cur.map((w) => w.w).join(' '), t0, t1 });
    cur = null;
  };
  for (const { w, t } of kept) {
    const seg = tl.segmentIndexAtSource(w.start);
    const gap = cur ? w.start - cur[cur.length - 1].end : 0;
    const punctuated = cur && /[.!?…,;:]$/.test(cur[cur.length - 1].w);
    const jumped = cur && seg !== curSeg; // sequence discontinuity -> new chunk
    if (cur && (cur.length >= maxWords || punctuated || gap > 1.0 || jumped)) flush();
    cur = cur || [];
    cur.push(w);
    curSeg = seg;
  }
  flush();
  return chunks;
}
