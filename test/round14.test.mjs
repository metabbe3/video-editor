// Round-14 tests: OpenCut port — retime (speed/freeze) timeline math + QaGate + clipfx.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline } from '../engine/timeline.js';
import { transitionsFor } from '../engine/edit-engine.js';
import { checkEdl } from '../src/core/QaGate.js';
import { EFFECTS, MASK_SHAPES, clampParams, maskGeometry, hasClipFx } from '../src/effects/clipfx.js';
import { overlayHit } from '../src/elements/OverlayElement.js';
import { parseSrt, parseStamp, toSrt } from '../engine/srt.js';
import { renderSfx, SFX_PRESETS } from '../src/core/AudioMix.js';

const base = { fps: 30 };
const keep = [
  { in: 0, out: 4 },            // 4s at 1x
  { in: 6, out: 10, speed: 2 }, // 4s source -> 2s edited (gap 2s > minRemoved)
  { in: 12, out: 14, speed: 0.5, freeze: 1 }, // 2s source -> 4s + 1s freeze = 5s
];

test('buildTimeline: speed compresses, freeze extends, starts accumulate', () => {
  const tl = buildTimeline(keep, base);
  assert.equal(tl.segments[0].dur, 4);
  assert.equal(tl.segments[1].dur, 2);          // 4s at 2x
  assert.equal(tl.segments[2].dur, 5);          // 2s at 0.5x + 1s freeze
  assert.deepEqual(tl.starts, [0, 4, 6]);
  assert.equal(tl.duration, 11);
});

test('buildTimeline: byte-identical when speed/freeze absent', () => {
  const plain = [{ in: 0, out: 3 }, { in: 4, out: 8 }];
  const tl = buildTimeline(plain, base);
  assert.deepEqual(tl.starts, [0, 3]);
  assert.equal(tl.duration, 7);
  assert.equal(tl.editedToSource(1.5).src, 1.5); // old passthrough behavior
  assert.equal(tl.editedToSource(1.5).frozen, undefined);
  assert.equal(tl.sourceToEdited(6), 5);
});

test('editedToSource: rate mapping + frozen flag in the freeze tail', () => {
  const tl = buildTimeline(keep, base);
  // seg1 starts at 4 (edited), covers src 6..10 at rate 2 -> local 1s -> src 8
  assert.equal(tl.editedToSource(4 + 1).src, 8);
  // seg2 starts at 6, playLen = 2/0.5 = 4s -> local 2s -> src 12 + 2*0.5 = 13
  assert.equal(tl.editedToSource(6 + 2).src, 13);
  // local 4.5s is inside the freeze tail -> out frame, frozen
  const m = tl.editedToSource(6 + 4.5);
  assert.equal(m.src, 14);
  assert.equal(m.frozen, true);
});

test('editedToSource/sourceToEdited round-trip at speed', () => {
  const tl = buildTimeline(keep, base);
  for (const src of [6.5, 7, 8.25, 9.9, 12.5, 13.5]) {
    const e = tl.sourceToEdited(src);
    const back = tl.editedToSource(e);
    assert.ok(Math.abs(back.src - src) < 1e-9, `${src} -> ${e} -> ${back.src}`);
    assert.notEqual(back.frozen, true);
  }
  // the freeze tail (edited 10..11] maps from no source time
  assert.ok(tl.sourceToEdited(14) <= 10);
});

test('transitionsFor: joins land at speed+freeze-aware edited times', () => {
  const t = transitionsFor(keep);
  assert.equal(t.length, 2);
  assert.equal(t[0].at, 4); // after seg0
  assert.equal(t[1].at, 6); // after seg1 (2s edited)
});

test('QaGate: speed/freeze blockers and warnings', () => {
  const edl = (speed, freeze) => ({
    style: { fps: 30, w: 1080, h: 1920, captionsMode: 'off' },
    keep: [{ in: 0, out: 2, ...(speed != null && { speed }), ...(freeze != null && { freeze }) }],
  });
  assert.ok(checkEdl(edl(9, undefined)).blockers.length >= 1);   // speed out of range
  assert.ok(checkEdl(edl(0.1, undefined)).blockers.length >= 1); // too slow
  assert.ok(checkEdl(edl(1, 30)).blockers.length >= 1);          // freeze too long
  assert.equal(checkEdl(edl(1, undefined)).blockers.length, 0);  // clean
  const w = checkEdl(edl(2, 4)).warnings;
  assert.ok(w.some((x) => x.includes('pitch')));
  assert.ok(w.some((x) => x.includes('freeze')));
});

test('clipfx: registry shape — every effect has filter or overlay, params carry min/max/def', () => {
  for (const [id, def] of Object.entries(EFFECTS)) {
    assert.ok(def.filter || def.overlay, `${id} needs filter or overlay`);
    assert.ok(!def.filter || !def.overlay, `${id} should not have both`);
    assert.ok(def.label);
    for (const [k, s] of Object.entries(def.params)) {
      assert.ok(s.min < s.max && s.def >= s.min && s.def <= s.max, `${id}.${k} schema`);
    }
  }
  assert.ok(MASK_SHAPES.includes('split') && MASK_SHAPES.includes('cinematic-bars'));
});

