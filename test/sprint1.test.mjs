// sprint1.test.mjs — unit tests for Sprint 1 logic:
// speed curve interp, fade envelope, cropRect normalize, project-store roundtrip,
// rotate/flip, adjust filter, platform presets.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evalSpeedCurve, speedCurveDuration, SPEED_CURVE_PRESETS,
  clipFadeGain, normalizeCropRect, nextRotate,
  buildAdjustFilter, applyTemperatureOverlay,
  PLATFORM_EXPORT_PRESETS,
} from '../engine/clip-ops.js';
import {
  makeProjectKey, saveProject, loadProject, deleteProject,
  serializeProjectState, applyProjectSnapshot,
} from '../engine/project-store.js';

test('speedCurve interp: evaluates linear segments, clamps boundaries', () => {
  const curve = [
    { t: 0, v: 0.5 },
    { t: 0.5, v: 2.0 },
    { t: 1.0, v: 1.0 },
  ];

  // boundaries
  assert.equal(evalSpeedCurve(curve, 0), 0.5);
  assert.equal(evalSpeedCurve(curve, 0.5), 2.0);
  assert.equal(evalSpeedCurve(curve, 1.0), 1.0);

  // interpolation
  assert.equal(evalSpeedCurve(curve, 0.25), 1.25);
  assert.equal(evalSpeedCurve(curve, 0.75), 1.5);

  // clamp out of bounds
  assert.equal(evalSpeedCurve(curve, -0.5), 0.5);
  assert.equal(evalSpeedCurve(curve, 1.5), 1.0);

  // fallback on empty/null curve
  assert.equal(evalSpeedCurve(null, 0.5), 1);
  assert.equal(evalSpeedCurve([], 0.5), 1);
});

test('speedCurve presets: all presets valid with at least 2 points within [0.25, 4]', () => {
  for (const [name, pts] of Object.entries(SPEED_CURVE_PRESETS)) {
    assert.ok(Array.isArray(pts) && pts.length >= 2, `${name} has at least 2 points`);
    assert.equal(pts[0].t, 0, `${name} starts at t=0`);
    assert.equal(pts[pts.length - 1].t, 1, `${name} ends at t=1`);
    for (const p of pts) {
      assert.ok(p.t >= 0 && p.t <= 1, `${name} t=${p.t} in [0, 1]`);
      assert.ok(p.v >= 0.25 && p.v <= 4, `${name} v=${p.v} in [0.25, 4]`);
    }
  }
});

test('speedCurve duration: calculates exact integrated duration', () => {
  // Constant speed curve: 10s source at 2x should take 5s edited
  const const2x = [{ t: 0, v: 2.0 }, { t: 1.0, v: 2.0 }];
  const dur2x = speedCurveDuration(10, const2x);
  assert.ok(Math.abs(dur2x - 5.0) < 1e-3, `expected 5.0s, got ${dur2x}`);

  // Constant speed curve: 10s source at 0.5x should take 20s edited
  const constHalf = [{ t: 0, v: 0.5 }, { t: 1.0, v: 0.5 }];
  const durHalf = speedCurveDuration(10, constHalf);
  assert.ok(Math.abs(durHalf - 20.0) < 1e-3, `expected 20.0s, got ${durHalf}`);

  // Linear ramp: 1x to 2x over 10s source:
  // integral of 1 / (1 + x) from 0 to 1 times 10 = 10 * ln(2) ~= 6.931s
  const ramp = [{ t: 0, v: 1.0 }, { t: 1.0, v: 2.0 }];
  const durRamp = speedCurveDuration(10, ramp);
  assert.ok(Math.abs(durRamp - 10 * Math.log(2)) < 0.05, `ramp duration matches integral: ${durRamp}`);
});

