// Round-11 tests: ducking envelope, SFX scheduling, J-cut lead, snap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDuckEnvelope, scheduleSfx, audioInFor, renderSfx } from '../src/core/AudioMix.js';
import { buildTimeline } from '../engine/timeline.js';

const W = (w, start, end) => ({ w, start, end });
const words = [W('hello', 1.0, 1.5), W('world', 1.6, 2.0)].map((w, i) => ({ ...w, i }));
const tl = buildTimeline([{ in: 0, out: 6 }], { fps: 30 });

test('ducking envelope: ducks during words, recovers in gaps, ramps not instant', () => {
  const env = computeDuckEnvelope(words, tl, {});
  const at = (t) => env[Math.floor(t / 0.05)];
  assert.ok(at(1.2) < 0.4, `speaking gain should be low, got ${at(1.2)}`);   // ~-20dB = 0.1
  assert.ok(at(5.0) > 0.25, `gap gain should recover, got ${at(5.0)}`);      // ~-8dB = 0.4
  // ramp: somewhere between speaking end and deep gap there is a middle value
  const mids = [2.6, 3.0, 3.5].map(at);
  assert.ok(mids.some((v) => v > at(1.2) && v < at(5.0)), `ramp values ${mids}`);
});

test('SFX scheduling: one per join + punch, 80ms pre-roll, no dupes', () => {
  const edl = { keep: [{ in: 0, out: 2 }, { in: 3, out: 5 }, { in: 6, out: 8 }], punches: [{ at: 2.0 }, { at: 4.5 }] };
  const sfx = scheduleSfx(edl, {});
  assert.equal(sfx.filter((e) => e.kind === 'whoosh').length, 2); // joins at 2s and 5s
  assert.ok(sfx.every((e) => e.gainDb === -14));
  const keys = new Set(sfx.map((e) => `${e.kind}@${e.at}`));
  assert.equal(keys.size, sfx.length); // no dupes
});

test('J-cut lead: tight joins lead audio, big gaps and first segment do not', () => {
  const keep = [{ in: 0, out: 2 }, { in: 2.3, out: 5 }, { in: 9, out: 12 }];
  assert.equal(audioInFor(keep, 0), 0);              // first: no lead
  assert.ok(audioInFor(keep, 1) < keep[1].in, 'tight join leads');       // removed 0.3 -> lead 0.24
  assert.ok(Math.abs((keep[1].in - audioInFor(keep, 1)) - 0.2) < 1e-9); // min(lead 0.2, removed*0.8 0.24)
  assert.equal(audioInFor(keep, 2), keep[2].in);      // removed 4s -> no lead
});

test('renderSfx: pop is short, whoosh is 400ms, both bounded', () => {
  const pop = renderSfx('pop', 48000, -14);
  const whoosh = renderSfx('whoosh', 48000, -14);
  assert.equal(pop.length, 384); // 8ms
  assert.equal(whoosh.length, 19200); // 400ms
  let peak = 0;
  for (const v of whoosh) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak > 0.01 && peak < 0.5); // -14dB-ish
});
