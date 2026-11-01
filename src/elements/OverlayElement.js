// Overlay — manual text titles and emoji/shape stickers drawn above the video,
// below captions. Positions/scale are 0-1 relative, resolved at draw (any aspect).

import { EASE } from '../../engine/motion.js';

const TEXT_PRESETS = {
  title: { size: 0.065, y: 0.16, color: '#fff', stroke: '#111', weight: 900, upper: true, rot: 0 },
  subtitle: { size: 0.042, y: 0.84, color: '#fff', bg: 'rgba(20,18,12,0.82)', weight: 700, upper: false, rot: 0 },
  pop: { size: 0.055, y: 0.3, color: '#ffe9d9', stroke: '#1557c9', weight: 900, upper: true, rot: -0.03 },
};

export class OverlayElement {
  constructor(o) { this.o = o; }

  render(ctx, w, h, t) {
    const o = this.o;
    if (t < o.t0 || t >= o.t1) return;

    // Animation progress: in (0..1) and out (0..1)
    const animDur = 0.28;
    const pIn = Math.min(1, Math.max(0, (t - o.t0) / animDur));
    const pOut = Math.min(1, Math.max(0, (o.t1 - t) / animDur));

    const animIn = o.animIn || 'pop';
    const animOut = o.animOut || 'fade';

    let alpha = 1;
    let scaleFactor = 1;
    let offsetY = 0;

    // In animation
    if (pIn < 1) {
      if (animIn === 'pop') {
        const p = EASE.inOut(pIn);
        scaleFactor *= 0.75 + 0.25 * p;
        alpha *= Math.min(1, pIn * 1.5);
      } else if (animIn === 'fade') {
        alpha *= EASE.inOut(pIn);
      } else if (animIn === 'slide') {
        const p = EASE.inOut(pIn);
        offsetY += (1 - p) * 36;
        alpha *= p;
      }
    }

    // Out animation
    if (pOut < 1 && animOut !== 'none') {
      if (animOut === 'pop') {
        const p = EASE.inOut(pOut);
        scaleFactor *= 0.75 + 0.25 * p;
        alpha *= Math.min(1, pOut * 1.5);
      } else if (animOut === 'fade') {
        alpha *= EASE.inOut(pOut);
      } else if (animOut === 'slide') {
        const p = EASE.inOut(pOut);
        offsetY += (1 - p) * 36;
        alpha *= p;
      }
    }

    ctx.save();
    if (o.blendMode && o.blendMode !== 'normal') {
      ctx.globalCompositeOperation = o.blendMode;
    }
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.translate(o.x * w, o.y * h + offsetY);
    ctx.rotate(o.rot ?? 0);
    if (scaleFactor !== 1) ctx.scale(scaleFactor, scaleFactor);

    if (o.type === 'text') this.drawText(ctx, w, h, o, pIn);
    else this.drawSticker(ctx, w, h, o, pIn);
    ctx.restore();
  }

  drawText(ctx, w, h, o, pop) {
    const p = TEXT_PRESETS[o.preset] ?? TEXT_PRESETS.title;
    const baseSize = o.fontSize ? (Number(o.fontSize) / 1080) * h : (o.size ?? 1) * p.size * h;
    const size = Math.max(12, baseSize);
    const text = p.upper && !o.fontSize ? String(o.text || '').toUpperCase() : String(o.text || '');
    ctx.font = `${o.weight ?? p.weight} ${size}px Impact, "Arial Black", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const m = ctx.measureText(text);
    if (p.bg || o.bg) { // pill background
      const padX = size * 0.5, padY = size * 0.32;
      ctx.fillStyle = o.bg ?? p.bg;
      const rx = -m.width / 2 - padX, ry = -size * 0.62 - padY * 0.4, rw = m.width + padX * 2, rh = size * 1.24 + padY * 0.8;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(rx, ry, rw, rh, rh / 2);
      else ctx.rect(rx, ry, rw, rh);
      ctx.fill();
    }
    const strokeColor = o.stroke ?? p.stroke;
    if (strokeColor && strokeColor !== 'none') {
      ctx.lineWidth = o.strokeWidth ?? Math.max(2, size * 0.09);
      ctx.strokeStyle = strokeColor;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, 0, 0);
    }
    ctx.fillStyle = o.color ?? p.color;
    ctx.fillText(text, 0, 0);
  }

  drawSticker(ctx, w, h, o, pop) {
    const size = (o.size ?? 1) * h * 0.14;
    if (o.char) {
      ctx.font = `${size}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const s = 0.85 + 0.15 * pop;
      ctx.scale(s, s);
      ctx.fillText(o.char, 0, 0);
      return;
    }
    // vector shapes (no stroke, filled — cheap and legible)
    const r = size * (0.85 + 0.15 * pop);
    ctx.fillStyle = o.color ?? '#1f6feb';
    ctx.beginPath();
    if (o.shape === 'rect') ctx.rect(-r * 1.2, -r * 0.8, r * 2.4, r * 1.6);
    else if (o.shape === 'ellipse') ctx.ellipse(0, 0, r, r, 0, 0, Math.PI * 2);
    else if (o.shape === 'star') {
      for (let i = 0; i < 10; i++) {
        const a = (Math.PI / 5) * i - Math.PI / 2, rad = i % 2 ? r * 0.45 : r;
        i ? ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad) : ctx.moveTo(Math.cos(a) * rad, Math.sin(a) * rad);
      }
      ctx.closePath();
    }
    ctx.fill();
  }
}

/** topmost overlay whose (approximate) bbox contains normalized point nx,ny —
 *  pure, no canvas: width approximated from char count (good enough for a
 *  finger-sized drag target; ponytail: precise measureText hit if needed) */
export function overlayHit(overlays, nx, ny, t) {
  const active = (overlays || []).map((o, i) => ({ o, i })).filter(({ o }) => t >= o.t0 && t < o.t1);
  for (const { o, i } of active.reverse()) {
    const half = o.type === 'text' ? (o.size ?? 1) * 0.065 * 0.55 * Math.max(4, String(o.text || '').length) * 0.6 : (o.size ?? 1) * 0.14 * 0.8;
    const halfH = o.type === 'text' ? (o.size ?? 1) * 0.065 * 0.7 : (o.size ?? 1) * 0.14 * 0.8;
    if (Math.abs(nx - o.x) <= half && Math.abs(ny - o.y) <= halfH) return i;
  }
  return null;
}
