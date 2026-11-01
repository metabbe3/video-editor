import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TUNING, freezeWords, detectSilence, calibrateThreshold, snapToEnergyMin,
  heuristicKeeps, applyGlm, salvageJsonArrays, normalizeKeeps, planFyp,
  removedView, measureLufs, peakDb, loudnessGain, ValidationError, transitionsFor,
  sentenceSpans, applyManualOverrides, highPass80, compressProgram,
} from '../engine/edit-engine.js';
import { PLATFORMS, buildUserPayload } from '../engine/glm.js';
import { buildTimeline, buildCaptions } from '../engine/timeline.js';
import { spring, zetaFromOvershoot, EASE, punchScale, settleMs } from '../engine/motion.js';

const W = (w, start, end) => ({ w, start, end });

// ---------- freezeWords ----------
test('freezeWords drops sub-50ms spans and re-indexes stably', () => {
  const frozen = freezeWords([
    W('so', 0.0, 0.3), W('um', 0.3, 0.32), // 20ms -> dropped
    W('I', 0.32, 0.5), W('built', 0.5, 0.9),
  ]);
  assert.deepEqual(frozen.map((x) => x.w), ['so', 'I', 'built']);
  assert.deepEqual(frozen.map((x) => x.i), [0, 1, 2]);
});

test('freezeWords extends ends (whisper early-end bias), capped by next word', () => {
  const frozen = freezeWords([W('a', 0.0, 1.0), W('b', 1.2, 2.0), W('c', 5.0, 6.0)]);
  // gap a->b = 0.2 -> extend 0.1; gap b->c = 3.0 -> cap at 0.3
  assert.equal(frozen[0].end, 1.1);
  assert.equal(frozen[1].end, 2.3);
});

// ---------- silence / energy ----------
test('detectSilence finds intervals with hysteresis and min duration', () => {
  // 10s at 50ms hops: speech 0-3s, silence 3-6s, speech 6-10s
  const hop = 0.05, n = 200;
  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) energy[i] = i < 60 || i >= 120 ? 0.3 : 0.0005;
  const sil = detectSilence(energy, hop, -35);
  assert.equal(sil.length, 1);
  assert.ok(Math.abs(sil[0].start - 3.0) < 0.1);
  assert.ok(Math.abs(sil[0].end - 6.0) < 0.1);
  assert.ok(sil[0].minAt >= 3.0 && sil[0].minAt <= 6.0);
});

test('detectSilence ignores short dips', () => {
  const hop = 0.05;
  const energy = new Float32Array(100); // 5s
  energy.fill(0.3);
  for (let i = 70; i < 74; i++) energy[i] = 0.001; // 200ms < minSilence
  assert.equal(detectSilence(energy, hop, -35).length, 0);
});

test('calibrateThreshold sits between room tone and speech', () => {
  const energy = [];
  for (let i = 0; i < 500; i++) energy.push(0.001); // quiet
  for (let i = 0; i < 500; i++) energy.push(0.3);   // speech
  const db = calibrateThreshold(new Float32Array(energy));
  assert.ok(db < -20 && db > -45, `got ${db}`);
});

test('snapToEnergyMin finds the valley within the window', () => {
  const hop = 0.02;
  const energy = new Float32Array(300);
  energy.fill(0.3);
  energy[150] = 0.001; // valley at 3.0s
  assert.ok(Math.abs(snapToEnergyMin(3.05, energy, hop) - 3.0) < 0.02);
});

// ---------- heuristicKeeps ----------
test('heuristics cut filler words tight at word boundaries', () => {
  const words = freezeWords([W('so', 0.0, 0.25), W('um', 0.3, 0.5), W('I', 0.55, 0.8), W('ship', 0.8, 1.1), W('code', 1.1, 1.4)]);
  const keeps = heuristicKeeps(words, 1.6);
  // um (frozen end 0.525) removed: [start-0.02, end+0.06] = [0.28, 0.585]
  assert.equal(keeps.length, 2);
  assert.ok(Math.abs(keeps[0].out - 0.28) < 0.02, `out=${keeps[0].out}`);
  assert.ok(Math.abs(keeps[1].in - 0.585) < 0.02, `in=${keeps[1].in}`);
});

