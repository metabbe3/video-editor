// Motion — pure functions of time. Same code drives UI springs and baked video
// transitions, so preview and export agree frame-for-frame.
// Closed-form damped-oscillator step response (no integration drift).

export const TAU = Math.PI * 2;

/** damping ratio for a desired percent overshoot (0.1 = 10%) — ANALYSIS.md §1 */
export function zetaFromOvershoot(percent) {
  const po = Math.min(Math.max(percent, 0.0001), 0.9999);
  return -Math.log(po) / Math.sqrt(Math.PI * Math.PI + Math.log(po) ** 2);
}

/**
 * Spring step response at time t (seconds), from `from` to `to`.
 * Remotion-style config {stiffness, damping, mass}; deterministic in t.
 */
export function spring(t, { stiffness = 100, damping = 10, mass = 1 } = {}, from = 0, to = 1) {
  if (t <= 0) return from;
  const wn = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  let x; // normalized step response 0..1
  if (zeta < 1) {
    const wd = wn * Math.sqrt(1 - zeta * zeta);
    const env = Math.exp(-zeta * wn * t);
    x = 1 - env * (Math.cos(wd * t) + (zeta * wn / wd) * Math.sin(wd * t));
  } else if (Math.abs(zeta - 1) < 1e-6) {
    x = 1 - Math.exp(-wn * t) * (1 + wn * t);
  } else {
    const s1 = -wn * (zeta - Math.sqrt(zeta * zeta - 1));
    const s2 = -wn * (zeta + Math.sqrt(zeta * zeta - 1));
    x = 1 - (s2 * Math.exp(s1 * t) - s1 * Math.exp(s2 * t)) / (s2 - s1);
  }
  return from + (to - from) * x;
}

/** Perceptual settle time (2% band) — Apple rule: don't wait for physics to finish. */
export function settleMs({ stiffness = 100, damping = 10, mass = 1 } = {}) {
  const wn = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  return (4 / (Math.max(zeta, 0.5) * wn)) * 1000;
}

/** UI presets — Claude-restrained per ANALYSIS.md: spatial may overshoot, effects never. */
export const SPRINGS = {
  spatial: { stiffness: 380, damping: 2 * 0.8 * Math.sqrt(380), mass: 1 },   // ~475ms settle
  spatialFast: { stiffness: 800, damping: 2 * 0.8 * Math.sqrt(800), mass: 1 },
  effect: { stiffness: 1600, damping: 2 * Math.sqrt(1600), mass: 1 },        // critically damped ~230ms
  bouncy: { stiffness: 380, damping: 2 * zetaFromOvershoot(0.10) * Math.sqrt(380), mass: 1 },
};

// ---- cubic-bezier easing (CSS-style), for the few places a bezier is enough ----
function bezierCoeffs(x1, x2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  return { cx, bx, ax };
}
/** progress p in [0,1] -> eased value of cubic-bezier(x1,y1,x2,y2) */
export function cubicBezier(p, x1, y1, x2, y2) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const X = bezierCoeffs(x1, x2), Y = bezierCoeffs(y1, y2);
  const sampleX = (t) => ((X.ax * t + X.bx) * t + X.cx) * t;
  const sampleY = (t) => ((Y.ax * t + Y.bx) * t + Y.cx) * t;
  const dX = (t) => (3 * X.ax * t + 2 * X.bx) * t + X.cx;
  // Newton then bisection
  let t = p;
  for (let i = 0; i < 8; i++) {
    const err = sampleX(t) - p;
    if (Math.abs(err) < 1e-6) break;
    const d = dX(t);
    if (Math.abs(d) < 1e-7) break;
    t -= err / d;
  }
  if (t < 0 || t > 1) { // bisection fallback
    let lo = 0, hi = 1;
    t = p;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (sampleX(mid) < p) lo = mid; else hi = mid;
      t = (lo + hi) / 2;
    }
  }
  return sampleY(t);
}

/** Verified curve set (ANALYSIS.md §1). */
export const EASE = {
  outExpo: (p) => cubicBezier(p, 0.16, 1, 0.3, 1),
  outQuint: (p) => cubicBezier(p, 0.22, 1, 0.36, 1),
  outBack: (p) => cubicBezier(p, 0.34, 1.56, 0.64, 1), // 10% overshoot
  inOut: (p) => cubicBezier(p, 0.45, 0, 0.55, 1),
};

/**
 * Zoom punch scale at edited-time t. Each punch eases FROM THE PREVIOUS
 * PUNCH'S SETTLED SCALE (never from 1.0 — that would snap zoom out at every
 * join and breathe back). 'cut' punches hold; 'emphasis' spikes and returns
 * to the running settled scale.
 */
export function punchScale(t, punches) {
  const sorted = [...punches].sort((a, b) => a.at - b.at);
  let settled = 1;
  for (const p of sorted) {
    const { at, ms = 400, scale = 1.1, kind = 'cut' } = p;
    const dur = ms / 1000;
    if (t < at) return settled; // before this punch: previous state holds
    if (t >= at + dur) {
      settled = kind === 'emphasis' ? settled : scale; // cut holds; emphasis returns
      continue;
    }
    const f = Math.min(1, (t - at) / dur);
    if (kind === 'emphasis') {
      const spike = settled + (scale - settled);
      return f < 0.5
        ? settled + (scale - settled) * EASE.outExpo(f * 2)
        : spike - (spike - settled) * EASE.outQuint((f - 0.5) * 2);
    }
    return settled + (scale - settled) * EASE.outExpo(f);
  }
  return settled;
}
