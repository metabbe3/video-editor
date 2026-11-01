// MediaBin — B-roll pool with hover-scrub thumbnails + one-click insert at the
// playhead (word-anchored so inserts survive trims) + auto-fill over jump cuts.

import { Input, ALL_FORMATS, BlobSource, VideoSampleSink } from 'https://cdn.jsdelivr.net/npm/mediabunny@1.64.0/+esm';
import { timelineOf } from '../core/Compositor.js';

// dropped from the timeline: { id, kind } + lane

const thumbCache = new Map(); // fileId -> dataURL

async function firstFrameThumb(file) {
  try {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const sink = new VideoSampleSink(track);
    const sample = await sink.getSample(0.2);
    if (!sample) return null;
    const vf = sample.toVideoFrame ? sample.toVideoFrame() : sample;
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = Math.round((160 * (vf.displayHeight || vf.codedHeight)) / (vf.displayWidth || vf.codedWidth));
    c.getContext('2d').drawImage(vf, 0, 0, c.width, c.height);
    vf.close?.();
    return c.toDataURL('image/jpeg', 0.6);
  } catch { return null; }
}

export async function renderMediaBin(app) {
  const p = app.project;
  const bin = document.getElementById('mediaBin');
  if (!bin) return;
  bin.textContent = '';
  const pool = p.reg?.brollPool ?? [];
  document.getElementById('mediaBinWrap').hidden = !pool.length && !p.reg?.arollId;

  // A-roll header
  if (p.reg?.arollId) {
    const a = document.createElement('div');
    a.style.cssText = 'font-size:var(--fs-small);color:var(--ink-2);margin-bottom:6px';
    a.textContent = `A-Roll: ${p.reg.arollId.split('/').pop()} — click B-roll below to cover cuts`;
    bin.appendChild(a);
  }
  if (!pool.length) return;

  // thumbnails (hover-scrub via seek on a shared hidden video per card)
  for (const r of pool) {
    const card = document.createElement('div');
    card.style.cssText = 'display:flex;gap:8px;align-items:center;padding:4px 6px;border-radius:6px;cursor:grab;background:var(--bg)';
    card.draggable = true;
    card.ondragstart = (e) => e.dataTransfer.setData('application/x-fyp', JSON.stringify({ id: r.id, kind: r.kind }));
    card.onmouseenter = () => { card.style.background = 'var(--bg-raise)'; };
    card.onmouseleave = () => { card.style.background = 'var(--bg)'; };
    const img = document.createElement('img');
    if (!thumbCache.has(r.id)) thumbCache.set(r.id, await firstFrameThumb(r.file));
    const url = thumbCache.get(r.id);
    if (url) { img.src = url; img.style.cssText = 'width:64px;border-radius:6px;display:block'; }
    else img.remove();
    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:var(--fs-small);color:var(--ink-2);flex:1;min-width:0';
    meta.textContent = r.name;
    const btn = document.createElement('button');
    btn.className = 'tbtn';
    btn.style.cssText = 'width:auto;padding:3px 8px;font-size:var(--fs-small)';
    btn.textContent = '+ at playhead';
    btn.onclick = (e) => { e.stopPropagation(); insertBrollAtPlayhead(app, r.id); };
    card.append(img, meta, btn);
    card.onclick = () => insertBrollAtPlayhead(app, r.id);
    bin.appendChild(card);
  }

  // auto-fill button
  const fill = document.createElement('button');
  fill.className = 'tbtn';
  fill.style.cssText = 'width:100%;margin-top:8px;padding:6px 12px;font-size:var(--fs-ui)';
  fill.textContent = '⚡ Auto-fill B-roll over jump cuts';
  fill.onclick = () => autoFillBroll(app);
  bin.appendChild(fill);
}

/** word-anchored insert: the entry references word indices, Project resolves lazily */
export function insertBrollAt(app, srcId, atEdited) {
  const p = app.project;
  if (!p.edl) return app.toast('Analyze first');
  app.pushUndo();
  const tl = timelineOf(p.edl);
  const src = atEdited != null ? (tl.editedToSource(atEdited)?.src) : (tl.editedToSource(app.preview.editedTime())?.src);
  const wi = p.words.findIndex((w) => src >= w.start && src < w.end);
  if (wi < 0) return app.toast('No word at drop point');
  const v = p.variant ?? {};
  (v.broll ??= []).push({ words: [wi, wi], src: srcId, dur: 3, layout: 'fullscreen' });
  p.edl = { ...p.edl, broll: resolveBroll(p, v.broll ?? p.edl.broll ?? []) };
  app.refreshDerived();
  app.renderMediaBin();
  app.toast(`B-roll over “${p.words[wi].w}”`);
}

export function insertBrollAtPlayhead(app, srcId) {
  const p = app.project;
  if (!p.edl) return app.toast('Analyze first');
  app.pushUndo();
  const tl = timelineOf(p.edl);
  const src = tl.editedToSource(app.preview.editedTime())?.src;
  const wi = p.words.findIndex((w) => src >= w.start && src < w.end);
  if (wi < 0) return app.toast('No word at playhead');
  const v = p.variant;
  const target = v ?? { };
  (target.broll ??= []).push({ words: [wi, wi], src: srcId, dur: 3, layout: 'fullscreen' });
  if (!v) p.glmResult ??= {}; // local mode: stash on the EDL path via a side list
  p.edl = { ...p.edl, broll: resolveBroll(p, target.broll ?? p.edl.broll ?? []) };
  app.refreshDerived();
  app.renderMediaBin();
  app.toast(`B-roll over “${p.words[wi].w}”`);
}

/** resolve word-anchored entries to edited times (lazily — survives trims;
 *  entries whose anchor words were cut are dropped) */
export function resolveBroll(p, entries) {
  const tl = p.edl ? timelineOf(p.edl) : null;
  if (!tl) return [];
  const out = [];
  for (const b of entries ?? []) {
    const anchor = typeof b.words?.[0] === 'number' ? b.words[0] : b.anchorWord;
    let at = null;
    if (anchor != null) {
      const w = p.words[anchor];
      at = w ? tl.sourceToEdited(w.start) : null;
    } else if (typeof b.at === 'number') at = b.at;
    if (at == null) continue; // anchor cut away -> entry drops
    out.push({ ...b, at });
  }
  return out;
}

/** cover every >1s-removal join with a pool clip (round-robin), 3s each */
export function autoFillBroll(app) {
  const p = app.project;
  if (!p.edl) return;
  const pool = p.reg?.brollPool ?? [];
  if (!pool.length) return app.toast('No B-roll in folder');
  app.pushUndo();
  const keep = p.edl.keep;
  const tl = timelineOf(p.edl);
  const existing = (p.edl.broll ?? []).map((b) => b.at);
  let n = 0;
  const additions = [];
  for (let i = 1; i < keep.length; i++) {
    const removed = keep[i].in - keep[i - 1].out;
    if (removed <= 1.0) continue;
    const at = tl.starts[i];
    if (existing.some((e) => Math.abs(e - at) < 2.5)) continue;
    additions.push({ words: [wordAtSource(p, keep[i].in)], src: pool[n++ % pool.length].id, dur: 3, layout: 'fullscreen', at });
  }
  p.edl = { ...p.edl, broll: [...(p.edl.broll ?? []), ...additions] };
  app.refreshDerived();
  app.toast(`Covered ${additions.length} jump cuts`);
}

function wordAtSource(p, src) {
  const i = p.words.findIndex((w) => src >= w.start && src < w.end);
  return Math.max(0, i);
}