test('fade envelope: ramps fadeIn from 0 to 1, stays at 1, ramps fadeOut from 1 to 0', () => {
  const playLen = 10;
  const fadeIn = 2; // 2s
  const fadeOut = 2; // 2s

  // At start (t=0): gain is 0
  assert.equal(clipFadeGain(0, playLen, fadeIn, fadeOut), 0);

  // Midway through fade-in (t=1): gain is 0.5
  assert.equal(clipFadeGain(1, playLen, fadeIn, fadeOut), 0.5);

  // Fully faded in (t=2): gain is 1.0
  assert.equal(clipFadeGain(2, playLen, fadeIn, fadeOut), 1.0);

  // Middle plateau (t=5): gain is 1.0
  assert.equal(clipFadeGain(5, playLen, fadeIn, fadeOut), 1.0);

  // Start of fade-out (t=8): gain is 1.0
  assert.equal(clipFadeGain(8, playLen, fadeIn, fadeOut), 1.0);

  // Midway through fade-out (t=9): gain is 0.5
  assert.equal(clipFadeGain(9, playLen, fadeIn, fadeOut), 0.5);

  // End of clip (t=10): gain is 0.0
  assert.equal(clipFadeGain(10, playLen, fadeIn, fadeOut), 0);

  // Outside bounds returns 0
  assert.equal(clipFadeGain(-1, playLen, fadeIn, fadeOut), 0);
  assert.equal(clipFadeGain(11, playLen, fadeIn, fadeOut), 0);

  // Zero fade always returns 1
  assert.equal(clipFadeGain(0, playLen, 0, 0), 1);
  assert.equal(clipFadeGain(5, playLen, 0, 0), 1);
  assert.equal(clipFadeGain(10, playLen, 0, 0), 1);
});

