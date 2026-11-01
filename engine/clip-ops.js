// clip-ops.js — pure functions for per-clip edits & transformations:
// rotate/flip, speed curves, audio fade envelope, arbitrary crop, color adjust.

/** 90-degree step rotation (0, 90, 180, 270) */
export function nextRotate(current = 0) {
  const step = Math.round((Number(current) || 0) / 90) * 90;
  return ((step + 90) % 360) || undefined;
}

/** speed curve presets (normalized progress t: 0..1, rate v: 0.25..4.0) */
export const SPEED_CURVE_PRESETS = {
  hero: [
    { t: 0, v: 2.0 },
    { t: 0.3, v: 0.4 },
    { t: 0.7, v: 0.4 },
    { t: 1.0, v: 2.0 },
  ],
  rampIn: [
    { t: 0, v: 0.3 },
    { t: 1.0, v: 2.0 },
  ],
  rampOut: [
    { t: 0, v: 2.0 },
    { t: 1.0, v: 0.3 },
  ],
  montage: [
    { t: 0, v: 3.0 },
    { t: 0.35, v: 1.0 },
    { t: 1.0, v: 1.0 },
  ],
};

/** linear interpolation of speed curve rate at progress p (0..1) */
export function evalSpeedCurve(curve, progress) {
  if (!curve || !curve.length) return 1;
  const p = Math.max(0, Math.min(1, progress));
  if (p <= curve[0].t) return curve[0].v;
  if (p >= curve[curve.length - 1].t) return curve[curve.length - 1].v;
  for (let i = 0; i < curve.length - 1; i++) {
    const p0 = curve[i], p1 = curve[i + 1];
    if (p >= p0.t && p <= p1.t) {
      const span = p1.t - p0.t;
      const frac = span > 0 ? (p - p0.t) / span : 0;
      return p0.v + (p1.v - p0.v) * frac;
    }
  }
  return 1;
}

/** integrated duration of a source span under a piecewise-linear speed curve */
export function speedCurveDuration(srcDur, curve) {
  if (!curve || curve.length < 2 || srcDur <= 0) return Math.max(0, srcDur);
  let totalEdited = 0;
  for (let i = 0; i < curve.length - 1; i++) {
    const p0 = curve[i], p1 = curve[i + 1];
    const dt = (p1.t - p0.t) * srcDur;
    if (dt <= 0) continue;
    const v0 = Math.max(0.1, p0.v), v1 = Math.max(0.1, p1.v);
    if (Math.abs(v1 - v0) < 1e-4) {
      totalEdited += dt / v0;
    } else {
      totalEdited += (dt / (v1 - v0)) * Math.log(v1 / v0);
    }
  }
  return Math.max(0.01, totalEdited);
}

/**
 * Audio fade gain at segment-local time (seconds).
 * localT: seconds from clip start
 * playLen: total playback duration of clip (seconds)
 * fadeInSec: fade-in duration (seconds)
 * fadeOutSec: fade-out duration (seconds)
 */
export function clipFadeGain(localT, playLen, fadeInSec = 0, fadeOutSec = 0) {
  if (localT < 0 || localT > playLen) return 0;
  let g = 1;
  if (fadeInSec > 0 && localT < fadeInSec) {
    g = Math.min(g, localT / fadeInSec);
  }
  if (fadeOutSec > 0 && localT > playLen - fadeOutSec) {
    g = Math.min(g, (playLen - localT) / fadeOutSec);
  }
  return Math.max(0, Math.min(1, g));
}

/** clamp arbitrary crop rectangle to valid bounds inside [0, 1] */
export function normalizeCropRect(rect) {
  if (!rect) return { x: 0, y: 0, w: 1, h: 1 };
  let w = Math.max(0.05, Math.min(1, Number(rect.w) || 1));
  let h = Math.max(0.05, Math.min(1, Number(rect.h) || 1));
  let x = Math.max(0, Math.min(1 - w, Number(rect.x) || 0));
  let y = Math.max(0, Math.min(1 - h, Number(rect.y) || 0));
  return {
    x: +x.toFixed(4),
    y: +y.toFixed(4),
    w: +w.toFixed(4),
    h: +h.toFixed(4),
  };
}

/** ctx.filter string for global color adjustments */
export function buildAdjustFilter(adjust) {
  if (!adjust) return '';
  const parts = [];
  const b = Number(adjust.brightness) || 0;
  const c = Number(adjust.contrast) || 0;
  const s = Number(adjust.saturation) || 0;
  if (b !== 0) parts.push(`brightness(${Math.max(0, 1 + b / 100).toFixed(3)})`);
  if (c !== 0) parts.push(`contrast(${Math.max(0, 1 + c / 100).toFixed(3)})`);
  if (s !== 0) parts.push(`saturate(${Math.max(0, 1 + s / 100).toFixed(3)})`);
  return parts.join(' ');
}

/** warm/cool temperature overlay pass */
export function applyTemperatureOverlay(ctx, w, h, temp) {
  const t = Math.max(-100, Math.min(100, Number(temp) || 0));
  if (!t) return;
  const alpha = (Math.abs(t) / 100) * 0.35;
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.fillStyle = t > 0
    ? `rgba(255, 140, 0, ${alpha.toFixed(3)})` // warm amber
    : `rgba(0, 140, 255, ${alpha.toFixed(3)})`; // cool blue
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** platform one-click export presets */
export const PLATFORM_EXPORT_PRESETS = {
  tiktok: {
    label: 'TikTok 1080×1920@30',
    orientation: '9:16',
    resolution: 1080,
    fps: 30,
    quality: 0.10,
  },
  shorts: {
    label: 'Shorts 1080×1920@60',
    orientation: '9:16',
    resolution: 1080,
    fps: 60,
    quality: 0.10,
  },
  reels: {
    label: 'Reels 1080×1920@30',
    orientation: '9:16',
    resolution: 1080,
    fps: 30,
    quality: 0.075,
  },
  square: {
    label: 'Square 1:1 1080×1080@30',
    orientation: '1:1',
    resolution: 1080,
    fps: 30,
    quality: 0.075,
  },
  youtube: {
    label: 'YouTube 16:9 1920×1080@30',
    orientation: '16:9',
    resolution: 1080,
    fps: 30,
    quality: 0.10,
  },
};