test('heuristics trim a 1.5s word gap to a ~0.2s residual', () => {
  const words = freezeWords([W('one', 0.0, 1.0), W('two', 2.5, 3.5)]);
  const keeps = heuristicKeeps(words, 4.0);
  const kept = keeps.map((k) => [k.in, k.out]);
  // island (residual) must survive: ~0.2s island between two removals
  const island = kept.find(([a, b]) => b - a < 0.35);
  assert.ok(island, `no residual island in ${JSON.stringify(kept)}`);
  assert.ok(Math.abs((island[1] - island[0]) - TUNING.residualPause) < 0.06);
});

// ---------- GLM application ----------
const glmWords = freezeWords([
  W('you', 0.0, 0.2), W('will', 0.2, 0.4), W('not', 0.4, 0.6), W('believe', 0.6, 1.0),
  W('um', 1.1, 1.3), W('this', 1.4, 1.7), W('tool', 1.7, 2.1),
  W('and', 3.0, 3.2), W('that', 3.2, 3.5), W('rocks', 3.5, 4.0), W('hard', 4.0, 4.4),
]);

test('applyGlm maps word-index keeps to padded time ranges', () => {
  const { keeps } = applyGlm({ keeps: [{ from: 0, to: 3, why: 'hook' }, { from: 5, to: 6, why: 'body' }] }, glmWords, 5);
  assert.equal(keeps.length, 2);
  // in clamped to >= 0 (padLead wanted -0.04); out = extended 'believe' end (1.05) + padTrail
  assert.ok(keeps[0].in >= 0 && keeps[0].in <= 0.01, `in=${keeps[0].in}`);
  assert.ok(Math.abs(keeps[0].out - (1.05 + TUNING.padTrail)) < 0.02, `out=${keeps[0].out}`);
  assert.ok(keeps[0].words[0] === 0 && keeps[0].words[1] === 3);
});

test('applyGlm clamps, swaps, and skips garbage entries', () => {
  const { keeps } = applyGlm({
    keeps: [
      { from: -5, to: 999, why: 'clamp' },   // clamped to [0, n-1] -> whole range
      { from: 9, to: 2, why: 'swapped' },    // reversed -> swapped
      { from: 'x', to: null },               // garbage -> skipped
    ],
  }, glmWords, 5);
  // whole-range + swapped overlap-merge into fewer ranges; all times valid
  for (const k of keeps) { assert.ok(k.in >= 0 && k.out <= 5 && k.out > k.in); }
  assert.ok(keeps.length >= 1);
});

test('applyGlm rejects empty keeps with ValidationError', () => {
  assert.throws(() => applyGlm({ keeps: [] }, glmWords, 5), ValidationError);
  assert.throws(() => applyGlm('{"nope": 1}', glmWords, 5), ValidationError);
});

test('salvageJsonArrays repairs a truncated keeps array', () => {
  const truncated = '{"keeps":[{"from":0,"to":3,"why":"hook"},{"from":5,"to":6,"why":"b';
  const repaired = JSON.parse(salvageJsonArrays(truncated));
  assert.equal(repaired.keeps.length, 1);
  assert.equal(repaired.keeps[0].to, 3);
  const res = applyGlm(truncated, glmWords, 5);
  assert.equal(res.keeps.length, 1);
});

test('applyGlm round-trips a frozen array containing a dropped 30ms span (no index drift)', () => {
  const frozen = freezeWords([W('a', 0, 0.5), W('um', 0.5, 0.53), W('b', 0.55, 1.0), W('c', 1.0, 1.5)]);
  // 'um' dropped by the 50ms guard BEFORE the prompt; GLM indices address the frozen array
  assert.equal(frozen.length, 3);
  const { keeps } = applyGlm({ keeps: [{ from: 1, to: 2, why: 'x' }] }, frozen, 2);
  assert.ok(Math.abs(keeps[0].in - (0.55 - TUNING.padLead)) < 0.02); // lands on 'b', not drift
});

