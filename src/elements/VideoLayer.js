// VideoLayer — the A-roll draw: crop/blur/split regions, crossfade layers,
// punch scaling. Ported from lib/render.js (drawLayer/arollLayers/srcDims).

import { punchScale, EASE } from '../../engine/motion.js';
import { reframeAt } from '../../engine/reframe.js';
import { timelineOf } from '../core/Compositor.js';
import { EFFECTS, clampParams, maskGeometry, hasClipFx } from '../effects/clipfx.js';

// cached scratch canvases (content / mask / composite) — resized on demand,
// zero per-frame allocation. ponytail: per-clip offscreen ≈1-3 ms/frame at
// ≤1080p (blur-dominated); 4K would need WebGL.
const _scratch = {};
function scratch(key, w, h) {
  _scratch[key] ??= document.createElement('canvas');
  const c = _scratch[key];
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c;
}

export function srcDims(src) {
  return {
    w: src?.videoWidth || src?.width || src?.displayWidth || src?.codedWidth || 0,
    h: src?.videoHeight || src?.height || src?.displayHeight || src?.codedHeight || 0,
  };
}

/** [{srcTime, alpha, scale, seg}] — outgoing full, incoming fades in over the join */
export function arollLayers(t, edl, tl) {
  const m = tl.editedToSource(t);
  const layers = [{ srcTime: m?.src ?? 0, alpha: 1, scale: 1, seg: m?.seg ?? 0 }];
  for (const q of edl.transitions || []) {
    const d = q.ms / 1000, t0 = q.at - d;
    if (t < t0 || t >= q.at) continue;
    const seg = m?.seg ?? -1;
    const next = tl.segments[seg + 1];
    if (!next) continue;
    const p = EASE.inOut((t - t0) / d);
    layers.push({ srcTime: next.in + (t - t0) * next.rate, alpha: p, scale: 1 + 0.02 * (1 - p), seg: seg + 1 });
  }
  return layers;
}

function drawCover(ctx, src, x, y, w, h) {
  const { w: sw, h: sh } = srcDims(src);
  if (!sw || !sh) return;
  const s = Math.max(w / sw, h / sh);
  ctx.drawImage(src, x + (w - sw * s) / 2, y + (h - sh * s) / 2, sw * s, sh * s);
}

export class VideoLayer {
  constructor(edl, tl, t) {
    this.edl = edl; this.tl = tl; this.t = t;
  }

