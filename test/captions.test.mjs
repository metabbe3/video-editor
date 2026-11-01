// Round-7 tests: caption strategy chunking + word-state machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPTION_STYLES, wordStates, chunkWords } from '../src/templates/captions/index.js';
import { buildTimeline } from '../engine/timeline.js';

const W = (w, start, end) => ({ w, start, end });
const words = [
  W('You', 0.0, 0.2), W('will', 0.2, 0.4), W('not', 0.4, 0.6), W('believe', 0.6, 1.0), W('this.', 1.0, 1.3),
  W('Number', 1.5, 1.8), W('one:', 1.8, 2.0), W('the', 2.0, 2.2), W('cost.', 2.2, 2.5),
  W('Second', 2.7, 3.0), W('point.', 3.0, 3.4),
];
const tl = buildTimeline([{ in: 0, out: 4 }], { fps: 30 });

test('wordStates: past/active/future boundaries are ms-exact', () => {
  const line = chunkWords(words, tl, CAPTION_STYLES.hormozi)[0];
  const s = wordStates(line, 0.3);
  assert.equal(s[0].state, 'past');   // 0.3 > 0.2
  assert.equal(s[1].state, 'active'); // 0.2 <= 0.3 <= 0.4+0.05
  assert.equal(s[2].state, 'future'); // "not" starts 0.4 > 0.3
  // at the exact start boundary the word is active
  assert.equal(wordStates(line, 0.0)[0].state, 'active');
});

test('hormozi chunks at 3 words (policy width)', () => {
  const lines = chunkWords(words, tl, CAPTION_STYLES.hormozi);
  assert.ok(lines.every((l) => l.length <= 3));
  assert.ok(lines.length >= 3);
});

test('glass chunks wider (clause-level), clean breaks only on sentence enders', () => {
  const glass = chunkWords(words, tl, CAPTION_STYLES.glass);
  assert.ok(glass.every((l) => l.length <= 7));
  const clean = chunkWords(words, tl, CAPTION_STYLES.clean);
  // sentence style: line ends at a word ending with . ! ? — mid-clause commas do NOT break
  for (const l of clean) {
    if (l.length < CAPTION_STYLES.clean.wordsPerLine) assert.ok(/[.!?…]$/.test(l[l.length - 1].text));
  }
});

test('pop strategy shows one word at a time (policy width 1)', () => {
  const pop = chunkWords(words, tl, CAPTION_STYLES.pop);
  assert.ok(pop.every((l) => l.length === 1));
});

test('caption words carry original indices (keyword matching)', () => {
  const line = chunkWords(words, tl, CAPTION_STYLES.hormozi)[0];
  assert.ok(line[0].i === 0 && Number.isFinite(line[0].start) && Number.isFinite(line[0].end));
});