// ---------- timeline ----------
test('timeline maps edited<->source consistently (frame/sample integers)', () => {
  const tl = buildTimeline([{ in: 10, out: 12 }, { in: 20, out: 24 }], { fps: 30 });
  assert.equal(tl.duration, 6);
  assert.equal(tl.frameCount, 180);
  // boundary: edited 2.0 == start of segment 2
  const m = tl.editedToSource(2.0);
  assert.equal(m.seg, 1);
  assert.ok(Math.abs(m.src - 20) < 1e-9);
  // inside segment
  assert.ok(Math.abs(tl.editedToSource(3.5).src - 21.5) < 1e-9);
  // round trip
  for (const src of [10, 11.999, 20, 22, 23.9]) {
    const e = tl.sourceToEdited(src);
    assert.ok(e != null);
    assert.ok(Math.abs(tl.editedToSource(e).src - src) < 1e-9);
  }
  // removed source time maps to null
  assert.equal(tl.sourceToEdited(15), null);
  // frame times are exact rationals, no drift
  assert.equal(tl.frameTime(90), 3);
  assert.equal(tl.frameUs(90), 3000000);
  assert.equal(tl.sampleIndex(tl.frameTime(89), 48000), Math.round(89 / 30 * 48000));
});

test('timeline preserves input (play) order — cold-open sequences', () => {
  // teaser from t=100 plays FIRST, then the chronological body
  const tl = buildTimeline([{ in: 100, out: 102 }, { in: 1, out: 2 }], { fps: 30 });
  assert.equal(tl.segments.length, 2);
  assert.deepEqual([tl.segments[0].in, tl.segments[0].out], [100, 102]); // play order, not sorted
  assert.equal(tl.duration, 3);
  // edited 0..2 = teaser; 2..3 = body
  assert.ok(Math.abs(tl.editedToSource(1).src - 101) < 1e-9);
  assert.ok(Math.abs(tl.editedToSource(2.5).src - 1.5) < 1e-9);
  // sourceToEdited is a full scan — works for the later-source segment
  assert.ok(Math.abs(tl.sourceToEdited(1.5) - 2.5) < 1e-9);
  assert.equal(tl.sourceToEdited(50), null);
});

test('normalizeKeeps: sequence order preserved; chronological overlaps bridge', () => {
  // sequence [T(100-102), B(10-20)] — no chronological interaction, both survive in order
  const a = normalizeKeeps([{ in: 100, out: 102 }, { in: 10, out: 20 }], 200);
  assert.deepEqual(a.map((k) => k.in), [100, 10]);
  // chronologically overlapping entries bridge (content plays once)
  const b = normalizeKeeps([{ in: 10, out: 20 }, { in: 18, out: 30 }], 200);
  assert.deepEqual(b.map((k) => [k.in, k.out]), [[10, 30]]);
});

// ---------- FYP planning ----------
const fypWords = freezeWords(
  Array.from({ length: 60 }, (_, i) => W(`w${i}`, i * 1.0, i * 1.0 + 0.8)),
);
const fypKeeps = [{ in: 0, out: 12 }, { in: 13, out: 26 }, { in: 27, out: 40 }, { in: 41, out: 54 }, { in: 55, out: 58 }];

test('planFyp enforces target length and punch cadence', () => {
  const tl = (ks) => buildTimeline(ks, { fps: 30 });
  const { keeps, punches } = planFyp(fypKeeps, fypWords, tl, {
    emphases: [5, 45], // words guaranteed inside keeps that survive length trim
    tuning: { ...TUNING, targetLen: [21, 34] },
  });
  const total = keeps.reduce((a, k) => a + k.out - k.in, 0);
  assert.ok(total <= 34 + 0.5, `total=${total}`);
  assert.ok(keeps.length >= 2);
  const cuts = punches.filter((p) => p.kind === 'cut');
  const nSegments = keeps.length;
  assert.ok(cuts.length <= Math.ceil(nSegments / 3) + 1, `cuts=${cuts.length} segs=${nSegments}`);
  for (const p of cuts) { assert.ok(p.scale > 1 && p.scale < 1.15); assert.ok(p.ms >= 300 && p.ms <= 500); }
  const emph = punches.filter((p) => p.kind === 'emphasis');
  assert.equal(emph.length, 2);
});

test('planFyp hook: no dead air before the first word', () => {
  const tl = (ks) => buildTimeline(ks, { fps: 30 });
  const words = freezeWords([W('hey', 1.0, 1.4), W('watch', 1.5, 2.0)]);
  const { keeps } = planFyp([{ in: 0, out: 3 }], words, tl, {});
  assert.ok(keeps[0].in >= 0.9 && keeps[0].in <= 1.0, `in=${keeps[0].in}`);
});

