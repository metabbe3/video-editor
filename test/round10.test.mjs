// Round-10 tests: fixPhonetics, polish math.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixPhonetics } from '../engine/edit-engine.js';
import { LUTS, autoLevelsOffsets, sharpenKernel } from '../src/effects/polish.js';

const W = (w, start, end) => ({ w, start, end });

test('fixPhonetics: brand typos fixed, timestamps untouched', () => {
  const words = [W('epel', 0, 0.4), W('care', 0.4, 0.8), W('magsafe', 1.0, 1.5), W('sofwir', 2.0, 2.4), W('biasa', 3.0, 3.4)];
  const before = words.map((w) => [w.start, w.end]);
  fixPhonetics(words);
  assert.equal(words[0].w, 'Apple');
  assert.equal(words[2].w, 'MagSafe');
  assert.equal(words[3].w, 'software');
  assert.equal(words[4].w, 'biasa'); // non-brand untouched
  assert.deepEqual(words.map((w) => [w.start, w.end]), before); // timestamps identical
});

test('fixPhonetics: case-insensitive match, punctuation-stripped', () => {
  const words = [W('IPhone.', 0, 0.5), W('AppleCare,', 0.6, 1.0)];
  fixPhonetics(words);
  assert.equal(words[0].w, 'iPhone.');
  assert.equal(words[1].w, 'AppleCare,');
});

test('LUT presets exist and none is null', () => {
  assert.equal(LUTS.none, null);
  for (const k of ['crisp', 'warm', 'punch']) assert.ok(typeof LUTS[k] === 'string' && LUTS[k].length > 5);
});

test('autoLevels: dull histogram stretches, wide histogram no-ops', () => {
  // dull: all luminance between 80-180
  const dull = new Uint32Array(256);
  for (let i = 80; i <= 180; i++) dull[i] = 10;
  const a = autoLevelsOffsets(dull, 2560);
  assert.ok(a.contrast > 1, `contrast ${a.contrast}`);
  // wide: full range
  const wide = new Uint32Array(256);
  for (let i = 0; i < 256; i++) wide[i] = 10;
  const b = autoLevelsOffsets(wide, 2560);
  assert.ok(b.contrast <= 1.05 && b.brightness <= 0.02);
});

test('sharpen kernel: center weight scales with amount, sums preserve energy-ish', () => {
  const k0 = sharpenKernel(0.5);
  const k1 = sharpenKernel(1);
  assert.ok(k1[4] > k0[4], `center ${k1[4]} > ${k0[4]}`);
  assert.equal(k1[4], 5); // 1 + 1*4
  // sum = center - 4 (four -1 neighbors)
  assert.equal(k1.reduce((a, b) => a + b, 0), k1[4] - 4);
});
