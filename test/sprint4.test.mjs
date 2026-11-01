// sprint4.test.mjs — Unit tests for Sprint 4 Gap-fill bundle:
// Auto-ducking curve, 1kHz bleep censor tone, keyframes, stickers, caption translation, and chat ops.

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeDuckGainCurve, dbToLin, linToDb } from '../engine/duck.js';
import {
  generateBleepTone, applyBleepsToPcm, matchesBleepTerm, findWordsToBleep, CURSE_WORDS,
} from '../engine/bleep.js';
import {
  evalKeyframeTrack, evalClipKeyframes, setKeyframe, removeKeyframe, findKeyframeNear,
} from '../engine/keyframes.js';
import { BUILTIN_EMOJIS, suggestStickers, STICKER_KEYWORD_MAP } from '../engine/stickers.js';
import {
  buildTranslationMessages, parseTranslationResponse, TARGET_LANGUAGES,
} from '../engine/translate.js';
import { parseChatCommand, applyChatOp } from '../engine/chat-ops.js';
import { serializeProjectState, applyProjectSnapshot } from '../engine/project-store.js';

test('engine/duck.js: dbToLin and linToDb conversions', () => {
  assert.equal(+dbToLin(0).toFixed(4), 1.0);
  assert.equal(+dbToLin(-6).toFixed(4), 0.5012);
  assert.equal(+dbToLin(-12).toFixed(4), 0.2512);
  assert.equal(+dbToLin(-20).toFixed(4), 0.1);
  assert.equal(+linToDb(1.0).toFixed(1), 0.0);
  assert.equal(+linToDb(0.1).toFixed(1), -20.0);
});

test('engine/duck.js: computeDuckGainCurve with speech energy map', () => {
  // Energy: silence 0..0.5s, speech 0.5..1.5s, silence 1.5..3.0s
  const hopSec = 0.05;
  const numHops = Math.round(3.0 / hopSec);
  const energy = new Float32Array(numHops);
  for (let i = 0; i < numHops; i++) {
    const t = i * hopSec;
    if (t >= 0.5 && t <= 1.5) energy[i] = 0.25; // speech
    else energy[i] = 0.01; // silence
  }

  const duck = computeDuckGainCurve({
    energy,
    hopSec,
    duration: 3.0,
    baseDb: 0,
    duckDb: -12,
    attackMs: 150,
    releaseMs: 400,
    threshold: 0.05,
    stepSec: 0.05,
  });

  assert.equal(duck.duration, 3.0);
  assert.ok(duck.points.length > 50);

  // At t=0, gain should be near 1.0 (idle base)
  const g0 = duck.getGainAt(0.1);
  assert.ok(g0 >= 0.95, `Expected initial gain ~1.0, got ${g0}`);

  // In middle of speech (t=1.0), gain should be ducked down towards -12dB (~0.25)
  const gSpeech = duck.getGainAt(1.0);
  assert.ok(gSpeech < 0.35, `Expected ducked gain < 0.35, got ${gSpeech}`);

  // At t=2.8 (well after speech ends + release), gain recovers towards 1.0
  const gRecovered = duck.getGainAt(2.8);
  assert.ok(gRecovered > 0.85, `Expected recovered gain > 0.85, got ${gRecovered}`);
});

test('engine/duck.js: computeDuckGainCurve with word intervals', () => {
  const words = [
    { start: 1.0, end: 2.0, keep: true },
  ];
  const duck = computeDuckGainCurve({
    words,
    duration: 4.0,
    baseDb: 0,
    duckDb: -12,
    attackMs: 150,
    releaseMs: 400,
    stepSec: 0.05,
  });

  assert.ok(duck.getGainAt(0.5) > 0.9);
  assert.ok(duck.getGainAt(1.5) < 0.35);
  assert.ok(duck.getGainAt(3.5) > 0.85);
});

test('engine/bleep.js: generateBleepTone synthesizes 1kHz tone with smooth envelope', () => {
  const sampleRate = 48000;
  const durationSec = 0.08;
  const tone = generateBleepTone({ sampleRate, durationSec, freq: 1000, envelopeMs: 10 });

  assert.equal(tone.length, Math.round(durationSec * sampleRate));

  // Extremities should be ramped to near 0 by envelope
  assert.ok(Math.abs(tone[0]) < 0.05, 'First sample should be close to 0');
  assert.ok(Math.abs(tone[tone.length - 1]) < 0.05, 'Last sample should be close to 0');

  // Peak in center should be significant (> 0.4)
  let maxAmp = 0;
  for (let i = 0; i < tone.length; i++) maxAmp = Math.max(maxAmp, Math.abs(tone[i]));
  assert.ok(maxAmp > 0.5, `Peak amplitude should be high, got ${maxAmp}`);
});