// ---------- transitions ----------
test('transitionsFor: dissolve only at joins with >1s removed, at cumulative edited times', () => {
  const keep = [{ in: 0, out: 2 }, { in: 2.4, out: 5 }, { in: 9, out: 12 }]; // gaps 0.4s, 4s
  const tr = transitionsFor(keep);
  assert.equal(tr.length, 1);                          // only the 4s removal
  assert.ok(Math.abs(tr[0].at - 4.6) < 1e-9);          // join = seg0 (2s) + seg1 (2.6s)
  assert.equal(tr[0].ms, TUNING.transition.ms);
  assert.equal(transitionsFor([{ in: 0, out: 5 }]).length, 0);
});

test('transitionsFor: reorder joins (negative gap) are hard cuts', () => {
  const cold = [{ in: 100, out: 102 }, { in: 1, out: 4 }]; // backward jump of 99s
  assert.equal(transitionsFor(cold).length, 0);
});

// ---------- round 5: join punches, score passthrough, audio chain ----------
test('planFyp: join punch-ins at removed-span joins, alternating; suppressed when joinPunches=false', () => {
  const words = freezeWords(Array.from({ length: 40 }, (_, i) => W(`w${i}`, i * 2, i * 2 + 1.2)));
  const keeps = [{ in: 0, out: 6 }, { in: 9, out: 14 }, { in: 17, out: 22 }, { in: 25, out: 30 }];
  const mk = (joinPunches) => planFyp(keeps, words, (ks) => buildTimeline(ks, { fps: 30 }), {
    tuning: { ...TUNING, targetLen: [21, 34], joinPunches },
  });
  const on = mk(true).punches.filter((p) => p.kind === 'cut');
  assert.equal(on.length, 3); // every join removed >1s
  const scales = on.map((p) => p.scale);
  assert.ok(scales[0] !== scales[1] && scales[1] !== scales[2], `alternating: ${scales}`);
  assert.ok(on.every((p) => p.scale >= 1.10 && p.scale <= 1.15));
  const off = mk(false).punches.filter((p) => p.kind === 'cut');
  assert.equal(off.length, 0); // relaxed preset suppresses join punches
});

test('applyGlm passes per-keep virality score through, clamped', () => {
  const { keeps } = applyGlm({
    keeps: [{ from: 0, to: 2, why: 'hook', score: 92 }, { from: 3, to: 4, why: 'x', score: 999 }, { from: 5, to: 6, why: 'y', score: -5 }],
  }, glmWords, 5);
  assert.ok(keeps.every((k) => Number.isInteger(k.score)));
  const scores = keeps.map((k) => k.score).sort((a, b) => b - a);
  assert.ok(scores[0] <= 100);
});

test('punchScale eases from the previous punch\'s settled scale (no snap to 1.0)', () => {
  const punches = [
    { at: 2, scale: 1.10, ms: 400, kind: 'cut' },
    { at: 6, scale: 1.15, ms: 400, kind: 'cut' },
  ];
  assert.ok(Math.abs(punchScale(4, punches) - 1.10) < 1e-9); // held
  const atJoin = punchScale(6.01, punches);                    // just into punch 2
  assert.ok(atJoin > 1.10 && atJoin < 1.15, `starts from 1.10, got ${atJoin}`);
  assert.ok(Math.abs(punchScale(7.5, punches) - 1.15) < 1e-9);
  // never dips below the previous settled scale anywhere across both joins
  for (let t = 0; t < 9; t += 0.01) assert.ok(punchScale(t, punches) >= 1.0 - 1e-9);
  for (let t = 2.6; t < 9; t += 0.01) assert.ok(punchScale(t, punches) >= 1.099);
});

test('highPass80 attenuates low frequencies, passes speech band', () => {
  const rate = 48000;
  const low = new Float32Array(rate); // 30 Hz
  for (let i = 0; i < low.length; i++) low[i] = 0.5 * Math.sin((2 * Math.PI * 30 * i) / rate);
  const mid = new Float32Array(rate); // 1 kHz
  for (let i = 0; i < mid.length; i++) mid[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / rate);
  const rms = (x, from = rate >> 1) => { let s = 0; for (let i = from; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / (x.length - from)); };
  const lowRatio = rms(highPass80(low, rate), undefined) / rms(low);
  const midRatio = rms(highPass80(mid, rate)) / rms(mid);
  assert.ok(lowRatio < 0.6, `30Hz should be cut, ratio ${lowRatio.toFixed(2)}`);
  assert.ok(midRatio > 0.9, `1kHz should pass, ratio ${midRatio.toFixed(2)}`);
});