test('clipfx: clampParams clamps and fills defaults', () => {
  assert.deepEqual(clampParams('blur', { amount: 999 }), { amount: 40 });
  assert.deepEqual(clampParams('blur', { amount: -5 }), { amount: 0 });
  assert.deepEqual(clampParams('blur', {}), { amount: 12 });
  assert.deepEqual(clampParams('vignette', 'junk'), { strength: 0.5 });
  assert.deepEqual(clampParams('nope', { x: 1 }), {});
});

test('clipfx: maskGeometry numbers for all shapes', () => {
  const w = 1000, h = 2000;
  const rect = maskGeometry('rect', { x: 0.5, y: 0.5, w: 0.7, h: 0.7 }, w, h);
  assert.deepEqual(rect.rects[0], { x: 150, y: 300, w: 700, h: 1400 });
  const ell = maskGeometry('ellipse', { w: 0.5, h: 0.5 }, w, h);
  assert.deepEqual(ell.ellipse, { cx: 500, cy: 1000, rx: 250, ry: 500 });
  const bars = maskGeometry('cinematic-bars', {}, w, h);
  assert.ok(bars.drawOnly && bars.rects.length === 2);
  assert.equal(bars.rects[0].h, 220); // 11% bars
  const split = maskGeometry('split', {}, w, h);
  assert.deepEqual(split.rects[0], { x: 500, y: 0, w: 500, h: 2000 }); // right half
  // defaults: full-frame rect when no params
  assert.deepEqual(maskGeometry('rect', {}, w, h).rects[0], { x: 0, y: 0, w: 1000, h: 2000 });
});

test('clipfx: hasClipFx truth table', () => {
  assert.equal(hasClipFx(null), false);
  assert.equal(hasClipFx({}), false);
  assert.equal(hasClipFx({ effects: [] }), false);
  assert.equal(hasClipFx({ effects: [{ id: 'blur' }] }), true);
  assert.equal(hasClipFx({ effects: [{ id: 'blur', on: false }] }), false);
  assert.equal(hasClipFx({ effects: [{ id: 'ghost', on: true }] }), false); // unknown id
  assert.equal(hasClipFx({ mask: { shape: 'rect' } }), true);
});

test('overlayHit: topmost active overlay wins, inactive windows ignored', () => {
  const ovs = [
    { type: 'text', text: 'HEY', t0: 0, t1: 2, x: 0.5, y: 0.3, size: 1 },
    { type: 'sticker', char: '🔥', t0: 1, t1: 3, x: 0.5, y: 0.32, size: 1 },
    { type: 'sticker', char: '💀', t0: 5, t1: 8, x: 0.5, y: 0.3, size: 1 },
  ];
  assert.equal(overlayHit(ovs, 0.5, 0.31, 0.5), 0);   // only the first is active
  assert.equal(overlayHit(ovs, 0.5, 0.31, 2.5), 1);   // topmost of two active
  assert.equal(overlayHit(ovs, 0.5, 0.3, 6), 2);
  assert.equal(overlayHit(ovs, 0.5, 0.3, 4), null);   // nothing active
  assert.equal(overlayHit(ovs, 0.1, 0.1, 0.5), null); // far away
});

test('srt: parse round-trips through toSrt', () => {
  const cues = parseSrt('1\n00:00:01,500 --> 00:00:03,000\nHello world\n\n2\n00:00:04,250 --> 00:00:05,750\nSecond cue\nspans lines\n');
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 1.5, end: 3, text: 'Hello world' });
  assert.equal(cues[1].text, 'Second cue spans lines');
  // stamps survive a round trip
  const out = toSrt(cues.map((c) => ({ t0: c.start, t1: c.end, text: c.text })));
  const back = parseSrt(out);
  assert.equal(back.length, 2);
  assert.ok(Math.abs(back[0].start - 1.5) < 1e-9 && Math.abs(back[0].end - 3) < 1e-9);
  assert.equal(back[1].text, 'Second cue spans lines');
});

test('srt: tolerates junk, BOM, dot-ms, missing indexes', () => {
  assert.deepEqual(parseSrt(''), []);
  assert.deepEqual(parseSrt('garbage\nno timestamps'), []);
  const c = parseSrt('﻿0:00:00.100 --> 0:00:01.900\nok');
  assert.equal(c.length, 1);
  assert.ok(Math.abs(c[0].start - 0.1) < 1e-9);
  assert.deepEqual(parseStamp('nonsense'), null);
});

test('sfx library: every preset renders a finite non-silent buffer', () => {
  for (const kind of SFX_PRESETS) {
    const buf = renderSfx(kind, 48000, -6);
    assert.ok(buf.length > 100, `${kind} too short`);
    let peak = 0, bad = 0;
    for (const v of buf) { peak = Math.max(peak, Math.abs(v)); if (!Number.isFinite(v)) bad++; }
    assert.equal(bad, 0, `${kind} has NaNs`);
    assert.ok(peak > 0.001, `${kind} is silent`);
  }
});