test('engine/bleep.js: applyBleepsToPcm mutes speech and overlays 1kHz tone', () => {
  const sampleRate = 48000;
  const pcm = new Float32Array(sampleRate * 2); // 2s
  pcm.fill(0.8); // mock constant voice audio

  // Bleep from 0.5s to 0.7s
  const processed = applyBleepsToPcm(pcm, sampleRate, [{ start: 0.5, end: 0.7 }]);

  // Before bleep (at 0.2s), audio unchanged
  assert.equal(+processed[Math.round(0.2 * sampleRate)].toFixed(2), 0.8);

  // After bleep (at 1.2s), audio unchanged
  assert.equal(+processed[Math.round(1.2 * sampleRate)].toFixed(2), 0.8);

  // Inside bleep (at 0.6s), should contain bleep tone, not original 0.8 DC
  const bleepSample = processed[Math.round(0.6 * sampleRate)];
  assert.notEqual(bleepSample, 0.8);
});

test('engine/bleep.js: matchesBleepTerm & findWordsToBleep identifies profanities and terms', () => {
  assert.ok(matchesBleepTerm({ w: 'anjing' }, 'curse'));
  assert.ok(matchesBleepTerm({ w: 'FUCK' }, 'curse'));
  assert.ok(matchesBleepTerm({ w: 'IHSG' }, 'ihsg'));
  assert.ok(!matchesBleepTerm({ w: 'halo' }, 'curse'));

  const words = [
    { i: 0, w: 'Halo' },
    { i: 1, w: 'anjing' },
    { i: 2, w: 'semuanya' },
    { i: 3, w: 'shit' },
  ];
  const bleepIndices = findWordsToBleep(words, 'curse');
  assert.deepEqual(bleepIndices, [1, 3]);
});

test('engine/keyframes.js: evalKeyframeTrack handles linear, easing, and clamping', () => {
  // Empty track returns default
  assert.equal(evalKeyframeTrack([], 0.5, 1.0), 1.0);

  // Single keyframe holds value everywhere
  const single = [{ t: 0.5, v: 2.0 }];
  assert.equal(evalKeyframeTrack(single, 0.2), 2.0);
  assert.equal(evalKeyframeTrack(single, 0.8), 2.0);

  // Linear track
  const linear = [
    { t: 0.0, v: 0.0, ease: 'linear' },
    { t: 1.0, v: 10.0, ease: 'linear' },
  ];
  assert.equal(evalKeyframeTrack(linear, 0.0), 0.0);
  assert.equal(evalKeyframeTrack(linear, 0.5), 5.0);
  assert.equal(evalKeyframeTrack(linear, 1.0), 10.0);

  // Eased track
  const eased = [
    { t: 0.0, v: 0.0, ease: 'ease' },
    { t: 1.0, v: 1.0, ease: 'ease' },
  ];
  const mid = evalKeyframeTrack(eased, 0.5);
  assert.ok(Math.abs(mid - 0.5) < 0.05, `Ease midpoint ~0.5, got ${mid}`);
});

test('engine/keyframes.js: evalClipKeyframes evaluates all tracks', () => {
  const clipKfs = {
    scale: [{ t: 0, v: 1 }, { t: 1, v: 2 }],
    x: [{ t: 0, v: -0.2 }, { t: 1, v: 0.2 }],
    y: [],
    opacity: [{ t: 0, v: 0 }, { t: 1, v: 1 }],
  };

  const res = evalClipKeyframes(clipKfs, 0.5);
  assert.ok(res.scale > 1.2 && res.scale < 1.8);
  assert.ok(Math.abs(res.x) < 0.1);
  assert.equal(res.y, 0.0); // default
  assert.ok(res.opacity > 0.3 && res.opacity < 0.7);
});

test('engine/keyframes.js: setKeyframe and removeKeyframe mutates sorted tracks', () => {
  let track = [];
  track = setKeyframe(track, 0.2, 1.5, 'linear');
  track = setKeyframe(track, 0.8, 2.5, 'ease');
  assert.equal(track.length, 2);
  assert.equal(track[0].t, 0.2);
  assert.equal(track[1].t, 0.8);

  // Update existing keyframe near 0.2
  track = setKeyframe(track, 0.21, 1.8, 'ease');
  assert.equal(track.length, 2);
  assert.equal(track[0].v, 1.8);

  // Find keyframe near 0.8
  assert.ok(findKeyframeNear(track, 0.8));

  // Remove keyframe
  track = removeKeyframe(track, 0.8);
  assert.equal(track.length, 1);
  assert.equal(track[0].t, 0.2);
});