test('compressProgram: tames peaks, anchored to program RMS, never expands', () => {
  const rate = 48000;
  const pcm = new Float32Array(rate * 2);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = 0.2 * Math.sin((2 * Math.PI * 1000 * i) / rate);
    if (i > rate && i < rate + 4800) pcm[i] = 0.95; // hot burst
  }
  const out = compressProgram(pcm, rate);
  let peakIn = 0, peakOut = 0;
  for (let i = 0; i < pcm.length; i++) { peakIn = Math.max(peakIn, Math.abs(pcm[i])); peakOut = Math.max(peakOut, Math.abs(out[i])); }
  assert.ok(peakOut < peakIn, `peaks reduced ${peakIn.toFixed(2)} -> ${peakOut.toFixed(2)}`);
});

// ---------- manual overrides (transcript click-to-cut) ----------
const ovWords = freezeWords([
  W('You', 0.0, 0.2), W('know', 0.25, 0.45), W('this', 0.5, 0.8), W('rocks.', 0.85, 1.3),
  W('Really', 1.5, 1.9), W('rocks.', 2.0, 2.5),
]);

test('sentenceSpans splits on terminal punctuation', () => {
  const spans = sentenceSpans(ovWords);
  assert.deepEqual(spans, [{ from: 0, to: 3 }, { from: 4, to: 5 }]);
});

test('applyManualOverrides: cut removes exactly that word span', () => {
  const base = [{ in: 0, out: 3, why: 'speech' }];
  const out = applyManualOverrides(base, ovWords, { cuts: [1] }, 3); // cut "know"
  const removedWord = ovWords[1];
  // no keep range fully covers the cut word anymore
  assert.ok(!out.some((k) => k.in <= removedWord.start && k.out >= removedWord.end));
  // but neighbors survive
  assert.ok(out.some((k) => k.in <= 0.05 && k.out >= 0.15));
});

test('applyManualOverrides: force-keep union survives a full cut', () => {
  const base = [{ in: 0, out: 1.0 }]; // cuts away the second sentence
  const out = applyManualOverrides(base, ovWords, { keeps: [4, 5] }, 3);
  const w = ovWords[5];
  assert.ok(out.some((k) => k.in <= w.start && k.out >= w.end), JSON.stringify(out));
});

test('applyManualOverrides: no-op with empty overrides', () => {
  const base = [{ in: 0, out: 2 }];
  assert.equal(applyManualOverrides(base, ovWords, {}, 3), base);
});

// ---------- GLM persona payload ----------
test('buildUserPayload: instructions, feedback, current cut included; no timestamps', () => {
  const words = freezeWords([W('a', 0, 0.5), W('b', 0.6, 1.0), W('c', 1.1, 1.5)]);
  const p = buildUserPayload({
    words, duration: 10,
    brollNames: ['x.mp4'],
    instructions: 'cut the intro',
    feedback: ['make it punchier', 'Self-critique from pass 1: weak hook'],
    currentKeeps: [{ in: 0.1, out: 1.2, words: [0, 1] }],
  });
  assert.ok(p.includes('0:a 1:b 2:c'));
  assert.ok(p.includes("EDITOR'S INSTRUCTIONS"));
  assert.ok(p.includes('cut the intro'));
  assert.ok(p.includes('FEEDBACK HISTORY'));
  assert.ok(p.includes('CURRENT CUT'));
  assert.ok(p.includes('0-1'));
  assert.ok(!/\d+\.\d+s?\s*→/.test(p.replace(/Duration of source[^\n]*/, ''))); // no word timestamps leak
});

test('PLATFORMS presets carry distinct targets and hook budgets', () => {
  assert.deepEqual(PLATFORMS.shorts.targetLen, [21, 34]);
  assert.ok(PLATFORMS.tiktok.hookSec < PLATFORMS.shorts.hookSec);
  assert.ok(PLATFORMS.youtube.targetLen[1] > PLATFORMS.shorts.targetLen[1]);
});

