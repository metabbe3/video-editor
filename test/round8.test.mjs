// Round-8 tests: ScoreEngine, DurationBudget, TakeStacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/core/ScoreEngine.js';
import { fitToTarget } from '../src/core/DurationBudget.js';
import { groupTakes, cutsForSelection } from '../src/core/TakeStacks.js';
import { buildTimeline } from '../engine/timeline.js';

const W = (w, start, end) => ({ w, start, end });
const words = [
  W('Hey', 0.0, 0.3), W('guys', 0.3, 0.6), W('so', 0.6, 0.8), W('today', 0.8, 1.1), W('latency.', 1.1, 1.6),
  ...Array.from({ length: 60 }, (_, i) => W(`w${i}`, 1.6 + i * 0.32, 1.6 + i * 0.32 + 0.26)),
  W('That', 21.0, 21.3), W('is', 21.3, 21.5), W('the', 21.5, 21.7), W('verdict.', 21.7, 22.0),
];
const wordsFrozen = words.map((w, i) => ({ ...w, i }));

const edl = {
  style: { fps: 30, w: 1080, h: 1920, captionsMode: 'word-pop' },
  keep: [{ in: 0, out: 8, why: 'glm: hook', score: 88 }, { in: 8.2, out: 15, why: 'glm: body', score: 70 }, { in: 15.2, out: 22, why: 'glm: final verdict', score: 75 }],
  punches: [{ at: 8.2, scale: 1.1, ms: 400, kind: 'cut' }, { at: 15.2, scale: 1.15, ms: 400, kind: 'cut' }],
  broll: [], steps: [], words: wordsFrozen,
};
const tl = buildTimeline(edl.keep, { fps: 30 });

test('ScoreEngine: filler opener is penalized but GLM score still counts', () => {
  const s = evaluate(edl, tl, wordsFrozen, { platform: 'shorts' });
  assert.ok(s.hook <= 45, `filler hook should be <= 45, got ${s.hook}`);
  const clean = evaluate({ ...edl, keep: edl.keep.map((k, i) => (i === 0 ? { ...k, in: 1.6 } : k)) }, buildTimeline(edl.keep.map((k, i) => (i === 0 ? { ...k, in: 1.6 } : k)), { fps: 30 }), wordsFrozen, { platform: 'shorts' });
  assert.ok(clean.hook > s.hook, `clean hook (${clean.hook}) should beat filler (${s.hook})`);
});

test('ScoreEngine: meters in range, weighted total consistent', () => {
  const s = evaluate(edl, tl, wordsFrozen, { platform: 'shorts' });
  for (const m of ['hook', 'pacing', 'visual', 'story']) assert.ok(s[m] >= 0 && s[m] <= 100, `${m}=${s[m]}`);
  const expect = Math.round(s.hook * 0.35 + s.pacing * 0.25 + s.visual * 0.2 + s.story * 0.2);
  assert.equal(s.total, expect);
  assert.ok(s.wpm > 60, `wpm=${s.wpm}`);
});

test('DurationBudget: never drops the hook or the payoff keep', () => {
  const keeps = edl.keep;
  const fitted = fitToTarget(keeps, 5); // brutal target
  const srcIns = fitted.map((k) => k.in);
  assert.ok(srcIns.includes(keeps[0].in), 'hook kept');
  assert.ok(srcIns.includes(keeps[keeps.length - 1].in), 'payoff kept');
  const total = fitted.reduce((a, k) => a + k.out - k.in, 0);
  assert.ok(total >= 5 * 0.6, `floor respected: ${total}`);
});

test('DurationBudget: no-op when already fits', () => {
  const fitted = fitToTarget(edl.keep, 30);
  assert.equal(fitted.length, edl.keep.length);
});

test('TakeStacks: stumble-restart duplicates group; last take selected', () => {
  const speech = [
    W('So', 0.0, 0.2), W('the', 0.2, 0.4), W('reason', 0.4, 0.7), W('is', 0.7, 0.9), W('wait—', 0.9, 1.2),
    W('The', 1.5, 1.7), W('reason', 1.7, 2.0), W('is', 2.0, 2.2), W('latency.', 2.2, 2.6),
    W('Unrelated', 4.0, 4.5), W('next.', 4.5, 5.0),
  ].map((w, i) => ({ ...w, i }));
  const groups = groupTakes(speech);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].takes.length, 2);
  assert.equal(groups[0].selected, 1);
  // swap to take 0 -> cut range covers take 1
  const cuts = cutsForSelection(groups[0], 0);
  assert.equal(cuts.length, 1);
  assert.ok(cuts[0].from === speech.findIndex((w) => w.w === 'The'));
});
