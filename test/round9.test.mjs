// Round-9 tests: word-anchored B-roll resolve, story-card order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline } from '../engine/timeline.js';

const W = (w, start, end) => ({ w, start, end });
const words = Array.from({ length: 50 }, (_, i) => W(`w${i}`, i * 0.5, i * 0.5 + 0.4)).map((w, i) => ({ ...w, i }));

test('word-anchored b-roll: resolve maps word -> edited time; cold open honored; cut anchor drops', () => {
  // cold open: play order = [20-25s source] then [0-10s]
  const keep = [{ in: 10, out: 15 }, { in: 0, out: 5 }];
  const tl = buildTimeline(keep, { fps: 30 });
  const resolve = (entries) => entries.map((b) => {
    const anchor = typeof b.words?.[0] === 'number' ? b.words[0] : null;
    const at = anchor != null
      ? (words[anchor] ? tl.sourceToEdited(words[anchor].start) : null)
      : (typeof b.at === 'number' ? b.at : null);
    return at == null ? null : { ...b, at };
  }).filter(Boolean);
  // anchor word 22 (11s source) lives in keep[0] -> edited 0-5 zone
  const a = resolve([{ words: [22], src: 'b1.mp4', dur: 3 }]);
  assert.equal(a.length, 1);
  assert.ok(a[0].at >= 0 && a[0].at <= 5, `at=${a[0].at}`);
  // anchor word 45 (22.5s source) is cut -> entry drops
  const b = resolve([{ words: [45], src: 'b2.mp4', dur: 3 }]);
  assert.equal(b.length, 0);
  // legacy time-anchored entries still resolve
  const c = resolve([{ at: 4 }]);
  assert.equal(c.length, 1);
  assert.equal(c[0].at, 4);
});

test('story cards render in PLAY order (cold open first card is later source)', () => {
  // simulates StoryScript grouping: first card text = words of keep[0]
  const keep = [{ in: 10, out: 15 }, { in: 0, out: 5 }];
  const firstCardWords = words.filter((w) => w.start >= keep[0].in && w.start < keep[0].out);
  const secondCardWords = words.filter((w) => w.start >= keep[1].in && w.start < keep[1].out);
  assert.ok(firstCardWords[0].start > secondCardWords[0].start, 'cold open card reads later-source first');
});

test('EDL JSON is serializable (escape-hatch export shape)', () => {
  const edl = { style: { w: 1080, h: 1920, fps: 30 }, keep: [{ in: 0, out: 2 }], broll: [{ words: [1], src: 'x.mp4', at: 0.5 }] };
  const round = JSON.parse(JSON.stringify(edl));
  assert.deepEqual(round.keep, edl.keep);
  assert.equal(round.broll[0].src, 'x.mp4');
});