// ---------- round 6: variants, long-form, suggested cuts, chapters ----------
test('applyGlm: clips[] response -> variants; legacy keeps[] still works', () => {
  const clipsResp = {
    clips: [
      { title: 'Cost reveal', hookTitle: 'iPhone 2 repair shock', keeps: [{ from: 0, to: 3, why: 'hook', score: 90 }, { from: 5, to: 6, why: 'payoff', score: 80 }] },
      { title: 'Teardown', hookTitle: 'Inside the iPhone 2', keeps: [{ from: 2, to: 4, why: 'demo', score: 70 }] },
    ],
    emphases: [1], confidence: 0.9,
  };
  const r1 = applyGlm(clipsResp, glmWords, 5);
  assert.equal(r1.variants.length, 2);
  assert.equal(r1.variants[0].keeps.length, 2);
  assert.equal(r1.variants[0].hookTitle, 'iPhone 2 repair shock');
  const legacy = applyGlm({ keeps: [{ from: 0, to: 3, why: 'h' }] }, glmWords, 5);
  assert.equal(legacy.variants.length, 1);
  assert.equal(legacy.keeps.length, 1);
  assert.throws(() => applyGlm({ emphases: [1] }, glmWords, 5), ValidationError);
});

test('applyGlm: wild indices are dropped, not clamped', () => {
  const r = applyGlm({ keeps: [{ from: 0, to: 3 }, { from: 9999, to: 10500 }] }, glmWords, 5);
  assert.equal(r.keeps.length, 1); // the wild keep gone, the good one intact
});

test('planFyp: noTrim (long-form) never force-shrinks', () => {
  const words = freezeWords(Array.from({ length: 600 }, (_, i) => W(`w${i}`, i * 1.0, i * 1.0 + 0.8)));
  const keeps = Array.from({ length: 8 }, (_, i) => ({ in: i * 60, out: i * 60 + 55 })); // ~7.3 min
  const { keeps: trimmed, timeline } = planFyp(keeps, words, (ks) => buildTimeline(ks, { fps: 30 }), {
    tuning: { ...TUNING, targetLen: [240, 1800], noTrim: true, joinPunches: false },
  });
  assert.equal(trimmed.length, 8); // nothing dropped
  assert.ok(timeline.duration > 400);
  // and short-form mode still trims (regression)
  const { keeps: shrunk } = planFyp(keeps, words, (ks) => buildTimeline(ks, { fps: 30 }), {
    tuning: { ...TUNING, targetLen: [21, 34], joinPunches: false },
  });
  assert.ok(shrunk.length < 8);
});

test('applyManualOverrides: {from,to} range cut removes the span atomically', () => {
  const words = freezeWords(Array.from({ length: 20 }, (_, i) => W(`w${i}`, i * 0.5, i * 0.5 + 0.4)));
  const base = [{ in: 0, out: 10 }];
  const out = applyManualOverrides(base, words, { cuts: [{ from: 5, to: 9 }] }, 10);
  const cutWords = words.slice(5, 10);
  assert.ok(!out.some((k) => k.in <= cutWords[0].start && k.out >= cutWords[cutWords.length - 1].end));
  assert.ok(out.length >= 1 && out[0].out <= cutWords[0].start + 0.05); // head intact
  assert.ok(out.every((k) => k.out - k.in >= TUNING.minKeep)); // no slivers
});

test('applyGlm passthrough: chapters + suggestedCuts validated', () => {
  const r = applyGlm({
    keeps: [{ from: 0, to: 3 }],
    chapters: [{ title: 'Intro', from: 0, to: 2 }, { title: 'Demo', from: 3, to: 9 }],
    suggestedCuts: [{ from: 4, to: 6, why: 'off-topic story' }, { from: -50, to: 900, why: 'wild' }],
  }, glmWords, 5);
  assert.equal(r.chapters.length, 2);
  assert.equal(r.suggestedCuts.length, 1); // wild one dropped
  assert.equal(r.suggestedCuts[0].why, 'off-topic story');
});

test('transitionsFor: preset knob — long-form Infinity means hard cuts everywhere', () => {
  const keep = [{ in: 0, out: 2 }, { in: 9, out: 12 }];
  assert.equal(transitionsFor(keep, { minRemoved: Infinity, ms: 0 }).length, 0);
  assert.equal(transitionsFor(keep).length, 1);
});

