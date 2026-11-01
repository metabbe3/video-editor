// Reframe — face-aware auto-crop math + manual zoom/pan overlay. PURE (node-safe):
// the detector lives in lib/face-track.js; this module only computes crop rects,
// deterministically from (track, t) so preview and export agree frame-for-frame.
//
// Units: faces[] entries {t, cx, cy, fh} are NORMALIZED per-axis to the source
// frame (cx/fh fractions of width, cy fractions of height). aspect = target W/H
// (9/16), srcAspect = source W/H. A visible rect {x,y,w,h} (per-axis normalized)
// matches the target when (w·sw)/(h·sh) = aspect  ⇔  w/h = aspect/srcAspect.

export const DEFAULT_MANUAL = Object.freeze({ zoom: 1, px: 0, py: 0 });

/** face -> base crop: face fills ~faceFill of frame height, eyes near eyeLine. */
export function cropRectForFace(face, aspect, srcAspect, { faceFill = 0.34, eyeLine = 0.4 } = {}) {
  if (!face) return null;
  const r = aspect / srcAspect; // normalized w per normalized h
  let vh = clamp(face.fh / faceFill, 0.35, Math.min(1, 1 / r)); // vw = vh*r <= 1
  const vw = vh * r;
  return {
    x: clamp(face.cx - vw / 2, 0, 1 - vw),
    y: clamp(face.cy - eyeLine * vh, 0, 1 - vh),
    w: vw, h: vh,
  };
}

/** manual zoom/pan on top of an auto (or null) crop. */
export function applyManual(crop, manual, aspect, srcAspect) {
  const m = { ...DEFAULT_MANUAL, ...manual };
  const r = aspect / srcAspect;
  const base = crop || { x: (1 - Math.min(1, r)) / 2, y: 0, w: Math.min(1, r), h: 1 }; // cover default
  const h = clamp(base.h / m.zoom, Math.min(base.h, 1 / m.zoom), 1);
  const w = Math.min(1, h * r);
  const cx = base.x + base.w / 2 + m.px * w;
  const cy = base.y + base.h / 2 + m.py * h;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}

/**
 * Smooth a raw face track (fixed-dt samples, null = no detection): fill short
 * gaps by interpolation, 5-sample median to kill detector jitter. Long null
 * runs drop out -> reframeAt holds the last keyframe (falls back gracefully).
 */
export function smoothFaceTrack(samples, dt) {
  const n = samples.length;
  // 1) median pass first — kills detector jitter so gaps interpolate clean points
  const pts = samples.map((p, i) => {
    if (!p) return null;
    const win = [];
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) if (samples[j]) win.push(samples[j]);
    if (win.length < 3) return { ...p };
    return { t: p.t, cx: med(win.map((q) => q.cx)), cy: med(win.map((q) => q.cy)), fh: med(win.map((q) => q.fh)) };
  });
  // 2) fill short gaps by interpolation
  for (let i = 0; i < n; i++) {
    if (pts[i]) continue;
    let a = i - 1;
    while (a >= 0 && !pts[a]) a--;
    let b = i + 1;
    while (b < n && !pts[b]) b++;
    if (a >= 0 && b < n && (b - a) * dt <= 1.5) pts[i] = lerpPt(pts[a], pts[b], (i - a) / (b - a));
  }
  return pts.filter(Boolean);
}

/** Crop rect at edited time t (interpolated keyframes + manual overlay). */
export function reframeAt(faces, t, manual, aspect, srcAspect) {
  let base = null;
  if (faces?.length) {
    if (t <= faces[0].t) base = cropRectForFace(faces[0], aspect, srcAspect);
    else if (t >= faces[faces.length - 1].t) base = cropRectForFace(faces[faces.length - 1], aspect, srcAspect);
    else {
      let i = 0;
      while (i < faces.length - 1 && faces[i + 1].t < t) i++;
      const f = (t - faces[i].t) / Math.max(1e-6, faces[i + 1].t - faces[i].t);
      base = cropRectForFace(lerpPt(faces[i], faces[i + 1], f), aspect, srcAspect);
    }
  }
  return applyManual(base, manual, aspect, srcAspect);
}

// ---- helpers ----
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerpPt = (a, b, f) => ({ t: a.t + (b.t - a.t) * f, cx: a.cx + (b.cx - a.cx) * f, cy: a.cy + (b.cy - a.cy) * f, fh: a.fh + (b.fh - a.fh) * f });
const med = (arr) => {
  const s = [...arr].sort((x, y) => x - y);
  return s[s.length >> 1];
};
