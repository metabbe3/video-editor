// Inspector — right panel, OpenCut properties-panel pattern: shows the
// selected clip's properties (speed/freeze in Phase 4, effects/mask in 5),
// or project properties when nothing is selected.

import { timelineOf } from '../core/Compositor.js';
import { CAPTION_LABELS } from './labels.js';
import { EFFECTS, clampParams } from '../effects/clipfx.js';

const $ = (id) => document.getElementById(id);

export function renderInspector(app) {
  const el = $('inspector');
  const p = app.project;
  if (p.edl && app.selectedClipIndex != null && !p.edl.keep[app.selectedClipIndex]) app.selectedClipIndex = null;
  el.textContent = '';
  const head = document.createElement('div');
  head.className = 'ihead';
  el.appendChild(head);

  if (!p.edl || app.selectedClipIndex == null) {
    head.textContent = 'Inspector — project';
    if (p.edl) {
      const s = p.edl.style;
      kv(el, 'Frame', `${s.w}×${s.h} @ ${s.fps}fps`);
      kv(el, 'Captions', `${CAPTION_LABELS?.[s.captionStyle] ?? s.captionStyle} · ${s.captionsMode}`);
      kv(el, 'Fit', s.fit);
    } else {
      kv(el, '', 'Analyze a video first.');
    }
    return;
  }

  const i = app.selectedClipIndex;
  const k = p.edl.keep[i];
  const tl = timelineOf(p.edl);
  const seg = tl.segments[i];
  head.textContent = `Clip ${i + 1} / ${p.edl.keep.length}`;
  const x = document.createElement('span');
  x.textContent = '✕';
  x.style.cssText = 'margin-left:auto;cursor:pointer;color:var(--ink-2)';
  x.onclick = () => app.selectClip(null);
  head.appendChild(x);

  kv(el, 'Source in → out', `${k.in.toFixed(2)} → ${k.out.toFixed(2)}s`);
  kv(el, 'Edited length', `${(seg ? seg.dur : k.out - k.in).toFixed(2)}s`);
  if (k.why) kv(el, 'Kept because', k.why);
  if (k.locked) kv(el, '🔒', 'Locked — AI will not edit this card');

  // ⚡ speed + ❄ freeze (applied on change, not per-tick, so undo stays sane)
  const spdRow = document.createElement('div');
  spdRow.className = 'irow';
  const spdLab = document.createElement('label');
  spdLab.textContent = '⚡ Speed';
  const spd = document.createElement('input');
  spd.type = 'range'; spd.min = '0.25'; spd.max = '4'; spd.step = '0.05';
  spd.value = String(k.speed ?? 1);
  const spdVal = document.createElement('span');
  spdVal.style.cssText = 'font-family:var(--mono);font-size:11.5px;min-width:34px;text-align:right';
  spdVal.textContent = `${(k.speed ?? 1).toFixed(2).replace(/\.?0+$/, '')}×`;
  spd.oninput = () => (spdVal.textContent = `${Number(spd.value).toFixed(2).replace(/\.?0+$/, '')}×`);
  spd.onchange = () => app.mutateClip(i, { speed: Number(spd.value) === 1 ? undefined : Number(spd.value) });
  spdRow.append(spdLab, spd, spdVal);
  el.appendChild(spdRow);
  const presets = document.createElement('div');
  presets.className = 'irow';
  for (const v of [0.5, 1, 1.5, 2]) {
    const b = document.createElement('button');
    b.className = 'tbtn';
    b.style.cssText = 'width:auto;padding:2px 9px;font-size:11.5px';
    b.textContent = `${v}×`;
    b.onclick = () => app.mutateClip(i, { speed: v === 1 ? undefined : v });
    presets.appendChild(b);
  }
  const fz = document.createElement('button');
  fz.className = 'tbtn';
  fz.style.cssText = 'width:auto;padding:2px 9px;font-size:11.5px;margin-left:auto';
  fz.textContent = k.freeze ? `❄ ${k.freeze.toFixed(1)}s — off` : '❄ Freeze 1s';
  fz.title = 'Hold this clip\'s last frame for N seconds (end-freeze)';
  fz.onclick = () => app.mutateClip(i, { freeze: k.freeze ? undefined : 1 });
  presets.appendChild(fz);
  el.appendChild(presets);

  // ✨ per-clip effect stack — toggle chips + param sliders from the registry schema
  const fxCtrl = document.createElement('div');
  fxCtrl.className = 'irow';
  fxCtrl.style.flexWrap = 'wrap';
  const effects = k.effects || [];
  for (const [id, def] of Object.entries(EFFECTS)) {
    const on = effects.some((e) => e.id === id && e.on !== false);
    const b = document.createElement('button');
    b.className = 'tbtn';
    b.style.cssText = `width:auto;padding:2px 9px;font-size:11.5px${on ? ';background:var(--accent);color:#fff;border-color:var(--accent)' : ''}`;
    b.textContent = def.label;
    b.onclick = () => {
      const next = on
        ? effects.map((e) => (e.id === id ? { ...e, on: false } : e))
        : [...effects.filter((e) => e.id !== id), { id, params: clampParams(id, {}), on: true }];
      app.mutateClip(i, { effects: next });
    };
    fxCtrl.appendChild(b);
  }
  el.appendChild(fxCtrl);
  for (const e of effects.filter((x) => x.on !== false && EFFECTS[x.id])) {
    for (const [pk, schema] of Object.entries(EFFECTS[e.id].params)) {
      const row = document.createElement('div');
      row.className = 'irow';
      const lab = document.createElement('label');
      lab.textContent = `${EFFECTS[e.id].label} ${schema.label}`;
      const rng = document.createElement('input');
      rng.type = 'range'; rng.min = String(schema.min); rng.max = String(schema.max); rng.step = String(schema.step);
      rng.value = String(clampParams(e.id, e.params)[pk]);
      const val = document.createElement('span');
      val.style.cssText = 'font-family:var(--mono);font-size:11px;min-width:28px;text-align:right';
      val.textContent = String(clampParams(e.id, e.params)[pk]);
      rng.oninput = () => (val.textContent = rng.value);
      rng.onchange = () => app.mutateClip(i, {
        effects: effects.map((x) => (x === e ? { ...x, params: { ...clampParams(x.id, x.params), [pk]: Number(rng.value) } } : x)),
      });
      row.append(lab, rng, val);
      el.appendChild(row);
    }
  }

  // 🎭 shape mask
  const maskRow = document.createElement('div');
  maskRow.className = 'irow';
  maskRow.style.flexWrap = 'wrap';
  const shapes = ['none', 'rect', 'ellipse', 'cinematic-bars', 'split'];
  for (const s of shapes) {
    const on = (k.mask?.shape ?? 'none') === s;
    const b = document.createElement('button');
    b.className = 'tbtn';
    b.style.cssText = `width:auto;padding:2px 8px;font-size:11.5px${on ? ';background:var(--accent);color:#fff;border-color:var(--accent)' : ''}`;
    b.textContent = s === 'cinematic-bars' ? 'bars' : s;
    b.onclick = () => app.mutateClip(i, {
      mask: s === 'none' ? undefined : { shape: s, x: 0.5, y: 0.5, w: s === 'split' || s === 'cinematic-bars' ? 1 : 0.7, h: s === 'split' || s === 'cinematic-bars' ? 1 : 0.7, feather: 0.06, invert: false },
    });
    maskRow.appendChild(b);
  }
  el.appendChild(maskRow);
  if (k.mask) {
    if (k.mask.shape === 'rect' || k.mask.shape === 'ellipse') {
      for (const [pk, lab] of [['w', 'Width'], ['h', 'Height']]) {
        const row = document.createElement('div');
        row.className = 'irow';
        const l = document.createElement('label');
        l.textContent = `Mask ${lab}`;
        const rng = document.createElement('input');
        rng.type = 'range'; rng.min = '0.1'; rng.max = '1'; rng.step = '0.02';
        rng.value = String(k.mask[pk] ?? 0.7);
        const val = document.createElement('span');
        val.style.cssText = 'font-family:var(--mono);font-size:11px;min-width:28px;text-align:right';
        val.textContent = rng.value;
        rng.oninput = () => (val.textContent = rng.value);
        rng.onchange = () => app.mutateClip(i, { mask: { ...k.mask, [pk]: Number(rng.value) } });
        row.append(l, rng, val);
        el.appendChild(row);
      }
    }
    const invRow = document.createElement('div');
    invRow.className = 'irow';
    const invLab = document.createElement('label');
    invLab.textContent = 'Invert mask';
    const inv = document.createElement('input');
    inv.type = 'checkbox';
    inv.checked = !!k.mask.invert;
    inv.style.accentColor = 'var(--accent)';
    inv.onchange = () => app.mutateClip(i, { mask: { ...k.mask, invert: inv.checked } });
    invRow.append(invLab, inv);
    el.appendChild(invRow);
  }

  // actions
  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:4px;margin-top:6px;flex-wrap:wrap';
  const btn = (label, fn, title) => {
    const b = document.createElement('button');
    b.className = 'tbtn';
    b.style.cssText = 'width:auto;padding:2px 10px;font-size:12px';
    b.textContent = label; b.title = title || '';
    b.onclick = fn;
    btns.appendChild(b);
  };
  btn('⧉ Duplicate (D)', () => app.duplicateClip(i));
  btn(k.layout === 'split' ? '▭ Full frame' : '◫ Split screen', () => app.mutateClip(i, { layout: k.layout === 'split' ? undefined : 'split' }));
  btn(k.locked ? '🔓 Unlock' : '🔒 Lock', () => app.mutateClip(i, { locked: !k.locked }));
  btn('🗑 Delete', () => app.deleteClipAt(i));
  el.appendChild(btns);
}

function kv(el, k, v) {
  const d = document.createElement('div');
  d.className = 'irow';
  const key = document.createElement('label');
  key.textContent = k;
  const val = document.createElement('span');
  val.style.cssText = 'font-family:var(--mono);font-size:11.5px';
  val.textContent = v;
  d.append(key, val);
  el.appendChild(d);
  return d;
}