// ---------- captions ----------
test('captions: 1-3 word pops in edited time, punctuation breaks', () => {
  const words = freezeWords([
    W('You', 0.0, 0.3), W('need', 0.3, 0.6), W('this.', 0.6, 0.9),
    W('Really.', 1.0, 1.4),
    W('Five', 1.5, 1.8), W('stars', 1.8, 2.1),
  ]);
  const tl = buildTimeline([{ in: 0, out: 2.2 }], { fps: 30 });
  const caps = buildCaptions(words, tl, { maxWords: 3 });
  assert.equal(caps.length, 3); // "You need this." / "Really." / "Five stars"
  assert.equal(caps[0].text, 'You need this.');
  assert.equal(caps[1].text, 'Really.');
  assert.ok(caps.every((c) => c.t1 > c.t0));
});

// ---------- removed view ----------
test('removedView complements keeps', () => {
  const view = removedView([{ in: 1, out: 3 }], 5);
  assert.deepEqual(view, [
    { start: 0, end: 1, why: 'removed' },
    { start: 3, end: 5, why: 'tail' },
  ]);
});

// ---------- loudness ----------
function sine(seconds, amp, rate = 48000) {
  const x = new Float32Array(seconds * rate);
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * 1000 * i) / rate);
  return x;
}

test('measureLufs: 1 kHz sine at 0.5 amp ~= -9.7 LUFS (K-weighting ~0dB @1k)', () => {
  const m = measureLufs(sine(3, 0.5));
  assert.ok(Math.abs(m - (-9.7)) < 1.5, `got ${m}`);
});

test('measureLufs gating ignores leading silence', () => {
  const sil = new Float32Array(2 * 48000); // 2s silence
  const pcm = new Float32Array([...sil, ...sine(3, 0.5)]);
  const m = measureLufs(pcm);
  assert.ok(Math.abs(m - (-9.7)) < 1.5, `got ${m}`);
});

test('loudnessGain hits target but caps at true peak ceiling', () => {
  const quiet = { gainDb: loudnessGain(sine(3, 0.05)).gainDb };
  const loud = { gainDb: loudnessGain(sine(3, 0.9)).gainDb };
  // quiet: wants big boost, but peak 0.9-> -0.9dBFS caps boost near 0
  assert.ok(quiet.gainDb < 20 && loud.gainDb < 0);
  const boostedPeak = 0.05 * 10 ** (quiet.gainDb / 20);
  assert.ok(boostedPeak <= 1.0, `peak ${boostedPeak}`); // never clips
  assert.ok(loud.gainDb <= -14 - (-4.4) + 0.01); // attenuated toward target
});

// ---------- motion ----------
test('spring endpoints and overshoot', () => {
  const bouncy = { stiffness: 380, damping: 2 * zetaFromOvershoot(0.10) * Math.sqrt(380), mass: 1 };
  assert.equal(spring(0, bouncy), 0);
  let peak = 0;
  for (let t = 0; t < 3; t += 0.001) peak = Math.max(peak, spring(t, bouncy));
  assert.ok(Math.abs(peak - 1.10) < 0.02, `peak=${peak}`);
  assert.ok(Math.abs(spring(3, bouncy) - 1) < 0.001); // settled
  assert.ok(Math.abs(zetaFromOvershoot(0.10) - 0.5912) < 0.01);
});

test('effect spring never overshoots (critically damped)', () => {
  const s = { stiffness: 1600, damping: 2 * Math.sqrt(1600), mass: 1 };
  for (let t = 0; t < 2; t += 0.001) assert.ok(spring(t, s) <= 1.0001);
  assert.ok(settleMs(s) < 260);
});

test('punchScale: cut holds, emphasis returns', () => {
  const cut = punchScale(1.0, [{ at: 0.8, scale: 1.1, ms: 400, kind: 'cut' }]);
  assert.ok(cut > 1.05 && cut < 1.1001, `${cut}`);
  const held = punchScale(3.0, [{ at: 0.8, scale: 1.1, ms: 400, kind: 'cut' }]);
  assert.ok(Math.abs(held - 1.1) < 0.001);
  const emph = punchScale(1.0, [{ at: 0.8, scale: 1.3, ms: 400, kind: 'emphasis' }]);
  assert.ok(emph > 1.15, `${emph}`);
  const back = punchScale(1.4, [{ at: 0.8, scale: 1.3, ms: 400, kind: 'emphasis' }]);
  assert.ok(Math.abs(back - 1) < 0.05, `${back}`);
  assert.equal(punchScale(0.5, [{ at: 0.8 }]), 1);
});

test('EASE endpoints exact', () => {
  for (const f of Object.values(EASE)) { assert.equal(f(0), 0); assert.equal(f(1), 1); }
});
