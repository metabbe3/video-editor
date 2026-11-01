// Timeline view — CapCut/Premiere-style PROGRAM timeline (edited time):
//   ruler | V track (segments, B-roll slots, punch markers) | W track (caption
//   chunks) | A track (waveform inside kept spans). Drag segment edges to trim,
//   drag ruler/empty space to scrub, wheel to scroll, ⌘/Ctrl+wheel to zoom.

import { timelineOf, captionsOf } from '../core/Compositor.js';

const ROWS = { ruler: 22, t: 16, b1: 16, b2: 16, v: 40, w: 20, a1: 24, a2: 16, a3: 16 };

export function createTimelineView(canvas, host) {
  const ctx = canvas.getContext('2d');
  const T = { pxPerSec: 0, scroll: 0, drag: null, hoverEdge: null };
  let showLabels = false;

  const css = () => getComputedStyle(document.documentElement);
  const col = (name) => css().getPropertyValue(name).trim();
  const gutter = () => showLabels ? 26 : 8;

  function duration() { const e = host.getEdl(); return e ? timelineOf(e).duration : 0; }

  function layout() {
    const dpr = devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr; canvas.height = H * dpr;
    }
    return { dpr, W, H };
  }

  function fit() {
    const { W } = layout();
    const avail = W - gutter() - 8;
    T.pxPerSec = Math.max(2, avail / Math.max(0.5, duration()));
    T.scroll = 0;
  }

  const xOf = (t, W) => gutter() + t * T.pxPerSec - T.scroll;
  const tOf = (x) => (x - gutter() + T.scroll) / T.pxPerSec;
  const snapT = (t) => {
    if (!host.getSnap || !host.getSnap()) return t;
    const pts = (host.snapPoints ? host.snapPoints() : []).slice().sort((a, b) => Math.abs(a - t) - Math.abs(b - t));
    const tol = 8 / T.pxPerSec; // 8px magnet radius
    return pts.length && Math.abs(pts[0] - t) <= tol ? pts[0] : t;
  };

  function draw(playT = -1) {
    const { dpr, W, H } = layout();
    const edl = host.getEdl();
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const ink = col('--ink'), ink2 = col('--ink-2'), clay = col('--accent'),
      border = col('--border-soft'), raise = col('--bg-raise');
    if (!edl) {
      ctx.fillStyle = ink2; ctx.font = '12px ' + col('--sans')?.replace?.(/,.*/, '') || '12px sans-serif';
      ctx.fillText('Timeline appears after Analyze', gutter() + 8, 24);
      ctx.restore();
      return;
    }
    const tl = timelineOf(edl);
    if (!T.pxPerSec) fit();

    // row geometry — full lane stack (T/B1/B2/V/W/A1/A2/A3); lanes without data stay 0-height
    let y = 0;
    const rows = {};
    const hasB = (edl.broll || []).length > 0;
    const hasT = (edl.steps || []).length > 0 || (edl.overlays || []).length > 0;
    const hasSfx = (edl.sfx || []).length > 0;
    const hasAo = (edl.audioOverlays || []).length > 0;
    const hasBgm = !!edl.bgm?.src;
    for (const [k, h] of Object.entries(ROWS)) {
      const on = (k === 'b1' || k === 'b2') ? hasB : k === 't' ? hasT : (k === 'a2') ? (hasSfx || hasAo) : k === 'a3' ? hasBgm : true;
      rows[k] = { y, h: on ? h : 0 };
      y += on ? h : 0;
    }

    // ---- ruler ----
    ctx.font = '11.5px ' + (col('--mono') || 'ui-monospace, Menlo, monospace');
    ctx.textAlign = 'center';
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    const step = steps.find((s) => s * T.pxPerSec >= 64) ?? 300;
    for (let t = 0; t <= tl.duration + 1e-6; t += step) {
      const x = xOf(t, W);
      if (x < gutter() - 1 || x > W) continue;
      ctx.strokeStyle = border;
      ctx.beginPath(); ctx.moveTo(x, rows.ruler.y + 14); ctx.lineTo(x, rows.ruler.y + 22); ctx.stroke();
      ctx.fillStyle = ink2;
      ctx.fillText(fmt(t), x, rows.ruler.y + 11);
    }

    // Ghost markers for proposed cuts (preview-only, hatched accent strip on duration ruler)
    const proposals = host.getProposals?.() || [];
    if (proposals.length) {
      for (const p of proposals) {
        if (p.status === 'rejected') continue;
        const px0 = xOf(tl.sourceToEdited(p.start) ?? p.start);
        const px1 = xOf(tl.sourceToEdited(p.end) ?? p.end);
        if (px1 < gutter() || px0 > W) continue;
        const markW = Math.max(3, px1 - px0);
        const ry = rows.ruler.y + rows.ruler.h - 5;
        ctx.fillStyle = 'rgba(31, 111, 235, 0.15)';
        ctx.fillRect(px0, ry, markW, 4);
        ctx.strokeStyle = clay;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let hx = px0; hx <= px0 + markW; hx += 4) {
          ctx.moveTo(hx, ry);
          ctx.lineTo(hx + 3, ry + 4);
        }
        ctx.stroke();
      }
    }

    // ---- V track: segments ----
    const vRow = rows.v;
    ctx.fillStyle = raise; ctx.fillRect(0, vRow.y, W, vRow.h);
    for (let i = 0; i < tl.segments.length; i++) {
      const s = tl.segments[i];
      const x0 = xOf(tl.starts[i]), x1 = xOf(tl.starts[i] + s.dur);
      const y = vRow.y + 5, h = vRow.h - 10;
      const isSelected = host.getSelected?.() === i;
      ctx.fillStyle = isSelected ? clay : raise;
      ctx.strokeStyle = isSelected ? clay : border;
      roundRect(ctx, x0, y, Math.max(2, x1 - x0), h, 5); ctx.fill(); ctx.stroke();
      if (s.freeze > 0) { // freeze tail: frosted strip at the clip's end
        const playW = ((s.out - s.in) / s.rate / s.dur) * (x1 - x0);
        ctx.fillStyle = isSelected ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.06)';
        ctx.fillRect(Math.max(x0, x1 - (x1 - x0 - playW)), y, Math.max(0, x1 - x0 - playW), h);
      }
      if (x1 - x0 > 64) {
        ctx.fillStyle = isSelected ? '#ffffff' : ink;
        ctx.font = '10.5px ' + (col('--mono') || 'ui-monospace, Menlo, monospace'); ctx.textAlign = 'center';
        const spd = s.rate !== 1 ? ` ${s.rate.toFixed(2).replace(/\.?0+$/, '')}×` : '';
        ctx.fillText(`${fmt(s.in)}→${fmt(s.out)}${spd}${s.freeze > 0 ? ' ❄' : ''} src`, (x0 + x1) / 2, y + h / 2 + 3.5);
      }
      // Keyframe diamond markers on the clip
      const clipKfs = edl.keep[i]?.keyframes;
      if (clipKfs) {
        for (const [propName, track] of Object.entries(clipKfs)) {
          if (!Array.isArray(track)) continue;
          for (let ki = 0; ki < track.length; ki++) {
            const kf = track[ki];
            const kfT = tl.starts[i] + kf.t * s.dur;
            const kfX = xOf(kfT);
            ctx.fillStyle = clay; // Accent diamond
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1;
            drawDiamond(ctx, kfX, y + h / 2, 4.5);
          }
        }
      }
      // Transition marker at join boundary
      if (i < tl.segments.length - 1) {
        const joinT = tl.starts[i] + s.dur;
        const jx = xOf(joinT);
        const trans = (edl.transitions || []).find((q) => Math.abs(q.at - joinT) < 0.05);
        ctx.fillStyle = trans ? clay : 'rgba(255,255,255,0.4)';
        ctx.beginPath();
        ctx.arc(jx, y + h / 2, trans ? 6 : 4, 0, Math.PI * 2);
        ctx.fill();
        if (trans) {
          ctx.fillStyle = '#fff';
          ctx.font = '8px system-ui';
          ctx.textAlign = 'center';
          const sym = trans.type === 'flash' ? '⚡' : (trans.type === 'whip-pan' ? '⇄' : '⧓');
          ctx.fillText(sym, jx, y + h / 2 + 3);
        }
      }
      // trim handles
      for (const [ex, edge] of [[x0, 'in'], [x1, 'out']]) {
        ctx.fillStyle = T.hoverEdge && T.hoverEdge.seg === i && T.hoverEdge.edge === edge ? clay : 'rgba(255,255,255,0.55)';
        ctx.fillRect(ex - 1.5, y, 3, h);
      }
    }
    // B lanes: first-fit b-roll blocks with length labels
    const bLanes = [[], []];
    for (const b of edl.broll || []) {
      const x0 = xOf(b.at), x1 = xOf(b.at + (b.dur || 3));
      const lane = bLanes.find((L) => !L.some(([a, c]) => x0 < c + 4 && x1 > a - 4)) || bLanes[0];
      lane.push([x0, x1, b]);
    }
    bLanes.forEach((L, li) => {
      const row = rows[li === 0 ? 'b1' : 'b2'];
      if (!row.h) return;
      for (const [x0, x1, b] of L) {
        ctx.strokeStyle = 'rgba(115,113,99,0.9)';
        ctx.fillStyle = 'rgba(115,113,99,0.25)';
        ctx.setLineDash([3, 3]);
        roundRect(ctx, x0, row.y + 2, Math.max(4, x1 - x0), row.h - 4, 3);
        ctx.fill(); ctx.stroke();
        ctx.setLineDash([]);
        if (x1 - x0 > 26) {
          ctx.fillStyle = 'rgba(41,38,27,0.75)';
          ctx.font = '9px ui-monospace'; ctx.textAlign = 'left';
          ctx.fillText(`${(b.dur || 3).toFixed(1)}s ${String(b.src || '').split('/').pop().slice(0, 10)}`, x0 + 3, row.y + row.h - 4);
        }
      }
    });

    // T/FX lane: overlay text/stickers & step/chapter blocks
    if (rows.t.h) {
      for (const [oi, o] of (edl.overlays || []).entries()) {
        const x0 = xOf(o.t0), x1 = xOf(o.t1);
        ctx.fillStyle = o.type === 'text' ? 'rgba(31,111,235,0.4)' : 'rgba(245,158,11,0.4)';
        ctx.strokeStyle = o.type === 'text' ? clay : '#f59e0b';
        roundRect(ctx, x0, rows.t.y + 2, Math.max(8, x1 - x0), rows.t.h - 4, 3);
        ctx.fill(); ctx.stroke();
        if (x1 - x0 > 24) {
          ctx.fillStyle = '#fff'; ctx.font = '9px system-ui'; ctx.textAlign = 'left';
          const txt = o.type === 'text' ? `✍ ${o.text || 'text'}` : `😀 ${o.char || 'sticker'}`;
          ctx.fillText(txt.slice(0, 14), x0 + 4, rows.t.y + rows.t.h - 4);
        }
      }
      for (const s of edl.steps || []) {
        const at = tl.sourceToEdited(edl.words?.[s.from]?.start ?? 0);
        if (at == null) continue;
        const x0 = xOf(at);
        ctx.fillStyle = 'rgba(122,140,93,0.55)';
        roundRect(ctx, x0, rows.t.y + 2, Math.max(8, 40), rows.t.h - 4, 3); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = '9px system-ui'; ctx.textAlign = 'left';
        ctx.fillText((s.title || s.label || '').slice(0, 8), x0 + 3, rows.t.y + rows.t.h - 5);
      }
    }

    // A3 BGM bar + auto-ducking gain curve overlay
    if (rows.a3.h) {
      ctx.fillStyle = 'rgba(212,163,115,0.4)';
      roundRect(ctx, gutter(), rows.a3.y + 2, Math.max(10, xOf(tl.duration) - gutter()), rows.a3.h - 4, 3); ctx.fill();
      ctx.fillStyle = '#29261b'; ctx.font = '9px system-ui'; ctx.textAlign = 'left';
      const bgmName = String(edl.bgm?.src || '').split('/').pop() || 'Music';
      ctx.fillText(`🎵 ${bgmName} · ${tl.duration.toFixed(0)}s`, gutter() + 4, rows.a3.y + rows.a3.h - 4);

      // Thin visual gain curve overlay for auto-duck
      const duck = host.getDuckCurve ? host.getDuckCurve() : null;
      if (duck?.points?.length) {
        ctx.strokeStyle = '#1f6feb';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let started = false;
        for (let pi = 0; pi < duck.points.length; pi++) {
          const pt = duck.points[pi];
          const px = xOf(pt.t);
          if (px < gutter() || px > W) continue;
          const normG = Math.max(0, Math.min(1, pt.gain));
          const py = rows.a3.y + rows.a3.h - 3 - normG * (rows.a3.h - 6);
          if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }

    // punch markers — accent ring
    ctx.strokeStyle = clay;
    ctx.fillStyle = raise;
    ctx.lineWidth = 1.5;
    for (const p of edl.punches || []) {
      const x = xOf(p.at);
      ctx.beginPath();
      ctx.arc(x, vRow.y + 4, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.lineWidth = 1;

    // B-roll slots (outlined, own half-row)
    for (const b of edl.broll || []) {
      const x0 = xOf(b.at), x1 = xOf(b.at + b.dur);
      ctx.strokeStyle = ink2; ctx.setLineDash([3, 3]);
      roundRect(ctx, x0, vRow.y + vRow.h - 9, Math.max(2, x1 - x0), 8, 3); ctx.stroke();
      ctx.setLineDash([]);
      if (x1 - x0 > 40) {
        ctx.fillStyle = ink2; ctx.font = '9px ui-monospace'; ctx.textAlign = 'left';
        ctx.fillText(shortName(b.src), x0 + 4, vRow.y + vRow.h - 2);
      }
    }

    // ---- W track: caption chunks ----
    const wRow = rows.w;
    for (const c of captionsOf(edl)) {
      const x0 = xOf(c.t0), x1 = xOf(c.t1);
      const active = playT >= c.t0 && playT < c.t1;
      ctx.fillStyle = active ? 'rgba(31,111,235,0.30)' : raise;
      ctx.strokeStyle = border;
      roundRect(ctx, x0, wRow.y + 3, Math.max(2, x1 - x0), wRow.h - 6, 3);
      ctx.fill(); ctx.stroke();
      if (x1 - x0 > 34) {
        ctx.fillStyle = active ? clay : ink2; ctx.font = '9px system-ui'; ctx.textAlign = 'left';
        ctx.fillText(c.text.slice(0, Math.floor((x1 - x0) / 5.2)), x0 + 3, wRow.y + 13);
      }
    }

    // ---- A1: waveform (energy inside kept spans) ----
    const aRow = rows.a1;
    const energy = host.getEnergy();
    if (energy) {
      const { hopSec } = host.getEnergy();
      for (let i = 0; i < tl.segments.length; i++) {
        const s = tl.segments[i];
        const x0 = xOf(tl.starts[i]), x1 = xOf(tl.starts[i] + s.dur);
        const playFrac = ((s.out - s.in) / s.rate) / s.dur; // freeze tail has no waveform
        const mid = rows.a1.y + rows.a1.h / 2;
        ctx.fillStyle = ink2;
        const wx1 = x0 + (x1 - x0) * playFrac;
        for (let x = Math.max(gutter(), Math.ceil(x0)); x < Math.min(W, wx1); x++) {
          const src = s.in + ((x - x0) / (wx1 - x0)) * (s.out - s.in);
          const v = energy[Math.min(energy.length - 1, Math.floor(src / hopSec))] || 0;
          const h = Math.max(0.6, Math.min(1, v * 3.2) * (aRow.h / 2 - 2)); // gain: speech ~0.1-0.3 rms
          ctx.fillRect(x, mid - h, 1, h * 2);
        }
      }
    }

    // Audio overlays (voiceover) on lane a2
    if (rows.a2.h && (edl.audioOverlays || []).length > 0) {
      for (const ao of edl.audioOverlays) {
        const x0 = xOf(ao.at), x1 = xOf(ao.at + (ao.dur || 1));
        ctx.fillStyle = 'rgba(217, 119, 87, 0.45)';
        ctx.strokeStyle = '#d97757';
        roundRect(ctx, x0, rows.a2.y + 2, Math.max(6, x1 - x0), rows.a2.h - 4, 3);
        ctx.fill(); ctx.stroke();
        if (x1 - x0 > 24) {
          ctx.fillStyle = '#fff';
          ctx.font = '9px system-ui';
          ctx.textAlign = 'left';
          ctx.fillText(`🎙️ ${ao.name || 'VO'}`, x0 + 4, rows.a2.y + rows.a2.h - 4);
        }
      }
    }

    // SFX pins on the A row
    ctx.font = '9px system-ui';
    for (const e of edl.sfx || []) {
      const x = xOf(e.at);
      if (x < gutter() || x > W) continue;
      ctx.fillStyle = '#D97757';
      ctx.beginPath();
      ctx.arc(x, (rows.a2.h ? rows.a2.y : rows.a1.y + rows.a1.h) + 8, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    currentRows = rows;

    // ---- playhead ----
    if (playT >= 0) {
      const x = xOf(playT);
      ctx.strokeStyle = clay; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.fillStyle = clay;
      tri(ctx, x, 0, 5, true);
    }

    // gutter labels (only lanes with height, and only if showLabels is true)
    if (showLabels) {
      ctx.fillStyle = ink2; ctx.font = '10px system-ui'; ctx.textAlign = 'center';
      const labels = { t: 'T', b1: 'B1', b2: 'B2', v: 'V', w: 'W', a1: 'A1', a2: 'A2', a3: 'A3' };
      for (const k of Object.keys(labels)) if (rows[k] && rows[k].h) ctx.fillText(labels[k], gutter() / 2, rows[k].y + rows[k].h / 2 + 3);
    }
    ctx.restore();
  }

  // ---------- interaction ----------
  const segAtX = (edl, x) => {
    const tl = timelineOf(edl);
    let best = null; // nearest grabbable edge across BOTH segments adjoining a boundary
    for (let i = 0; i < tl.segments.length; i++) {
      const x0 = xOf(tl.starts[i]), x1 = xOf(tl.starts[i] + tl.segments[i].dur);
      for (const [ex, edge] of [[x0, 'in'], [x1, 'out']]) {
        const d = Math.abs(x - ex);
        if (d <= 5 && (!best || d < best.d)) best = { seg: i, edge, d, x0, x1 };
      }
      if (!best && x >= x0 && x <= x1) best = { seg: i, edge: null, d: Infinity, x0, x1 }; // inside, no edge
    }
    return best;
  };

  // pointer position relative to the canvas — rect math, not e.offsetX/Y
  // (synthetic + retargeted pointer events compute offsets against the wrong node)
  const pt = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const keyframeAt = (edl, x, y, rows) => {
    if (!rows.v?.h || y < rows.v.y || y > rows.v.y + rows.v.h) return null;
    const tl = timelineOf(edl);
    for (let i = 0; i < tl.segments.length; i++) {
      const s = tl.segments[i];
      const kfs = edl.keep[i]?.keyframes;
      if (!kfs) continue;
      for (const [propName, track] of Object.entries(kfs)) {
        if (!Array.isArray(track)) continue;
        for (let ki = 0; ki < track.length; ki++) {
          const kf = track[ki];
          const kfX = xOf(tl.starts[i] + kf.t * s.dur);
          const kfY = rows.v.y + rows.v.h / 2;
          if (Math.hypot(x - kfX, y - kfY) <= 8) {
            return { seg: i, propName, kfIndex: ki, kf, kfX, kfY, s };
          }
        }
      }
    }
    return null;
  };

  const transitionAt = (edl, x, y, rows) => {
    if (!rows.v?.h || y < rows.v.y || y > rows.v.y + rows.v.h) return null;
    const tl = timelineOf(edl);
    for (let i = 0; i < tl.segments.length - 1; i++) {
      const s = tl.segments[i];
      const jx = xOf(tl.starts[i] + s.dur);
      const jy = rows.v.y + rows.v.h / 2;
      if (Math.hypot(x - jx, y - jy) <= 10) {
        const trans = (edl.transitions || []).find((q) => Math.abs(q.at - (tl.starts[i] + s.dur)) < 0.05);
        return { seg: i, at: tl.starts[i] + s.dur, trans };
      }
    }
    return null;
  };

  const overlayAt = (edl, x, y, rows) => {
    if (!rows.t?.h || y < rows.t.y || y > rows.t.y + rows.t.h) return null;
    for (let i = (edl.overlays || []).length - 1; i >= 0; i--) {
      const o = edl.overlays[i];
      const x0 = xOf(o.t0), x1 = xOf(o.t1);
      if (Math.abs(x - x0) <= 6) return { index: i, o, edge: 'in' };
      if (Math.abs(x - x1) <= 6) return { index: i, o, edge: 'out' };
      if (x >= x0 && x <= x1) return { index: i, o, edge: null };
    }
    return null;
  };

  const snapToWordBoundary = (edl, tRaw, tolSec = 0.2) => {
    if (!edl.words?.length) return tRaw;
    const tl = timelineOf(edl);
    let bestT = tRaw;
    let minDiff = tolSec;
    for (const w of edl.words) {
      if (w.keep === false) continue;
      for (const src of [w.start, w.end]) {
        const edT = tl.sourceToEdited(src);
        if (edT != null) {
          const diff = Math.abs(edT - tRaw);
          if (diff < minDiff) {
            minDiff = diff;
            bestT = edT;
          }
        }
      }
    }
    return bestT;
  };

  canvas.addEventListener('pointerdown', (e) => {
    const edl = host.getEdl();
    if (!edl) return;
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = pt(e);
    const rows = rowsOf();

    // 1. Keyframe hit?
    const kfHit = keyframeAt(edl, x, y, rows);
    if (kfHit) {
      T.drag = { kind: 'kfDrag', ...kfHit, startX: x };
      host.selectClip?.(kfHit.seg);
      return;
    }

    // 2. Transition hit?
    const trHit = transitionAt(edl, x, y, rows);
    if (trHit) {
      host.onTransitionClick?.(trHit.seg, trHit.at, trHit.trans);
      return;
    }

    // 3. Lane T overlay hit?
    const ovHit = overlayAt(edl, x, y, rows);
    if (ovHit) {
      if (ovHit.edge) {
        T.drag = { kind: 'overlayTrim', ...ovHit };
      } else {
        T.drag = { kind: 'overlayMove', ...ovHit, startX: x, origT0: ovHit.o.t0, origT1: ovHit.o.t1 };
      }
      host.selectOverlay?.(ovHit.index);
      return;
    }

    const aoHit = (edl.audioOverlays || []).find((ao) => {
      const x0 = xOf(ao.at), x1 = xOf(ao.at + (ao.dur || 1));
      return x >= x0 && x <= x1;
    });
    if (aoHit && rows.a2?.h && y >= rows.a2.y && y < rows.a2.y + rows.a2.h) {
      T.drag = { kind: 'aoDrag', item: aoHit, startX: x, origAt: aoHit.at };
      return;
    }
    const hit = segAtX(edl, x);
    if (hit?.edge) T.drag = { kind: 'trim', seg: hit.seg, edge: hit.edge };
    else if (host.getRazor && host.getRazor() && hit) { host.razorSplit?.(tOf(x)); return; }
    else if (hit && rows.v?.h && y > rows.v.y && y < rows.v.y + rows.v.h) { T.drag = { kind: 'vdrag', seg: hit.seg }; host.selectClip?.(hit.seg); }
    else { T.drag = { kind: 'scrub' }; host.selectClip?.(null); }
    if (T.drag.kind === 'scrub') host.seekTo(clamp(tOf(x), 0, duration()));
  });
  canvas.addEventListener('pointermove', (e) => {
    const x = pt(e).x;
    if (!T.drag) {
      const edl = host.getEdl();
      const hit = edl && segAtX(edl, x);
      T.hoverEdge = hit?.edge ? { seg: hit.seg, edge: hit.edge } : null;
      canvas.style.cursor = T.hoverEdge ? 'ew-resize' : 'text';
      return;
    }
    if (T.drag.kind === 'scrub') host.seekTo(clamp(snapT(tOf(x)), 0, duration()));
    else if (T.drag.kind === 'kfDrag') {
      const tl = timelineOf(host.getEdl());
      const s = tl.segments[T.drag.seg];
      if (s) {
        const segStart = tl.starts[T.drag.seg];
        const newProg = Math.max(0, Math.min(1, (tOf(x) - segStart) / s.dur));
        T.drag.kf.t = +newProg.toFixed(4);
        host.redraw();
      }
    }
    else if (T.drag.kind === 'overlayMove') {
      const edl = host.getEdl();
      const dt = (x - T.drag.startX) / T.pxPerSec;
      const dur = T.drag.origT1 - T.drag.origT0;
      let newT0 = Math.max(0, T.drag.origT0 + dt);
      newT0 = snapToWordBoundary(edl, newT0);
      T.drag.o.t0 = +newT0.toFixed(2);
      T.drag.o.t1 = +(newT0 + dur).toFixed(2);
      host.redraw();
    }
    else if (T.drag.kind === 'overlayTrim') {
      const edl = host.getEdl();
      const curT = snapToWordBoundary(edl, tOf(x));
      if (T.drag.edge === 'in') {
        T.drag.o.t0 = Math.max(0, Math.min(T.drag.o.t1 - 0.2, curT));
      } else {
        T.drag.o.t1 = Math.max(T.drag.o.t0 + 0.2, curT);
      }
      host.redraw();
    }
    else if (T.drag.kind === 'aoDrag') {
      const dt = (x - T.drag.startX) / T.pxPerSec;
      T.drag.item.at = Math.max(0, Math.min(duration() - 0.2, T.drag.origAt + dt));
      host.redraw();
    }
    else if (T.drag.kind === 'vdrag') {
      // magnetic reorder: past a neighbor's midpoint swaps keep order
      const edl = host.getEdl();
      if (!edl) return;
      const tl = timelineOf(edl);
      let to = T.drag.seg;
      for (let i = 0; i < tl.segments.length; i++) {
        const x0 = xOf(tl.starts[i]), x1 = x0 + (tl.segments[i].out - tl.segments[i].in) * T.pxPerSec;
        if (x >= (x0 + x1) / 2 - 1) to = i; else break;
      }
      if (to !== T.drag.seg) { host.reorderSegment?.(T.drag.seg, to); T.drag.seg = to; }
    }
    else host.trimSeg(T.drag.seg, T.drag.edge, snapT(tOf(x)));
  });
  const endDrag = () => {
    if (T.drag?.kind === 'trim') host.commitTrim();
    if (T.drag?.kind === 'aoDrag') host.commitTrim?.();
    if (T.drag?.kind === 'kfDrag') host.commitKeyframe?.();
    if (T.drag?.kind === 'overlayMove' || T.drag?.kind === 'overlayTrim') host.commitOverlayChange?.();
    T.drag = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('contextmenu', (e) => {
    const edl = host.getEdl();
    if (!edl) return;
    const { x, y } = pt(e);
    const rows = rowsOf();
    const kfHit = keyframeAt(edl, x, y, rows);
    if (kfHit) {
      e.preventDefault();
      host.deleteKeyframe?.(kfHit.seg, kfHit.propName, kfHit.kfIndex);
      return;
    }
    const trHit = transitionAt(edl, x, y, rows);
    if (trHit) {
      e.preventDefault();
      host.onTransitionClick?.(trHit.seg, trHit.at, trHit.trans);
      return;
    }
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const x = pt(e).x;
      const at = tOf(x);
      T.pxPerSec = Math.min(400, Math.max(2, T.pxPerSec * (e.deltaY < 0 ? 1.18 : 1 / 1.18)));
      T.scroll = Math.max(0, at * T.pxPerSec - (x - gutter()));
    } else {
      T.scroll = Math.max(0, T.scroll + e.deltaY + e.deltaX);
    }
    draw(-2);
    host.redraw();
  }, { passive: false });
  canvas.addEventListener('dblclick', () => fit() || draw(-2) || host.redraw());
  canvas.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    const payload = e.dataTransfer.getData('application/x-fyp');
    if (!payload || !host.onDrop) return;
    host.onDrop(JSON.parse(payload), tOf(pt(e).x), laneAt(pt(e).y, rowsOf()));
  });
  const rowsOf = () => currentRows;
  function laneAt(y, r) {
    for (const k of ['t', 'b1', 'b2', 'v', 'w', 'a1', 'a2', 'a3']) if (r[k] && r[k].h && y >= r[k].y && y < r[k].y + r[k].h) return k;
    return y < r.v.y ? 'b1' : 'a3';
  }
  let currentRows = {};

  return {
    draw, fit,
    get pxPerSec() { return T.pxPerSec; },
    zoom(f) { T.pxPerSec = Math.min(400, Math.max(2, T.pxPerSec * f)); draw(-2); host.redraw(); },
    get showLabels() { return showLabels; },
    toggleLabels() {
      showLabels = !showLabels;
      fit();
      draw();
      return showLabels;
    },
  };
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function tri(ctx, x, y, s, up = false) {
  ctx.beginPath();
  if (up) { ctx.moveTo(x, y + s); ctx.lineTo(x - s, y); ctx.lineTo(x + s, y); }
  else { ctx.moveTo(x, y); ctx.lineTo(x - s, y + s); ctx.lineTo(x + s, y + s); }
  ctx.closePath(); ctx.fill();
}
function drawDiamond(ctx, cx, cy, r) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}
function fmt(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(s < 10 ? 1 : 0)}`;
}
function shortName(p) { return (p || '').split('/').pop().slice(0, 18); }