  render(ctx, w, h, t, { assets }) {
    const edl = this.edl, tl = this.tl;
    const slot = (edl.broll || []).find((b) => t >= b.at && t < b.at + b.dur);
    if (slot) {
      const drawable = assets.frame(slot.src, (t - slot.at) + (slot.srcIn || 0));
      if (drawable) this.region(ctx, drawable, { x: 0, y: 0, w, h, mode: 'cover' }, 1, 1, edl, t);
      return;
    }
    const punch = punchScale(t, edl.punches || []);
    const layers = arollLayers(t, edl, tl);
    const drawPlain = (c) => {
      for (const layer of layers) {
        const drawable = assets.frame(edl.style.arollId, layer.srcTime);
        const layout = edl.keep[layer.seg]?.layout ?? 'full';
        if (drawable) this.region(c, drawable, layout, layer.alpha, punch * layer.scale, edl, t, w, h);
      }
    };
    // per-clip fx apply to the DOMINANT crossfade layer only.
    // ponytail: both-sided per-clip fx would need per-layer offscreens.
    const dom = layers.reduce((a, b) => (b.alpha > a.alpha ? b : a), layers[0]);
    const clip = edl.keep[dom?.seg];
    if (!hasClipFx(clip)) { drawPlain(ctx); return; }

    const fx = (clip.effects || []).filter((e) => e.on !== false && EFFECTS[e.id]);
    const filters = fx.map((e) => EFFECTS[e.id].filter?.(clampParams(e.id, e.params))).filter(Boolean).join(' ');
    // 1. video into the fx scratch (crop/punch/reframe bake in first; filter per draw)
    const fxc = scratch('fx', w, h);
    const fctx = fxc.getContext('2d');
    fctx.clearRect(0, 0, w, h);
    fctx.filter = filters || 'none';
    drawPlain(fctx);
    fctx.filter = 'none';
    // 2. overlay-type effects (vignette) in output space
    for (const e of fx) {
      if (EFFECTS[e.id].overlay && e.id === 'vignette') this.vignette(fctx, w, h, clampParams(e.id, e.params).strength);
    }
    // 3. mask in output space (stable under punch zoom — coords are frame-relative)
    const mask = clip.mask;
    if (!mask) { ctx.drawImage(fxc, 0, 0); return; }
    if (mask.shape === 'cinematic-bars') {
      ctx.drawImage(fxc, 0, 0);
      ctx.fillStyle = '#000';
      for (const r of maskGeometry('cinematic-bars', mask, w, h).rects) ctx.fillRect(r.x, r.y, r.w, r.h);
      return;
    }
    if (mask.shape === 'split') drawPlain(ctx); // clean frame under; effected half over
    const mc = scratch('mask', w, h);
    const mctx = mc.getContext('2d');
    mctx.clearRect(0, 0, w, h);
    mctx.filter = `blur(${(mask.feather ?? 0) * Math.min(w, h)}px)`;
    mctx.fillStyle = '#fff';
    const g = maskGeometry(mask.shape, mask, w, h);
    if (g.ellipse) { mctx.beginPath(); mctx.ellipse(g.ellipse.cx, g.ellipse.cy, g.ellipse.rx, g.ellipse.ry, 0, 0, Math.PI * 2); mctx.fill(); }
    else for (const r of g.rects) mctx.fillRect(r.x, r.y, r.w, r.h);
    mctx.filter = 'none';
    const cc = scratch('comp', w, h);
    const cctx = cc.getContext('2d');
    cctx.clearRect(0, 0, w, h);
    cctx.drawImage(fxc, 0, 0);
    cctx.globalCompositeOperation = mask.invert ? 'destination-out' : 'destination-in';
    cctx.drawImage(mc, 0, 0);
    cctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(cc, 0, 0);
  }

  vignette(ctx, w, h, strength) {
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${strength})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  region(ctx, drawable, layout, alpha, scale, edl, t, W, H) {
    const regions = layout === 'split'
      ? [{ x: 0, y: 0, w: W, h: H * 0.6, mode: 'contain' }, { x: 0, y: H * 0.6, w: W, h: H * 0.4, mode: 'cover' }]
      : [{ x: 0, y: 0, w: W, h: H, mode: edl?.style.fit === 'blur' ? 'blur' : 'cover' }];
    const d = srcDims(drawable);
    for (const r of regions) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
      if (scale !== 1) {
        ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
        ctx.scale(scale, scale);
        ctx.translate(-(r.x + r.w / 2), -(r.y + r.h / 2));
      }
      if (!d.w || !d.h) drawCover(ctx, drawable, r.x, r.y, r.w, r.h);
      else if (r.mode === 'cover') {
        const crop = reframeAt(edl.faces, t, edl.style.reframe, r.w / r.h, d.w / d.h);
        ctx.drawImage(drawable, crop.x * d.w, crop.y * d.h, crop.w * d.w, crop.h * d.h, r.x, r.y, r.w, r.h);
      } else {
        ctx.save();
        ctx.filter = 'blur(36px) saturate(1.25)';
        drawCover(ctx, drawable, r.x - 24, r.y - 24, r.w + 48, r.h + 48);
        ctx.restore();
        const s = Math.min(r.w / d.w, r.h / d.h);
        ctx.drawImage(drawable, r.x + (r.w - d.w * s) / 2, r.y + (r.h - d.h * s) / 2, d.w * s, d.h * s);
      }
      ctx.restore();
    }
  }
}
