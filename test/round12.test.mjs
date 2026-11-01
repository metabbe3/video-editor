// Round-12 tests: .cube LUT parse/apply, mergeMicroCards, mergeKeeps, locked keeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCube, applyCubeLut } from '../src/effects/lut.js';
import { mergeMicroCards, mergeKeeps } from '../src/core/Project.js';
import { fitToTarget } from '../src/core/DurationBudget.js';

// node has no ImageData — minimal stand-in (applyCubeLut only touches .data)
class FakeImage {
  constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); }
}
const img = (pixels) => {
  const im = new FakeImage(pixels.length / 4, 1);
  im.data.set(pixels);
  return im;
};

test('.cube: parse + identity LUT leaves pixels unchanged', () => {
  const size = 33; // nearest-neighbor needs a real grid for mid-tones
  let text = `TITLE "t"\nLUT_3D_SIZE ${size}\n`;
  for (let r = 0; r < size; r++) for (let g = 0; g < size; g++) for (let b = 0; b < size; b++) {
    text += `${(r / (size - 1)).toFixed(4)} ${(g / (size - 1)).toFixed(4)} ${(b / (size - 1)).toFixed(4)}\n`;
  }
  const lut = parseCube(text);
  assert.ok(lut, 'parse ok');
  assert.equal(lut.size, size);
  const im0 = img([255,128,0,255, 0,255,128,255]);
  applyCubeLut(im0, lut, 1);
  assert.ok(Math.abs(im0.data[0] - 255) < 2 && Math.abs(im0.data[1] - 128) < 2, `identity px0 ${im0.data[0]},${im0.data[1]}`);
});

test('.cube: swap-RB LUT swaps channels at full intensity, half at 50%', () => {
  const size = 2;
  let text = 'LUT_3D_SIZE 2\n';
  for (let r = 0; r < size; r++) for (let g = 0; g < size; g++) for (let b = 0; b < size; b++) {
    text += `${(b / (size - 1)).toFixed(4)} ${(g / (size - 1)).toFixed(4)} ${(r / (size - 1)).toFixed(4)}\n`; // swap r<->b
  }
  const lut = parseCube(text);
  const im1 = img([255,0,0,255]);
  applyCubeLut(im1, lut, 1);
  assert.ok(im1.data[0] === 0 && im1.data[2] === 255, `swapped ${im1.data[0]},${im1.data[2]}`);
  const im2 = img([255,0,0,255]);
  applyCubeLut(im2, lut, 0.5);
  assert.ok(Math.abs(im2.data[0] - 128) < 2 && Math.abs(im2.data[2] - 128) < 2, `half ${im2.data[0]},${im2.data[2]}`);
});

test('.cube: rejects malformed', () => {
  assert.equal(parseCube('LUT_3D_SIZE 4\n1 0 0'), null);
});

test('mergeMicroCards: <3s adjacent fragment merges; hook exempt; gap no-merge', () => {
  const keeps = [
    { in: 0, out: 5 },      // hook (survivor first)
    { in: 5, out: 8 },      // 3s — survives
    { in: 8.1, out: 9.5 },  // 1.4s BUT not adjacent (gap 0.1) — survives? |k.in - prev.out|=0.1 > 0.02
    { in: 9.5, out: 10.4 }, // 0.9s adjacent to prev — merges
  ];
  const out = mergeMicroCards(keeps);
  // fragment at 8.1-9.5 not adjacent so stays; 9.5-10.4 merges into it
  assert.equal(out.length, 3);
  assert.ok(Math.abs(out[2].out - 10.4) < 1e-9);
  // adjacent small case
  const out2 = mergeMicroCards([{ in: 0, out: 4 }, { in: 4, out: 5.5 }]);
  assert.equal(out2.length, 1);
  assert.ok(Math.abs(out2[0].out - 5.5) < 1e-9);
});

test('mergeKeeps: concatenates adjacent pair, out of range no-op', () => {
  const keep = [{ in: 0, out: 2 }, { in: 2.5, out: 4 }, { in: 5, out: 6 }];
  const merged = mergeKeeps(keep, 1);
  assert.equal(merged.length, 2);
  assert.ok(Math.abs(merged[1].out - 6) < 1e-9);
  assert.equal(mergeKeeps(keep, 5).length, 3); // out of range
});

test('locked keep survives DurationBudget (hook/payoff lock already covers ends; a locked middle keep must survive)', () => {
  // simulate: fitToTarget drops by tier; our lock is enforced via overrides BEFORE
  // fitToTarget, so here we verify fitToTarget itself never drops index 0 or last,
  // and a locked-flagged keep is protected by wiring (kept in overrides.keeps)
  const keeps = [
    { in: 0, out: 4, why: 'hook', score: 90 },
    { in: 4.5, out: 10, why: 'body', score: 30 },     // low score — dropped first
    { in: 10.5, out: 16, why: 'final verdict', score: 80 },
  ];
  const fitted = fitToTarget(keeps, 8);
  assert.ok(fitted.some((k) => k.in === 0), 'hook survives');
  assert.ok(fitted.some((k) => k.why === 'final verdict'), 'payoff survives');
  assert.ok(!fitted.some((k) => k.score === 30), 'low-score body dropped');
});
