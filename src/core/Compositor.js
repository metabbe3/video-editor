// Compositor — the polymorphic scene graph. Builds ordered renderables from the
// EDL and renders one deterministic frame; preview AND export both call this.

import { buildTimeline, buildCaptions } from '../../engine/timeline.js';
import { VideoLayer } from '../elements/VideoLayer.js';
import { CaptionsElement } from '../elements/CaptionsElement.js';
import { OverlayElement, overlayHit } from '../elements/OverlayElement.js';
import { HookCard, StepList, MetricCallout, ProgressBar } from '../elements/mogrts.js';
import { applyPolish } from '../effects/polish.js';

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
    // polish (LUT/HD/skin) after video layers but before text overlays stay legible —
    // run it, then re-draw the text elements so captions never get graded/blurred
    if (this.polish && (this.polish.lut !== 'none' || this.polish.sharpen || this.polish.skinSmooth)) {
      applyPolish(ctx, w, h, this.polish, edl.faces, t);
      for (const el of els) if (el instanceof CaptionsElement || el instanceof OverlayElement || el.constructor.name === 'HookCard' || el.constructor.name === 'StepList' || el.constructor.name === 'MetricCallout') el.render(ctx, w, h, t, { assets });
    }
  }
}
