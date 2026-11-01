// MOGRT elements — HookCard (wipe + dim), StepList (frosted sidebar),
// MetricCallout (animated counter), ProgressBar. (SafeZones → elements/guides.js)

import { EASE } from '../../engine/motion.js';

export class HookCard {
  constructor(edl, t) { this.edl = edl; }
  render(ctx, w, h, t) {
    const title = this.edl.hookTitle;
    if (!title || t > 3.2) return;
    const wipe = EASE.outExpo(Math.min(1, t / 0.7));       // reveal over 0.7s
    const fade = t < 2.7 ? 1 : 1 - (t - 2.7) / 0.5;        // out by 3.2s
    ctx.save();
    ctx.globalAlpha = Math.max(0, fade) * 0.25;            // dim the video slightly
    ctx.fillStyle = '#000';
    ctx.fillRect(0, h * 0.08, w, h * 0.3);
    ctx.globalAlpha = Math.max(0, fade);
    const size = (this.edl.style.captionSize || 72) * 1.15;
    ctx.font = `700 ${size}px Lora, Georgia, serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lines = wrap(ctx, title, w * 0.8);
    lines.forEach((line, i) => {
      const y = h * 0.2 + (i - (lines.length - 1) / 2) * size * 1.2;
      const lw = ctx.measureText(line).width;
      // wipe: clip to a left-to-right reveal band
      ctx.save();
      ctx.beginPath();
      ctx.rect(w / 2 - lw / 2, y - size, lw * wipe, size * 2);
      ctx.clip();
      ctx.lineWidth = size * 0.14; ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(line, w / 2, y);
      ctx.fillStyle = '#FAF9F5';
      ctx.fillText(line, w / 2, y);
      ctx.restore();
    });
    ctx.restore();
  }
}

export class StepList {
  constructor(edl, tl, t) { this.edl = edl; this.tl = tl; }
  render(ctx, w, h, t) {
    // steps ARE the GLM chapters (red-team: no schema growth)
    const steps = (this.edl.steps || []).filter((s) => {
      const at = this.tl.sourceToEdited(this.edl.words[s.from]?.start ?? 0);
      return at != null && at <= t;
    }).map((s) => ({ ...s, label: s.label || s.title }));
    if (!steps.length) return;
    const size = Math.round(h * 0.022);
    ctx.save();
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    const x = w * 0.06, y0 = h * 0.2;
    const bw = Math.max(...steps.map((s) => ctx.measureText(s.label).width)) + size * 2.6;
    steps.slice(-5).forEach((s, i) => {
      const at = this.tl.sourceToEdited(this.edl.words[s.from]?.start ?? 0);
      const enter = Math.min(1, (t - at) / 0.35);
      const y = y0 + i * size * 2.1 + (1 - enter) * 14;
      ctx.globalAlpha = 0.78 * enter;
      ctx.fillStyle = 'rgba(15,14,12,0.72)';
      roundRect(ctx, x, y, bw * enter, size * 1.7, 10);
      ctx.fill();
      ctx.globalAlpha = enter;
      ctx.fillStyle = '#D97757';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(`${i + 1}`, x + size * 0.8, y + size * 0.85);
      ctx.fillStyle = '#F5F4EF';
      ctx.fillText(s.label, x + size * 1.9, y + size * 0.85);
    });
    ctx.restore();
  }
}

export class MetricCallout {
  constructor(edl, tl, t) { this.edl = edl; this.tl = tl; }
  render(ctx, w, h, t) {
    for (const m of this.edl.metrics || []) {
      const at = this.tl.sourceToEdited(this.edl.words[m.at]?.start ?? 0);
      if (at == null || t < at || t > at + 2.6) continue;
      const p = Math.min(1, (t - at) / 1.1);
      const value = Math.round(m.value * EASE.outExpo(p));
      const size = Math.round(h * 0.05);
      const label = `${m.up ? '▲' : '▼'} ${value}${m.unit || ''}`;
      ctx.save();
      ctx.globalAlpha = t > at + 2.2 ? 1 - (t - at - 2.2) / 0.4 : 1;
      ctx.font = `800 ${size}px system-ui, sans-serif`;
      ctx.textAlign = 'right'; ctx.textBaseline = 'top';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = m.up ? '#788C5D' : '#D97757';
      roundRect(ctx, w * 0.94 - tw - size, h * 0.36, tw + size * 1.2, size * 1.6, 10);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(label, w * 0.94 - size * 0.5, h * 0.36 + size * 0.3);
      if (m.label) {
        ctx.font = `500 ${size * 0.4}px system-ui, sans-serif`;
        ctx.fillStyle = '#F5F4EF';
        ctx.fillText(m.label, w * 0.94 - size * 0.5, h * 0.36 + size * 1.15);
      }
      ctx.restore();
      return; // one callout at a time
    }
  }
}

export class ProgressBar {
  constructor(tl, t) { this.tl = tl; }
  render(ctx, w, h, t) {
    // bottom-anchored: the top 14% is platform-unsafe (our own SafeZones say so)
    const p = Math.max(0, Math.min(1, t / Math.max(0.001, this.tl.duration)));
    const bar = Math.max(3, h * 0.004);
    ctx.save();
    ctx.fillStyle = 'rgba(31,111,235,0.9)';
    ctx.fillRect(0, h - bar, w * p, bar);
    ctx.restore();
  }
}

function wrap(ctx, text, maxW) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const wd of words) {
    const test = cur ? `${cur} ${wd}` : wd;
    if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = wd; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