test('engine/stickers.js: BUILTIN_EMOJIS registry has 12 items and maps keywords', () => {
  assert.equal(BUILTIN_EMOJIS.length, 12);
  assert.ok(BUILTIN_EMOJIS.includes('📈'));
  assert.ok(BUILTIN_EMOJIS.includes('📉'));
  assert.ok(BUILTIN_EMOJIS.includes('💰'));
  assert.ok(BUILTIN_EMOJIS.includes('🔥'));
  assert.ok(BUILTIN_EMOJIS.includes('⚡'));
  assert.ok(BUILTIN_EMOJIS.includes('✅'));

  const words = [
    { i: 0, w: 'Pasar', start: 1.0 },
    { i: 1, w: 'saham', start: 1.5 },
    { i: 2, w: 'anjlok', start: 2.0 },
    { i: 3, w: 'drastis', start: 2.5 },
    { i: 4, w: 'tapi', start: 3.0 },
    { i: 5, w: 'cuan', start: 3.5 },
  ];

  const suggestions = suggestStickers(words);
  assert.ok(suggestions.length >= 2);
  const chars = suggestions.map((s) => s.char);
  assert.ok(chars.includes('📉'), 'Should suggest down chart for "anjlok"');
  assert.ok(chars.includes('💰') || chars.includes('📈'), 'Should suggest money/growth for "saham" or "cuan"');
});

test('engine/translate.js: buildTranslationMessages & parseTranslationResponse preserves timing', () => {
  const originalWords = [
    { i: 0, w: 'Selamat', start: 0.1, end: 0.5, keep: true },
    { i: 1, w: 'pagi', start: 0.5, end: 0.9, keep: true },
    { i: 2, w: 'semuanya', start: 0.9, end: 1.4, keep: true },
  ];

  const msgs = buildTranslationMessages(originalWords, 'en');
  assert.equal(msgs.length, 2);
  assert.ok(msgs[1].content.includes('0:Selamat'));

  const fakeGlmResponse = JSON.stringify({
    translations: [
      { i: 0, w: 'Good' },
      { i: 1, w: 'morning' },
      { i: 2, w: 'everyone' },
    ],
  });

  const translated = parseTranslationResponse(fakeGlmResponse, originalWords);
  assert.equal(translated.length, 3);
  assert.equal(translated[0].w, 'Good');
  assert.equal(translated[1].w, 'morning');
  assert.equal(translated[2].w, 'everyone');

  // Timings must be strictly identical
  assert.equal(translated[0].start, 0.1);
  assert.equal(translated[0].end, 0.5);
  assert.equal(translated[2].end, 1.4);
});

test('engine/chat-ops.js: handles bleep commands in Indonesian and English', () => {
  const allWords = [
    { i: 0, w: 'Indeks' },
    { i: 1, w: 'IHSG' },
    { i: 2, w: 'sedang' },
    { i: 3, w: 'turun' },
    { i: 4, w: 'anjing' },
  ];

  // Specific word
  const cmdWord = parseChatCommand('bleep kata IHSG', { allWords });
  assert.equal(cmdWord.op, 'bleep-words');
  assert.deepEqual(cmdWord.wordIndices, [1]);

  // Curse words
  const cmdCurse = parseChatCommand('sensor semua kata kasar', { allWords });
  assert.equal(cmdCurse.op, 'bleep-words');
  assert.deepEqual(cmdCurse.wordIndices, [4]);

  // Apply chat op to project
  const mockProj = { words: [...allWords], bleeps: [] };
  const changed = applyChatOp(mockProj, cmdCurse);
  assert.equal(changed, true);
  assert.equal(mockProj.words[4].bleep, true);
  assert.deepEqual(mockProj.bleeps, [4]);
});

test('engine/project-store.js: serialize and apply preserve bgm, bleeps, and translations', () => {
  const p = {
    words: [{ i: 0, w: 'Test', bleep: true }],
    bleeps: [0],
    bgm: { src: 'music.mp3', gainDb: -12, autoDuck: true },
    translations: { en: [{ i: 0, w: 'Test' }] },
    edl: { keep: [], style: {} },
    overrides: { cuts: [], keeps: [] },
    overlays: [],
    settings: {},
  };

  const snap = serializeProjectState(p);
  assert.equal(snap.bgm.src, 'music.mp3');
  assert.deepEqual(snap.bleeps, [0]);
  assert.ok(snap.translations.en);

  const target = { words: [{ i: 0, w: 'Test' }], settings: {} };
  applyProjectSnapshot(target, snap);

  assert.equal(target.bgm.src, 'music.mp3');
  assert.deepEqual(target.bleeps, [0]);
  assert.equal(target.words[0].bleep, true);
  assert.ok(target.translations.en);
});
