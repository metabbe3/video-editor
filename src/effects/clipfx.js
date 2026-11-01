// ClipFX — per-clip effect stack + shape-mask registry (pure, node-testable).
// Canvas drawing lives in VideoLayer; this module owns data shapes + geometry.

export const EFFECTS = {
  blur: {
    label: 'Blur',
    params: { amount: { min: 0, max: 40, step: 1, def: 12, label: 'Amount' } },
    filter: (p) => `blur(${p.amount}px)`,
  },
  vignette: {
    label: 'Vignette',
    params: { strength: { min: 0, max: 1, step: 0.05, def: 0.5, label: 'Strength' } },
    overlay: true, // radial-gradient darkening drawn over the effected frame
  },
  // ponytail: glitch deferred — needs time-seeded slice/offset animation
};

export const MASK_SHAPES = ['rect', 'ellipse', 'cinematic-bars', 'split'];

/** clamp params to each effect's schema; missing keys fall back to defaults */
export function clampParams(id, params) {
  const def = EFFECTS[id];
  if (!def) return {};
  const out = {};
  for (const [k, s] of Object.entries(def.params)) {
    const v = Number(params?.[k]);
    out[k] = Number.isFinite(v) ? Math.min(s.max, Math.max(s.min, v)) : s.def;
  }
  return out;
}

/** mask geometry in output pixels — coords are 0-1, resolved against w/h.
 *  rect/ellipse/split are compositing masks; cinematic-bars is drawOnly
 *  (plain black bars, no mask machinery). split = right half. */
export function maskGeometry(shape, p, w, h) {
  const cx = (p?.x ?? 0.5) * w, cy = (p?.y ?? 0.5) * h;
  const mw = (p?.w ?? 1) * w, mh = (p?.h ?? 1) * h;
  switch (shape) {
    case 'ellipse': return { ellipse: { cx: cx, cy: cy, rx: mw / 2, ry: mh / 2 } };
    case 'cinematic-bars': return { drawOnly: true, rects: [{ x: 0, y: 0, w, h: h * 0.11 }, { x: 0, y: h * 0.89, w, h: h * 0.11 }] };
    case 'split': return { rects: [{ x: w / 2, y: 0, w: w / 2, h }] };
    case 'rect':
    default: return { rects: [{ x: cx - mw / 2, y: cy - mh / 2, w: mw, h: mh }] };
  }
}

export function hasClipFx(clip) {
  return !!clip && ((clip.effects || []).some((e) => e.on !== false && EFFECTS[e.id]) || !!clip.mask);
}
