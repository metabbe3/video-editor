// keyframes.js — Pure keyframe animation model and easing interpolation for clips.
// Pure decision logic: no DOM, node-testable.
// Part of Nila Sprint 4: Gap-fill bundle.

import { EASE } from './motion.js';

export const KEYFRAME_PROPERTIES = ['scale', 'x', 'y', 'opacity'];

export const DEFAULT_KEYFRAME_VALUES = {
  scale: 1.0,
  x: 0.0,
  y: 0.0,
  opacity: 1.0,
};

/**
 * Interpolate a single keyframe track at normalized progress p (0..1).
 * @param {Array<{t: number, v: number, ease?: string}>} track - Sorted keyframes
 * @param {number} progress - Normalized clip progress [0..1]
 * @param {number} [defaultValue=0] - Fallback when track is empty
 * @returns {number} Interpolated value
 */
export function evalKeyframeTrack(track, progress, defaultValue = 0) {
  if (!track || !track.length) return defaultValue;
  const p = Math.max(0, Math.min(1, Number(progress) || 0));

  if (p <= track[0].t) return track[0].v;
  if (p >= track[track.length - 1].t) return track[track.length - 1].v;

  for (let i = 0; i < track.length - 1; i++) {
    const k0 = track[i], k1 = track[i + 1];
    if (p >= k0.t && p <= k1.t) {
      const span = k1.t - k0.t;
      if (span <= 1e-6) return k1.v;
      const frac = Math.max(0, Math.min(1, (p - k0.t) / span));

      let eased = frac;
      const easeType = k0.ease || 'ease';
      if (easeType === 'ease' || easeType === 'inOut') {
        eased = EASE.inOut(frac);
      } else if (easeType === 'outExpo') {
        eased = EASE.outExpo(frac);
      } else if (easeType === 'outQuint') {
        eased = EASE.outQuint(frac);
      } else if (easeType === 'outBack') {
        eased = EASE.outBack(frac);
      } // otherwise linear

      return +(k0.v + (k1.v - k0.v) * eased).toFixed(4);
    }
  }

  return defaultValue;
}

/**
 * Evaluate all keyframe tracks on a clip at normalized progress (0..1).
 * @param {object} keyframes - { scale?: [], x?: [], y?: [], opacity?: [] }
 * @param {number} progress - Normalized progress (0..1)
 * @returns {object} { scale: number, x: number, y: number, opacity: number }
 */
export function evalClipKeyframes(keyframes, progress) {
  if (!keyframes) {
    return { ...DEFAULT_KEYFRAME_VALUES };
  }
  return {
    scale: evalKeyframeTrack(keyframes.scale, progress, DEFAULT_KEYFRAME_VALUES.scale),
    x: evalKeyframeTrack(keyframes.x, progress, DEFAULT_KEYFRAME_VALUES.x),
    y: evalKeyframeTrack(keyframes.y, progress, DEFAULT_KEYFRAME_VALUES.y),
    opacity: evalKeyframeTrack(keyframes.opacity, progress, DEFAULT_KEYFRAME_VALUES.opacity),
  };
}

/**
 * Add or update a keyframe on a track.
 * @param {Array<{t: number, v: number, ease?: string}>} track - Target track
 * @param {number} t - Normalized time (0..1)
 * @param {number} v - Value
 * @param {string} [ease='ease'] - Easing mode
 * @returns {Array<{t: number, v: number, ease?: string}>} New sorted track
 */
export function setKeyframe(track = [], t, v, ease = 'ease') {
  const normT = +Math.max(0, Math.min(1, Number(t) || 0)).toFixed(4);
  const normV = +Number(v).toFixed(4);
  const out = (track || []).map((k) => ({ ...k }));

  const idx = out.findIndex((k) => Math.abs(k.t - normT) < 0.015);
  if (idx >= 0) {
    out[idx] = { t: out[idx].t, v: normV, ease: ease || out[idx].ease || 'ease' };
  } else {
    out.push({ t: normT, v: normV, ease });
  }

  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Remove a keyframe by index or nearest t.
 * @param {Array<{t: number, v: number, ease?: string}>} track - Target track
 * @param {number} tOrIndex - Keyframe index or time in [0, 1]
 * @returns {Array<{t: number, v: number, ease?: string}>} New track
 */
export function removeKeyframe(track = [], tOrIndex) {
  if (!track || !track.length) return [];
  const out = track.map((k) => ({ ...k }));

  if (typeof tOrIndex === 'number' && Number.isInteger(tOrIndex) && tOrIndex >= 0 && tOrIndex < out.length) {
    out.splice(tOrIndex, 1);
    return out;
  }

  const targetT = Number(tOrIndex);
  const idx = out.findIndex((k) => Math.abs(k.t - targetT) < 0.03);
  if (idx >= 0) {
    out.splice(idx, 1);
  }
  return out;
}

/**
 * Check if a track has a keyframe near normalized t.
 */
export function findKeyframeNear(track = [], t, tol = 0.02) {
  if (!track || !track.length) return null;
  const targetT = Number(t);
  return track.find((k) => Math.abs(k.t - targetT) <= tol) || null;
}
