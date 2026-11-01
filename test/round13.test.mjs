// Round-13 tests: QaGate, council system builder, debate_log passthrough.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEdl } from '../src/core/QaGate.js';
import { councilSystem, STANCES } from '../src/agents/council.js';
import { applyGlm } from '../engine/edit-engine.js';

const base = (over = {}) => ({
  style: { w: 1080, h: 1920, fps: 30, captionsMode: 'off' },
  keep: [{ in: 0, out: 5 }, { in: 6, out: 10 }],
  broll: [], punches: [], words: [],
  ...over,
});

test('QaGate: clean EDL passes with no blockers', () => {
  const { blockers, warnings } = checkEdl(base());
  assert.equal(blockers.length, 0);
  assert.equal(warnings.length, 0);
});

test('QaGate: broll without src is a blocker; bad keep too; odd dims too', () => {
  const a = checkEdl(base({ broll: [{ at: 1, dur: 3 }] }));
  assert.ok(a.blockers.some((b) => /no src/.test(b)));
  const b = checkEdl(base({ keep: [{ in: 5, out: 5 }] }));
  assert.ok(b.blockers.some((x) => /out <= in/.test(x)));
  const c = checkEdl(base({ style: { w: 1081, h: 1920, fps: 30, captionsMode: 'off' } }));
  assert.ok(c.blockers.some((x) => /odd dimensions/.test(x)));
});

test('QaGate: warnings fire for >60s keep, out-of-range punch, caption overflow', () => {
  const a = checkEdl(base({ keep: [{ in: 0, out: 70 }] }));
  assert.ok(a.warnings.some((w) => /60s/.test(w)));
  const b = checkEdl(base({ punches: [{ at: 999, scale: 1.1, ms: 400, kind: 'cut' }] }));
  assert.ok(b.warnings.some((w) => /beyond timeline/.test(w)));
  const c = checkEdl(base({
    style: { w: 1080, h: 1920, fps: 30, captionsMode: 'word-pop', captionSize: 72 },
    keep: [{ in: 0, out: 2 }],
    words: [{ w: 'a'.repeat(40), start: 0, end: 1, i: 0 }],
  }));
  assert.ok(c.warnings.some((w) => /overflow/.test(w)), JSON.stringify(c.warnings));
});

test('councilSystem: stance weights + locks + WPM window appear in the prompt', () => {
  const s = councilSystem('ruthless', [[12, 24]]);
  assert.ok(s.includes('Rhythm Editor'));
  assert.ok(s.includes('60%'));                       // ruthless rhythm weight
  assert.ok(s.includes('12-24'));                     // locked ranges listed
  assert.ok(s.includes('165-195'));                   // ruthless WPM window
  assert.ok(/dominant language/.test(s));             // language rule
  const st = councilSystem('storyteller', []);
  assert.ok(st.includes('60%') && st.includes('130-160'));
  assert.ok(Object.keys(STANCES).length === 3);
});

test('applyGlm: debate_log passthrough validated + filtered', () => {
  const words = Array.from({ length: 20 }, (_, i) => ({ w: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4, i }));
  const r = applyGlm({
    keeps: [{ from: 0, to: 9 }],
    debate_log: [
      { blockId: '0-9', rhythmArgument: 'cut it', scriptwriterCounter: 'keep context', managerialVerdict: 'split', scoreImpact: '+18 Hook' },
      { blockId: 'x' }, // empty entry -> filtered
      { rhythmArgument: 'a', managerialVerdict: 'b', scoreImpact: 'x'.repeat(50) }, // clamped
    ],
  }, words, 10);
  assert.equal(r.debateLog.length, 2);
  assert.equal(r.debateLog[0].scoreImpact, '+18 Hook');
  assert.ok(r.debateLog[1].scoreImpact.length <= 30);
});
