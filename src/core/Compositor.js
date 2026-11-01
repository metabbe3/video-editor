// Compositor — the polymorphic scene graph. Builds ordered renderables from the
// EDL and renders one deterministic frame; preview AND export both call this.

import { buildTimeline, buildCaptions } from '../../engine/timeline.js';
import { VideoLayer } from '../elements/VideoLayer.js';
import { CaptionsElement } from '../elements/CaptionsElement.js';
import { OverlayElement, overlayHit } from '../elements/OverlayElement.js';
import { HookCard, StepList, MetricCallout, ProgressBar } from '../elements/mogrts.js';
import { applyPolish } from '../effects/polish.js';
import { buildAdjustFilter, applyTemperatureOverlay } from '../../engine/clip-ops.js';

const _adjScratch = {};
function adjScratch(w, h) {
  _adjScratch.c ??= document.createElement('canvas');
  const c = _adjScratch.c;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c;
}

export function applyColorAdjust(ctx, w, h, adjust) {
  if (!adjust) return;
  const filter = buildAdjustFilter(adjust);
  if (filter) {
    const snap = adjScratch(w, h);
    const sctx = snap.getContext('2d');
    sctx.clearRect(0, 0, w, h);
    sctx.drawImage(ctx.canvas, 0, 0);
    ctx.save();
    ctx.filter = filter;
    ctx.drawImage(snap, 0, 0);
    ctx.restore();
  }
  if (adjust.temperature) {
    applyTemperatureOverlay(ctx, w, h, adjust.temperature);
  }
}

const tlCache = new WeakMap();
export function timelineOf(edl) {
  let tl = tlCache.get(edl);
  if (!tl) { // every mutation replaces the edl object — identity is the cache key
    tl = buildTimeline(edl.keep, { fps: edl.style.fps });
    tlCache.set(edl, tl);
  }
  return tl;
}

const capCache = new WeakMap();
export function captionsOf(edl) {
  let c = capCache.get(edl);
  if (!c) { c = buildCaptions(edl.words || [], timelineOf(edl)); capCache.set(edl, c); }
  return c;
}

export class Compositor {
  constructor() {
    this.showSafeZones = false;
    this.polish = null; // { lut, lutMix, sharpen, skinSmooth, autoLevels, _levels }
  }

  /** build the ordered scene for an EDL at edited-time t */
  scene(edl, t) {
    const tl = timelineOf(edl);
    const els = [];
    els.push(new VideoLayer(edl, tl, t));
    for (const o of edl.overlays || []) els.push(new OverlayElement(o)); // above video, below captions
    if (edl.steps?.length) els.push(new StepList(edl, tl, t));
    if (edl.metrics?.length) els.push(new MetricCallout(edl, tl, t));
    els.push(new HookCard(edl, t));
    if (edl.style.captionsMode !== 'off' && edl.words?.length) {
      els.push(new CaptionsElement(edl, tl, captionsOf(edl), t));
    }
    if (edl.style.progressBar) els.push(new ProgressBar(tl, t));
    // SafeZones moved OUT of the scene graph — guides are preview-only now
    // (they used to bake into exports when toggled on); see elements/guides.js
    return els;
  }

  renderFrame(ctx, t, edl, assets) {
    const { w, h } = edl.style;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const els = this.scene(edl, t);
    for (const el of els) el.render(ctx, w, h, t, { assets });
    // polish (LUT/HD/skin) & color adjust after video layers but before text overlays stay legible —
    // run it, then re-draw the text elements so captions never get graded/blurred
    const adj = edl.style.adjust;
    const hasAdj = adj && (adj.brightness || adj.contrast || adj.saturation || adj.temperature);
    const hasPolish = this.polish && (this.polish.lut !== 'none' || this.polish.sharpen || this.polish.skinSmooth || this.polish.cubeLut);
    if (hasAdj || hasPolish) {
      if (hasAdj) applyColorAdjust(ctx, w, h, adj);
      if (hasPolish) applyPolish(ctx, w, h, this.polish, edl.faces, t);
      for (const el of els) if (el instanceof CaptionsElement || el instanceof OverlayElement || el.constructor.name === 'HookCard' || el.constructor.name === 'StepList' || el.constructor.name === 'MetricCallout') el.render(ctx, w, h, t, { assets });
    }
  }
}
