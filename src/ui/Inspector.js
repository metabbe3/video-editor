// Inspector — right panel, OpenCut properties-panel pattern: shows the
// selected clip's properties (speed/freeze in Phase 4, effects/mask in 5),
// or project properties when nothing is selected.

import { timelineOf } from '../core/Compositor.js';
import { CAPTION_LABELS } from './labels.js';
import { EFFECTS, clampParams } from '../effects/clipfx.js';
import { nextRotate, SPEED_CURVE_PRESETS } from '../../engine/clip-ops.js';
import {
  evalClipKeyframes, setKeyframe, removeKeyframe, findKeyframeNear, DEFAULT_KEYFRAME_VALUES,
} from '../../engine/keyframes.js';

const $ = (id) => document.getElementById(id);

export function renderInspector(app) {
  const el = $('inspector');
  const p = app.project;
  if (p.edl && app.selectedClipIndex != null && !p.edl.keep[app.selectedClipIndex]) app.selectedClipIndex = null;
  el.textContent = '';
  const head = document.createElement('div');
  head.className = 'ihead';
  el.appendChild(head);

  // 1. Overlay inspector when an overlay is selected
  if (app.selectedOverlayIndex != null && p.overlays?.[app.selectedOverlayIndex]) {
    const oi = app.selectedOverlayIndex;
    const o = p.overlays[oi];
    head.textContent = `Inspector — Overlay (${o.type})`;
    const x = document.createElement('span');
    x.textContent = '✕';
    x.style.cssText = 'margin-left:auto;cursor:pointer;color:var(--ink-2)';
    x.onclick = () => { app.selectedOverlayIndex = null; renderInspector(app); };
    head.appendChild(x);

    // Text content
    if (o.type === 'text') {
      const txtRow = document.createElement('div');
      txtRow.className = 'irow';
      const txtLab = document.createElement('label');
      txtLab.textContent = 'Text';
      const txtIn = document.createElement('input');
      txtIn.type = 'text';
      txtIn.value = o.text || '';
      txtIn.style.cssText = 'flex:1;background:var(--bg-raise);color:var(--ink);border:1px solid var(--border-soft);padding:3px 6px;border-radius:4px';
      txtIn.oninput = () => app.updateOverlay(oi, { text: txtIn.value }, { quiet: true });
      txtRow.append(txtLab, txtIn);
      el.appendChild(txtRow);

      // Font size
      const fsRow = document.createElement('div');
      fsRow.className = 'irow';
      const fsLab = document.createElement('label');
      fsLab.textContent = 'Font size';
      const fsRng = document.createElement('input');
      fsRng.type = 'range'; fsRng.min = '16'; fsRng.max = '96'; fsRng.step = '2';
      fsRng.value = String(o.fontSize || 38);
      const fsVal = document.createElement('span');
      fsVal.style.cssText = 'font-family:var(--mono);font-size:11px;min-width:32px;text-align:right';
      fsVal.textContent = `${fsRng.value}px`;
      fsRng.oninput = () => {
        fsVal.textContent = `${fsRng.value}px`;
        app.updateOverlay(oi, { fontSize: Number(fsRng.value) }, { quiet: true });
      };
      fsRow.append(fsLab, fsRng, fsVal);
      el.appendChild(fsRow);

      // Color & Stroke
      const colRow = document.createElement('div');
      colRow.className = 'irow';
      const cLab = document.createElement('label');
      cLab.textContent = 'Color';
      const cIn = document.createElement('input');
      cIn.type = 'color';
      cIn.value = o.color || '#ffffff';
      cIn.onchange = () => app.updateOverlay(oi, { color: cIn.value });
      const sLab = document.createElement('label');
      sLab.textContent = 'Stroke';
      const sIn = document.createElement('input');
      sIn.type = 'color';
      sIn.value = o.stroke || '#000000';
      sIn.onchange = () => app.updateOverlay(oi, { stroke: sIn.value });
      colRow.append(cLab, cIn, sLab, sIn);
      el.appendChild(colRow);
    } else {
      // Sticker emoji or shape
      kv(el, 'Sticker', o.char || o.shape || 'Sticker');
    }

    // Animation in/out
    const animRow = document.createElement('div');
    animRow.className = 'irow';
    const inLab = document.createElement('label');
    inLab.textContent = 'In:';
    const inSel = document.createElement('select');
    inSel.style.cssText = 'background:var(--bg-raise);color:var(--ink);border:1px solid var(--border-soft);border-radius:4px;font-size:11px;padding:2px 4px';
    for (const a of ['pop', 'fade', 'slide']) {
      const opt = document.createElement('option');
      opt.value = a; opt.textContent = a;
      if ((o.animIn || 'pop') === a) opt.selected = true;
      inSel.appendChild(opt);
    }
    inSel.onchange = () => app.updateOverlay(oi, { animIn: inSel.value });

    const outLab = document.createElement('label');
    outLab.textContent = 'Out:';
    const outSel = document.createElement('select');
    outSel.style.cssText = 'background:var(--bg-raise);color:var(--ink);border:1px solid var(--border-soft);border-radius:4px;font-size:11px;padding:2px 4px';
    for (const a of ['none', 'fade', 'pop', 'slide']) {
      const opt = document.createElement('option');
      opt.value = a; opt.textContent = a;
      if ((o.animOut || 'fade') === a) opt.selected = true;
      outSel.appendChild(opt);
    }
    outSel.onchange = () => app.updateOverlay(oi, { animOut: outSel.value });
    animRow.append(inLab, inSel, outLab, outSel);
    el.appendChild(animRow);

    // Blend mode
    const blendRow = document.createElement('div');
    blendRow.className = 'irow';
    const blendLab = document.createElement('label');
    blendLab.textContent = 'Blend mode';
    const blendSel = document.createElement('select');
    blendSel.style.cssText = 'background:var(--bg-raise);color:var(--ink);border:1px solid var(--border-soft);border-radius:4px;font-size:11px;padding:2px 4px';
    for (const bm of ['normal', 'multiply', 'screen', 'overlay', 'soft-light']) {
      const opt = document.createElement('option');
      opt.value = bm; opt.textContent = bm;
      if ((o.blendMode || 'normal') === bm) opt.selected = true;
      blendSel.appendChild(opt);
    }
    blendSel.onchange = () => app.updateOverlay(oi, { blendMode: blendSel.value === 'normal' ? undefined : blendSel.value });
    blendRow.append(blendLab, blendSel);
    el.appendChild(blendRow);

    // Delete overlay button
    const delBtn = document.createElement('button');
    delBtn.className = 'tbtn';
    delBtn.style.cssText = 'width:auto;margin-top:8px;padding:3px 12px;font-size:11.5px;color:var(--danger)';
    delBtn.textContent = '🗑 Delete overlay';
    delBtn.onclick = () => {
      app.removeOverlay(oi);
      app.selectedOverlayIndex = null;
      renderInspector(app);
    };
    el.appendChild(delBtn);
    return;
  }

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

  // 📈 Speed curve / ramp
  const curveRow = document.createElement('div');
  curveRow.className = 'irow';
  curveRow.style.flexWrap = 'wrap';
  const curveLab = document.createElement('span');
  curveLab.textContent = 'Curve:';
  curveLab.style.cssText = 'font-size:11px;color:var(--ink-2);margin-right:4px';
  curveRow.appendChild(curveLab);
  const curves = [
    ['Off', null],
    ['Hero', SPEED_CURVE_PRESETS.hero],
    ['Ramp In', SPEED_CURVE_PRESETS.rampIn],
    ['Ramp Out', SPEED_CURVE_PRESETS.rampOut],
    ['Montage', SPEED_CURVE_PRESETS.montage],
  ];
  for (const [name, pts] of curves) {
    const isCur = (!pts && !k.speedCurve) || (pts && JSON.stringify(k.speedCurve) === JSON.stringify(pts));
    const b = document.createElement('button');
    b.className = 'tbtn';
    b.style.cssText = `width:auto;padding:1px 7px;font-size:11px${isCur ? ';background:var(--accent);color:#fff;border-color:var(--accent)' : ''}`;
    b.textContent = name;
    b.onclick = () => app.mutateClip(i, { speedCurve: pts || undefined });
    curveRow.appendChild(b);
  }
  const isCustom = k.speedCurve && !Object.values(SPEED_CURVE_PRESETS).some((p) => JSON.stringify(p) === JSON.stringify(k.speedCurve));
  const customBtn = document.createElement('button');
  customBtn.className = 'tbtn';
  customBtn.style.cssText = `width:auto;padding:1px 7px;font-size:11px${isCustom ? ';background:var(--accent);color:#fff;border-color:var(--accent)' : ''}`;
  customBtn.textContent = 'Custom';
  customBtn.onclick = () => {
    const pts = k.speedCurve || [
      { t: 0, v: 1.0 },
      { t: 0.35, v: 2.0 },
      { t: 0.65, v: 0.5 },
      { t: 1.0, v: 1.0 },
    ];
    app.mutateClip(i, { speedCurve: pts });
  };
  curveRow.appendChild(customBtn);
  el.appendChild(curveRow);

  // If a speed curve is active, render interactive graph editor canvas
  if (k.speedCurve && k.speedCurve.length >= 2) {
    const graphBox = document.createElement('div');
    graphBox.style.cssText = 'padding:2px 0 6px 0';
    renderSpeedGraphCanvas(graphBox, k, (newPts) => {
      app.mutateClip(i, { speedCurve: newPts });
    });
    el.appendChild(graphBox);
  }

  // ↻ Rotate & ⇄ Flip
  const orientRow = document.createElement('div');
  orientRow.className = 'irow';
  const rotBtn = document.createElement('button');
  rotBtn.className = 'tbtn';
  rotBtn.style.cssText = 'width:auto;padding:2px 9px;font-size:11.5px';
  rotBtn.textContent = k.rotate ? `↻ Rotate ${k.rotate}°` : '↻ Rotate 90°';
  rotBtn.onclick = () => app.mutateClip(i, { rotate: nextRotate(k.rotate) });
  const flipBtn = document.createElement('button');
  flipBtn.className = 'tbtn';
  flipBtn.style.cssText = `width:auto;padding:2px 9px;font-size:11.5px${k.flipH ? ';background:var(--accent);color:#fff;border-color:var(--accent)' : ''}`;
  flipBtn.textContent = k.flipH ? '⇄ Mirror H (on)' : '⇄ Mirror H';
  flipBtn.onclick = () => app.mutateClip(i, { flipH: k.flipH ? undefined : true });
  orientRow.append(rotBtn, flipBtn);

  // ✂️ Free Crop
  const isCropping = app.cropModeClipIndex === i;
  const cropBtn = document.createElement('button');
  cropBtn.className = 'tbtn';
  cropBtn.style.cssText = `width:auto;padding:2px 9px;font-size:11.5px${isCropping ? ';background:var(--accent);color:#fff;border-color:var(--accent)' : ''}`;
  cropBtn.textContent = isCropping ? '📐 Done crop' : '📐 Crop';
  cropBtn.title = 'Drag on the player to crop rectangle';
  cropBtn.onclick = () => app.toggleCropMode(i);
  orientRow.appendChild(cropBtn);
  if (k.cropRect) {
    const rstCrop = document.createElement('button');
    rstCrop.className = 'tbtn';
    rstCrop.style.cssText = 'width:auto;padding:2px 7px;font-size:11px;color:var(--danger)';
    rstCrop.textContent = '✕ Reset crop';
    rstCrop.onclick = () => {
      app.mutateClip(i, { cropRect: undefined });
      if (app.cropModeClipIndex === i) app.toggleCropMode(i);
    };
    orientRow.appendChild(rstCrop);
  }
  el.appendChild(orientRow);

  // 🔊 Audio fade in/out
  const fadeRow = document.createElement('div');
  fadeRow.className = 'irow';
  fadeRow.style.gap = '8px';
  const inCol = document.createElement('div');
  inCol.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:2px';
  const inLab = document.createElement('label');
  inLab.style.fontSize = '10.5px';
  inLab.textContent = `Fade in: ${k.fadeIn || 0}ms`;
  const inRng = document.createElement('input');
  inRng.type = 'range'; inRng.min = '0'; inRng.max = '2000'; inRng.step = '50';
  inRng.value = String(k.fadeIn || 0);
  inRng.oninput = () => { inLab.textContent = `Fade in: ${inRng.value}ms`; };
  inRng.onchange = () => app.mutateClip(i, { fadeIn: Number(inRng.value) || undefined });
  inCol.append(inLab, inRng);

  const outCol = document.createElement('div');
  outCol.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:2px';
  const outLab = document.createElement('label');
  outLab.style.fontSize = '10.5px';
  outLab.textContent = `Fade out: ${k.fadeOut || 0}ms`;
  const outRng = document.createElement('input');
  outRng.type = 'range'; outRng.min = '0'; outRng.max = '2000'; outRng.step = '50';
  outRng.value = String(k.fadeOut || 0);
  outRng.oninput = () => { outLab.textContent = `Fade out: ${outRng.value}ms`; };
  outRng.onchange = () => app.mutateClip(i, { fadeOut: Number(outRng.value) || undefined });
  outCol.append(outLab, outRng);

  fadeRow.append(inCol, outCol);
  el.appendChild(fadeRow);

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

  // 🎨 Blend mode
  const blendRow = document.createElement('div');
  blendRow.className = 'irow';
  const blendLab = document.createElement('label');
  blendLab.textContent = '🎨 Blend mode';
  const blendSel = document.createElement('select');
  blendSel.style.cssText = 'background:var(--bg-raise);color:var(--ink);border:1px solid var(--border-soft);border-radius:4px;font-size:11px;padding:2px 6px';
  for (const bm of ['normal', 'multiply', 'screen', 'overlay', 'soft-light']) {
    const opt = document.createElement('option');
    opt.value = bm; opt.textContent = bm;
    if ((k.blendMode || 'normal') === bm) opt.selected = true;
    blendSel.appendChild(opt);
  }
  blendSel.onchange = () => app.mutateClip(i, { blendMode: blendSel.value === 'normal' ? undefined : blendSel.value });
  blendRow.append(blendLab, blendSel);
  el.appendChild(blendRow);

  // ◆ Keyframes manual
  const kfSection = document.createElement('div');
  kfSection.style.cssText = 'margin-top:6px;border-top:1px solid var(--border-soft);padding-top:6px';
  const kfHead = document.createElement('div');
  kfHead.style.cssText = 'font-size:11px;font-weight:600;color:var(--ink-2);margin-bottom:4px;display:flex;align-items:center;justify-content:space-between';
  kfHead.textContent = '◆ Keyframes (at playhead)';
  kfSection.appendChild(kfHead);

  const playheadT = app.preview?.editedTime() ?? 0;
  const segStart = tl.starts[i] ?? 0;
  const segLocalT = Math.max(0, playheadT - segStart);
  const segProg = seg?.dur > 0 ? Math.max(0, Math.min(1, segLocalT / seg.dur)) : 0;
  const kfVals = evalClipKeyframes(k.keyframes, segProg);

  const propConfigs = [
    { key: 'scale', label: 'Scale', min: 0.5, max: 2.5, step: 0.05, unit: '×', def: 1.0 },
    { key: 'x', label: 'Pos X', min: -0.8, max: 0.8, step: 0.02, unit: '', def: 0.0 },
    { key: 'y', label: 'Pos Y', min: -0.8, max: 0.8, step: 0.02, unit: '', def: 0.0 },
    { key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.05, unit: '', def: 1.0 },
  ];

  for (const cfg of propConfigs) {
    const row = document.createElement('div');
    row.className = 'irow';
    const lab = document.createElement('label');
    lab.textContent = cfg.label;

    const rng = document.createElement('input');
    rng.type = 'range'; rng.min = String(cfg.min); rng.max = String(cfg.max); rng.step = String(cfg.step);
    const curVal = kfVals[cfg.key] ?? cfg.def;
    rng.value = String(curVal);

    const valSpan = document.createElement('span');
    valSpan.style.cssText = 'font-family:var(--mono);font-size:11px;min-width:32px;text-align:right';
    valSpan.textContent = `${Number(curVal).toFixed(2)}${cfg.unit}`;

    // ◆ Button
    const track = k.keyframes?.[cfg.key] || [];
    const hasKf = findKeyframeNear(track, segProg, 0.03);
    const kfBtn = document.createElement('button');
    kfBtn.className = 'tbtn';
    kfBtn.style.cssText = `width:22px;height:22px;padding:0;font-size:11px;display:flex;align-items:center;justify-content:center;${hasKf ? 'background:#f59e0b;color:#000;border-color:#f59e0b' : 'color:var(--ink-2)'}`;
    kfBtn.textContent = '◆';
    kfBtn.title = hasKf ? 'Click to delete keyframe at playhead' : 'Click to add keyframe at playhead';

    kfBtn.onclick = () => {
      const nextKfs = { ...(k.keyframes || {}) };
      let curTrack = [...(nextKfs[cfg.key] || [])];
      if (hasKf) {
        curTrack = removeKeyframe(curTrack, segProg);
      } else {
        curTrack = setKeyframe(curTrack, segProg, Number(rng.value), 'ease');
      }
      nextKfs[cfg.key] = curTrack;
      app.mutateClip(i, { keyframes: nextKfs });
    };

    rng.oninput = () => {
      valSpan.textContent = `${Number(rng.value).toFixed(2)}${cfg.unit}`;
    };
    rng.onchange = () => {
      const nextKfs = { ...(k.keyframes || {}) };
      const curTrack = setKeyframe(nextKfs[cfg.key] || [], segProg, Number(rng.value), 'ease');
      nextKfs[cfg.key] = curTrack;
      app.mutateClip(i, { keyframes: nextKfs });
    };

    row.append(lab, rng, valSpan, kfBtn);
    kfSection.appendChild(row);
  }
  el.appendChild(kfSection);

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

export function renderSpeedGraphCanvas(container, clip, onUpdate) {
  const pts = (clip.speedCurve && clip.speedCurve.length >= 2)
    ? clip.speedCurve.map((p) => ({ ...p }))
    : [
        { t: 0, v: 1.0 },
        { t: 0.35, v: 2.0 },
        { t: 0.65, v: 0.6 },
        { t: 1.0, v: 1.0 },
      ];
  const cv = document.createElement('canvas');
  cv.width = 200; cv.height = 70;
  cv.style.cssText = 'width:100%;height:70px;background:var(--bg-raise);border:1px solid var(--border-soft);border-radius:4px;margin-top:4px;cursor:crosshair';
  container.appendChild(cv);
  const ctx = cv.getContext('2d');

  const pad = 12;
  const W = cv.width - pad * 2;
  const H = cv.height - pad * 2;

  const toX = (t) => pad + t * W;
  const toY = (v) => pad + (1 - (v - 0.25) / (4.0 - 0.25)) * H;
  const fromX = (x) => Math.max(0, Math.min(1, (x - pad) / W));
  const fromY = (y) => Math.max(0.25, Math.min(4.0, 0.25 + (1 - (y - pad) / H) * 3.75));

  function draw() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    // Grid line for 1.0x normal speed
    const y1 = toY(1.0);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(pad, y1); ctx.lineTo(pad + W, y1); ctx.stroke();
    ctx.setLineDash([]);

    // Curve line
    ctx.strokeStyle = '#1f6feb';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let j = 0; j < pts.length; j++) {
      const px = toX(pts[j].t), py = toY(pts[j].v);
      if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Handles
    for (let j = 0; j < pts.length; j++) {
      const px = toX(pts[j].t), py = toY(pts[j].v);
      ctx.fillStyle = '#f59e0b';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(px, py, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }

  draw();

  let activePt = -1;
  cv.addEventListener('pointerdown', (e) => {
    const rect = cv.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (cv.width / rect.width);
    const cy = (e.clientY - rect.top) * (cv.height / rect.height);
    activePt = -1;
    for (let j = 0; j < pts.length; j++) {
      if (Math.hypot(cx - toX(pts[j].t), cy - toY(pts[j].v)) <= 10) {
        activePt = j;
        cv.setPointerCapture(e.pointerId);
        break;
      }
    }
  });

  cv.addEventListener('pointermove', (e) => {
    if (activePt < 0) return;
    const rect = cv.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (cv.width / rect.width);
    const cy = (e.clientY - rect.top) * (cv.height / rect.height);
    if (activePt > 0 && activePt < pts.length - 1) {
      pts[activePt].t = +fromX(cx).toFixed(3);
    }
    pts[activePt].v = +fromY(cy).toFixed(2);
    pts.sort((a, b) => a.t - b.t);
    draw();
  });

  const onUp = () => {
    if (activePt >= 0) {
      activePt = -1;
      onUpdate(pts);
    }
  };
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointercancel', onUp);
}
