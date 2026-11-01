// CaptionsElement — dispatches to the selected caption template strategy.

import { CAPTION_STYLES, chunkWords, drawLine } from '../templates/captions/index.js';
import { timelineOf } from '../core/Compositor.js';

export class CaptionsElement {
  constructor(edl, tl, _legacyChunks, t) {
    this.edl = edl; this.tl = tl; this.t = t;
  }

  render(ctx, w, h, t) {
    const edl = this.edl;
    const style = { id: edl.style.captionStyle || 'hormozi', ...CAPTION_STYLES[edl.style.captionStyle] || CAPTION_STYLES.hormozi };
    // keywords (GLM emphases) -> word flags
    const kw = new Set(edl.keywords || []);
    const words = edl.words.map((wd, i) => ({ ...wd, isKeyword: kw.has(i) }));
    const lines = chunkWords(words, this.tl, style);
    const line = lines.find((l) => t >= l[0].start - 0.05 && t <= l[l.length - 1].end + 0.3)
      ?? lines.find((l) => l.some((wd) => t >= wd.start && t <= wd.end));
    if (!line) return;
    const seg = this.tl.segmentAt(t);
    const split = seg != null && edl.keep[seg]?.layout === 'split';
    const baseY = split ? h * 0.56 : h * 0.72;
    drawLine(ctx, line, t, style, {
      w, h, baseY,
      size: edl.style.captionSize || Math.round(h * 0.0375),
    });
  }
}