test('cropRect normalize: clamps values within [0, 1] and enforces minimum bounds', () => {
  // Clean rect passes through
  const clean = normalizeCropRect({ x: 0.1, y: 0.2, w: 0.5, h: 0.6 });
  assert.deepEqual(clean, { x: 0.1, y: 0.2, w: 0.5, h: 0.6 });

  // Out of bounds clamped
  const outBounds = normalizeCropRect({ x: -0.2, y: -0.5, w: 1.5, h: 2.0 });
  assert.deepEqual(outBounds, { x: 0, y: 0, w: 1, h: 1 });

  // Overflows right/bottom pushed inside
  const overflow = normalizeCropRect({ x: 0.8, y: 0.7, w: 0.5, h: 0.5 });
  assert.ok(overflow.x + overflow.w <= 1.0001);
  assert.ok(overflow.y + overflow.h <= 1.0001);

  // Null/empty defaults to full frame
  assert.deepEqual(normalizeCropRect(null), { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(normalizeCropRect({}), { x: 0, y: 0, w: 1, h: 1 });
});

test('rotate steps: nextRotate cycles 0 -> 90 -> 180 -> 270 -> undefined', () => {
  assert.equal(nextRotate(0), 90);
  assert.equal(nextRotate(90), 180);
  assert.equal(nextRotate(180), 270);
  assert.equal(nextRotate(270), undefined); // resets to 0 (undefined in EDL)
  assert.equal(nextRotate(undefined), 90);
});

test('color adjust: builds ctx.filter string and handles warm/cool temperature', () => {
  // Neutral produces empty string
  assert.equal(buildAdjustFilter({ brightness: 0, contrast: 0, saturation: 0 }), '');
  assert.equal(buildAdjustFilter(null), '');

  // Positive values
  const filterPos = buildAdjustFilter({ brightness: 10, contrast: 20, saturation: 30 });
  assert.ok(filterPos.includes('brightness(1.100)'));
  assert.ok(filterPos.includes('contrast(1.200)'));
  assert.ok(filterPos.includes('saturate(1.300)'));

  // Negative values
  const filterNeg = buildAdjustFilter({ brightness: -20, contrast: -10, saturation: -50 });
  assert.ok(filterNeg.includes('brightness(0.800)'));
  assert.ok(filterNeg.includes('contrast(0.900)'));
  assert.ok(filterNeg.includes('saturate(0.500)'));

  // Temperature overlay mockup test
  const drawn = [];
  const fakeCtx = {
    save() { drawn.push('save'); },
    restore() { drawn.push('restore'); },
    fillRect(...args) { drawn.push(['fillRect', ...args]); },
    globalCompositeOperation: '',
    fillStyle: '',
  };

  applyTemperatureOverlay(fakeCtx, 1080, 1920, 50); // warm
  assert.equal(fakeCtx.globalCompositeOperation, 'overlay');
  assert.ok(fakeCtx.fillStyle.includes('255, 140, 0')); // amber

  applyTemperatureOverlay(fakeCtx, 1080, 1920, -50); // cool
  assert.ok(fakeCtx.fillStyle.includes('0, 140, 255')); // blue

  // Zero temperature no-ops
  drawn.length = 0;
  applyTemperatureOverlay(fakeCtx, 1080, 1920, 0);
  assert.equal(drawn.length, 0);
});

test('platform presets: tiktok, shorts, reels, square, youtube are defined and complete', () => {
  const expected = ['tiktok', 'shorts', 'reels', 'square', 'youtube'];
  for (const id of expected) {
    const p = PLATFORM_EXPORT_PRESETS[id];
    assert.ok(p, `preset ${id} exists`);
    assert.ok(p.label && typeof p.label === 'string');
    assert.ok(['9:16', '16:9', '1:1'].includes(p.orientation));
    assert.ok(p.resolution >= 720);
    assert.ok(p.fps === 30 || p.fps === 60);
    assert.ok(p.quality > 0 && p.quality <= 0.15);
  }
});

test('project-store roundtrip with fake IndexedDB', async () => {
  // In-memory fake IndexedDB mock
  function createFakeIdb() {
    const stores = new Map();
    return {
      open(dbName, version) {
        const req = {
          result: {
            objectStoreNames: {
              contains: (name) => stores.has(name),
            },
            createObjectStore(name) {
              stores.set(name, new Map());
            },
            transaction(name, mode) {
              const store = stores.get(name);
              return {
                objectStore() {
                  return {
                    put(value, key) {
                      store.set(key, value);
                      const r = { result: key };
                      setTimeout(() => r.onsuccess?.(), 0);
                      return r;
                    },
                    get(key) {
                      const r = { result: store.get(key) || null };
                      setTimeout(() => r.onsuccess?.(), 0);
                      return r;
                    },
                    delete(key) {
                      store.delete(key);
                      const r = { result: undefined };
                      setTimeout(() => r.onsuccess?.(), 0);
                      return r;
                    },
                  };
                },
              };
            },
          },
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
        };
        setTimeout(() => {
          req.onupgradeneeded?.();
          req.onsuccess?.();
        }, 0);
        return req;
      },
    };
  }

  const fakeIdb = createFakeIdb();
  const key = makeProjectKey('video.mp4', 1234567);
  assert.equal(key, 'video.mp4:1234567');

  const snapshot = {
    edl: {
      keep: [
        { in: 0, out: 5, rotate: 90, flipH: true, fadeIn: 300, fadeOut: 500 },
        { in: 6, out: 12, speedCurve: [{ t: 0, v: 1 }, { t: 1, v: 2 }] },
      ],
      style: { fit: 'blur-pad', adjust: { brightness: 10, contrast: 5, saturation: 0, temperature: 15 } },
    },
    words: [{ w: 'hello', start: 0.1, end: 0.5 }],
    settings: { fit: 'blur-pad', orientation: '9:16' },
  };

  // 1. Save snapshot
  const saved = await saveProject(key, snapshot, fakeIdb);
  assert.equal(saved, true);

  // 2. Load snapshot
  const loaded = await loadProject(key, fakeIdb);
  assert.ok(loaded);
  assert.equal(loaded.key, key);
  assert.equal(loaded.edl.keep[0].rotate, 90);
  assert.equal(loaded.edl.keep[0].flipH, true);
  assert.equal(loaded.edl.keep[0].fadeIn, 300);
  assert.equal(loaded.edl.keep[1].speedCurve[1].v, 2);
  assert.equal(loaded.edl.style.fit, 'blur-pad');
  assert.equal(loaded.edl.style.adjust.temperature, 15);

  // 3. Round-trip state serialization & restoration
  const mockProject = {
    edl: loaded.edl,
    words: loaded.words,
    baseKeeps: null,
    overrides: { cuts: [], keeps: [] },
    overlays: [{ text: 'Title', t0: 0, t1: 3 }],
    settings: loaded.settings,
    variants: null,
    activeVariant: 0,
    glmResult: null,
    useGlm: false,
  };

  const serialized = serializeProjectState(mockProject);
  assert.ok(serialized);
  assert.equal(serialized.overlays[0].text, 'Title');

  const freshProject = {
    edl: null, words: null, settings: {}, overrides: { cuts: [], keeps: [] }, overlays: [],
  };
  const restored = applyProjectSnapshot(freshProject, serialized);
  assert.equal(restored, true);
  assert.equal(freshProject.edl.keep.length, 2);
  assert.equal(freshProject.words[0].w, 'hello');
  assert.equal(freshProject.overlays[0].text, 'Title');
  assert.equal(freshProject.settings.fit, 'blur-pad');

  // 4. Delete snapshot
  const deleted = await deleteProject(key, fakeIdb);
  assert.equal(deleted, true);
  const afterDelete = await loadProject(key, fakeIdb);
  assert.equal(afterDelete, null);
});
