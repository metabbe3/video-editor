// VideoLayer — the A-roll draw: crop/blur/split regions, crossfade layers,
// punch scaling. Ported from lib/render.js (drawLayer/arollLayers/srcDims).

import { punchScale, EASE } from '../../engine/motion.js';
import { reframeAt } from '../../engine/reframe.js';
import { timelineOf } from '../core/Compositor.js';
import { EFFECTS, clampParams, maskGeometry, hasClipFx } from '../effects/clipfx.js';
import { normalizeCropRect } from '../../engine/clip-ops.js';
import { evalClipKeyframes } from '../../engine/keyframes.js';

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

/** [{srcTime, alpha, scale, seg, offsetX, transition}] — outgoing full, incoming fades/pans in over join */
export function arollLayers(t, edl, tl) {
  const m = tl.editedToSource(t);
  const layers = [{ srcTime: m?.src ?? 0, alpha: 1, scale: 1, seg: m?.seg ?? 0, offsetX: 0 }];
  for (const q of edl.transitions || []) {
    const d = (q.ms || 120) / 1000, t0 = q.at - d;
    if (t < t0 || t >= q.at) continue;
    const seg = m?.seg ?? -1;
    const next = tl.segments[seg + 1];
    if (!next) continue;
    const p = EASE.inOut((t - t0) / d);
    const type = q.type || 'dissolve';

    if (type === 'whip-pan') {
      layers[0].offsetX = -p;
      layers.push({
        srcTime: next.in + (t - t0) * next.rate,
        alpha: 1,
        scale: 1,
        seg: seg + 1,
        offsetX: 1 - p,
        transition: q,
      });
    } else if (type === 'flash') {
      // Outgoing until midpoint, then incoming
      const isIncoming = p >= 0.5;
      const flashAlpha = Math.sin(p * Math.PI);
      if (isIncoming) {
        layers[0] = {
          srcTime: next.in + (t - t0) * next.rate,
          alpha: 1,
          scale: 1,
          seg: seg + 1,
          flash: flashAlpha,
          transition: q,
        };
      } else {
        layers[0].flash = flashAlpha;
        layers[0].transition = q;
      }
    } else {
      // Dissolve (crossfade alpha)
      layers.push({
        srcTime: next.in + (t - t0) * next.rate,
        alpha: p,
        scale: 1 + 0.02 * (1 - p),
        seg: seg + 1,
        transition: q,
      });
    }
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
      if (drawable) this.region(ctx, drawable, { x: 0, y: 0, w, h, mode: 'cover' }, 1, 1, edl, t, w, h, slot);
      return;
    }
    const punch = punchScale(t, edl.punches || []);
    const layers = arollLayers(t, edl, tl);
    const drawPlain = (c) => {
      for (const layer of layers) {
        const drawable = assets.frame(edl.style.arollId, layer.srcTime);
        const clip = edl.keep[layer.seg];
        const layout = clip?.layout ?? 'full';
        const seg = tl.segments[layer.seg];
        const segStart = tl.starts[layer.seg] ?? 0;
        const progress = seg?.dur > 0 ? Math.max(0, Math.min(1, (t - segStart) / seg.dur)) : 0;
        const kf = evalClipKeyframes(clip?.keyframes, progress);
        if (drawable) this.region(c, drawable, layout, layer.alpha, punch * layer.scale, edl, t, w, h, clip, kf, layer.offsetX);
      }
    };
    // per-clip fx apply to the DOMINANT crossfade layer only.
    // ponytail: both-sided per-clip fx would need per-layer offscreens.
    const dom = layers.reduce((a, b) => (b.alpha > a.alpha ? b : a), layers[0]);
    const clip = edl.keep[dom?.seg];
    const postDraw = () => {
      const maxFlash = Math.max(0, ...layers.map((l) => l.flash || 0));
      if (maxFlash > 0.01) {
        ctx.save();
        ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, maxFlash).toFixed(3)})`;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }
    };

    if (!hasClipFx(clip)) {
      drawPlain(ctx);
      postDraw();
      return;
    }

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
    if (!mask) {
      ctx.drawImage(fxc, 0, 0);
      postDraw();
      return;
    }
    if (mask.shape === 'cinematic-bars') {
      ctx.drawImage(fxc, 0, 0);
      ctx.fillStyle = '#000';
      for (const r of maskGeometry('cinematic-bars', mask, w, h).rects) ctx.fillRect(r.x, r.y, r.w, r.h);
      postDraw();
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
    postDraw();
  }

  vignette(ctx, w, h, strength) {
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${strength})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  region(ctx, drawable, layout, alpha, scale, edl, t, W, H, clip, kf = null, offsetX = 0) {
    const fit = edl?.style.fit ?? 'cover';
    const isBlurPad = fit === 'blur-pad' || fit === 'blur';
    const isContain = fit === 'contain';
    const regions = layout === 'split'
      ? [{ x: 0, y: 0, w: W, h: H * 0.6, mode: 'contain' }, { x: 0, y: H * 0.6, w: W, h: H * 0.4, mode: 'cover' }]
      : [{ x: 0, y: 0, w: W, h: H, mode: isBlurPad ? 'blur-pad' : (isContain ? 'contain' : 'cover') }];
    const d = srcDims(drawable);
    const kfOpacity = kf?.opacity ?? 1;
    const kfScale = kf?.scale ?? 1;
    const kfX = (kf?.x ?? 0) * W + (offsetX || 0) * W;
    const kfY = (kf?.y ?? 0) * H;
    const totalScale = scale * kfScale;

    for (const r of regions) {
      ctx.save();
      if (clip?.blendMode && clip.blendMode !== 'normal') {
        ctx.globalCompositeOperation = clip.blendMode;
      }
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha * kfOpacity));
      ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();

      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const rot = ((clip?.rotate || 0) % 360 + 360) % 360;
      const flipH = !!clip?.flipH;

      let bw = r.w, bh = r.h;
      if (rot === 90 || rot === 270) {
        bw = r.h; bh = r.w;
      }
      const bx = cx - bw / 2;
      const by = cy - bh / 2;

      if (totalScale !== 1 || rot || flipH || kfX || kfY) {
        ctx.translate(cx + kfX, cy + kfY);
        if (totalScale !== 1) ctx.scale(totalScale, totalScale);
        if (flipH) ctx.scale(-1, 1);
        if (rot) ctx.rotate((rot * Math.PI) / 180);
        ctx.translate(-cx, -cy);
      }

      if (!d.w || !d.h) {
        drawCover(ctx, drawable, bx, by, bw, bh);
      } else if (clip?.cropRect) {
        const cr = normalizeCropRect(clip.cropRect);
        const sx = cr.x * d.w, sy = cr.y * d.h, sw = cr.w * d.w, sh = cr.h * d.h;
        ctx.drawImage(drawable, sx, sy, sw, sh, bx, by, bw, bh);
      } else if (r.mode === 'cover') {
        const crop = reframeAt(edl.faces, t, edl.style.reframe, bw / bh, d.w / d.h);
        ctx.drawImage(drawable, crop.x * d.w, crop.y * d.h, crop.w * d.w, crop.h * d.h, bx, by, bw, bh);
      } else if (r.mode === 'contain') {
        const s = Math.min(bw / d.w, bh / d.h);
        ctx.drawImage(drawable, bx + (bw - d.w * s) / 2, by + (bh - d.h * s) / 2, d.w * s, d.h * s);
      } else { // blur-pad
        ctx.save();
        ctx.filter = 'blur(36px) saturate(1.25)';
        drawCover(ctx, drawable, bx - 24, by - 24, bw + 48, bh + 48);
        ctx.restore();
        const s = Math.min(bw / d.w, bh / d.h);
        ctx.drawImage(drawable, bx + (bw - d.w * s) / 2, by + (bh - d.h * s) / 2, d.w * s, d.h * s);
      }
      ctx.restore();
    }
  }
}
