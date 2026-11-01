// duck.js — Pure function auto-ducking gain curve for background music.
// Pure decision logic: no DOM, node-testable.
// Part of Nila Sprint 4: Gap-fill bundle.

export const dbToLin = (db) => 10 ** (db / 20);
export const linToDb = (lin) => (lin > 0 ? 20 * Math.log10(lin) : -100);

/**
 * Compute auto-ducking gain curve over time.
 * @param {object} options
 * @param {Float32Array|Array<number>} [options.energy] - Speech energy array from analysis
 * @param {number} [options.hopSec=0.02] - Hop size for energy samples
 * @param {Array<object>} [options.words] - Transcript words {start, end, keep}
 * @param {object} [options.tl] - Timeline instance with sourceToEdited and duration
 * @param {number} [options.duration] - Total edited duration (seconds)
 * @param {number} [options.baseDb=0] - Music idle gain in dB (default 0 dB = 1.0)
 * @param {number} [options.duckDb=-12] - Duck reduction in dB relative to base (default -12 dB)
 * @param {number} [options.attackMs=150] - Ramp down time when speech starts (ms)
 * @param {number} [options.releaseMs=400] - Ramp up time when speech ends (ms)
 * @param {number} [options.threshold=0.04] - RMS threshold to consider energy active
 * @param {number} [options.stepSec=0.05] - Time step between envelope points (seconds)
 * @returns {object} { duration, stepSec, points: Array<{t, gain, db}>, getGainAt: (t) => number }
 */
export function computeDuckGainCurve({
  energy = null,
  hopSec = 0.02,
  words = null,
  tl = null,
  duration = 0,
  baseDb = 0,
  duckDb = -12,
  attackMs = 150,
  releaseMs = 400,
  threshold = 0.04,
  stepSec = 0.05,
} = {}) {
  const totalDur = Math.max(0, duration || (tl ? tl.duration : 0));
  const baseGain = dbToLin(baseDb);
  const duckGain = dbToLin(baseDb + duckDb); // ducked level

  // Determine active speech spans in edited time [s, e]
  const speechSpans = [];

  if (words && words.length && tl) {
    for (const w of words) {
      if (w.keep === false) continue;
      const s = tl.sourceToEdited(w.start);
      const e = tl.sourceToEdited(w.end);
      if (s != null && e != null && e > s) {
        speechSpans.push([s, e]);
      }
    }
  } else if (words && words.length) {
    // Unedited source spans
    for (const w of words) {
      if (w.keep === false) continue;
      if (w.end > w.start) speechSpans.push([w.start, w.end]);
    }
  } else if (energy && energy.length) {
    // Detect spans where energy >= threshold
    let spanStart = null;
    const len = energy.length;
    for (let i = 0; i < len; i++) {
      const active = energy[i] >= threshold;
      const t = i * hopSec;
      if (active && spanStart == null) {
        spanStart = t;
      } else if (!active && spanStart != null) {
        speechSpans.push([spanStart, t]);
        spanStart = null;
      }
    }
    if (spanStart != null) {
      speechSpans.push([spanStart, len * hopSec]);
    }
  }

  // Sort and merge overlapping spans
  speechSpans.sort((a, b) => a[0] - b[0]);
  const mergedSpans = [];
  for (const span of speechSpans) {
    const prev = mergedSpans[mergedSpans.length - 1];
    if (prev && span[0] <= prev[1] + 0.05) {
      prev[1] = Math.max(prev[1], span[1]);
    } else {
      mergedSpans.push([span[0], span[1]]);
    }
  }

  // Helper: is time t inside any speech span?
  const isSpeaking = (t) => {
    for (const [s, e] of mergedSpans) {
      if (t >= s && t <= e) return true;
      if (s > t) break;
    }
    return false;
  };

  const points = [];
  let curGain = baseGain;
  const attackSec = Math.max(0.01, attackMs / 1000);
  const releaseSec = Math.max(0.01, releaseMs / 1000);

  const steps = Math.ceil(totalDur / stepSec) + 1;
  for (let i = 0; i < steps; i++) {
    const t = +(i * stepSec).toFixed(4);
    const active = isSpeaking(t);
    const targetGain = active ? duckGain : baseGain;

    if (targetGain < curGain) {
      // Attack: dropping gain
      const alpha = Math.min(1, stepSec / attackSec);
      curGain += (targetGain - curGain) * alpha;
    } else if (targetGain > curGain) {
      // Release: rising gain
      const alpha = Math.min(1, stepSec / releaseSec);
      curGain += (targetGain - curGain) * alpha;
    }

    curGain = Math.max(duckGain * 0.99, Math.min(baseGain * 1.01, curGain));
    points.push({
      t,
      gain: +curGain.toFixed(4),
      db: +linToDb(curGain).toFixed(2),
      speaking: active,
    });
  }

  function getGainAt(t) {
    if (!points.length) return baseGain;
    if (t <= 0) return points[0].gain;
    if (t >= totalDur) return points[points.length - 1].gain;
    const idx = Math.floor(t / stepSec);
    if (idx >= points.length - 1) return points[points.length - 1].gain;
    const p0 = points[idx], p1 = points[idx + 1];
    const frac = (t - p0.t) / stepSec;
    return +(p0.gain + (p1.gain - p0.gain) * frac).toFixed(4);
  }

  return {
    duration: totalDur,
    stepSec,
    baseGain,
    duckGain,
    points,
    getGainAt,
  };
}
