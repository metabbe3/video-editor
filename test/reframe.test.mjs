import test from 'node:test';
import assert from 'node:assert/strict';
import { cropRectForFace, applyManual, smoothFaceTrack, reframeAt, DEFAULT_MANUAL } from '../engine/reframe.js';

const A = 9 / 16;        // target 1080x1920
const SRC_16_9 = 16 / 9; // e.g. 640x360

test('cropRectForFace: rect matches target aspect and frames the face', () => {
  const face = { t: 0, cx: 0.5, cy: 0.5, fh: 0.25 };
  const c = cropRectForFace(face, A, SRC_16_9);
  // visible aspect (in source pixels) == target aspect
  assert.ok(Math.abs((c.w * SRC_16_9) / c.h - A) < 1e-9);
  // face height 0.25 / faceFill 0.34 -> vh ~0.735
  assert.ok(Math.abs(c.h - 0.735) < 0.01);
  assert.ok(c.x >= 0 && c.x + c.w <= 1 && c.y >= 0 && c.y + c.h <= 1);
  // eyes near eyeLine: face center sits at eyeLine*vh below crop top
  assert.ok(Math.abs((face.cy - c.y) / c.h - 0.4) < 0.02 || c.y === 0 || c.y + c.h === 1);
});

test('cropRectForFace: off-center face clamps inside the source', () => {
  for (const f of [{ cx: 0.01, cy: 0.05, fh: 0.3 }, { cx: 0.99, cy: 0.98, fh: 0.9 }]) {
    const c = cropRectForFace({ t: 0, ...f }, A, SRC_16_9);
    assert.ok(c.x >= 0 && c.x + c.w <= 1.0001, JSON.stringify(c));
    assert.ok(c.y >= 0 && c.y + c.h <= 1.0001, JSON.stringify(c));
  }
});

test('applyManual default on 16:9 source equals center cover crop', () => {
  const c = applyManual(null, DEFAULT_MANUAL, A, SRC_16_9);
  // cover: full height, centered width slice of aspect A
  assert.equal(c.h, 1);
  assert.ok(Math.abs(c.x - (1 - c.w) / 2) < 1e-9);
  assert.ok(Math.abs((c.w * SRC_16_9) / c.h - A) < 1e-9);
});

test('applyManual zoom>1 shrinks the visible rect around the same center', () => {
  const base = applyManual(null, DEFAULT_MANUAL, A, SRC_16_9);
  const z = applyManual(null, { zoom: 2, px: 0, py: 0 }, A, SRC_16_9);
  assert.ok(z.w < base.w && z.h < base.h);
  assert.ok(Math.abs(z.x + z.w / 2 - (base.x + base.w / 2)) < 1e-9);
});

test('applyManual pan shifts and clamps', () => {
  const p = applyManual(null, { zoom: 2, px: 10, py: 10 }, A, SRC_16_9);
  assert.equal(p.x, 1 - p.w); // clamped to the right edge
  assert.equal(p.y, 1 - p.h);
});

test('smoothFaceTrack: median kills a one-sample jump, gaps fill, ends drop', () => {
  const dt = 0.5;
  const raw = [];
  for (let i = 0; i < 10; i++) {
    raw.push({ t: i * dt, cx: 0.5, cy: 0.5, fh: 0.25 });
  }
  raw[5] = { t: 5 * dt, cx: 0.95, cy: 0.1, fh: 0.6 }; // jitter spike
  const s = smoothFaceTrack(raw, dt);
  const mid = s.find((p) => Math.abs(p.t - 2.5) < 1e-6);
  assert.ok(Math.abs(mid.cx - 0.5) < 1e-6, `median failed: ${mid.cx}`);
  // gap fill (2 missing samples = 1s <= 1.5s)
  const gapped = raw.map((p, i) => (i === 3 || i === 4 ? null : p));
  const g = smoothFaceTrack(gapped, dt);
  assert.equal(g.length, 10);
  const fill = g.find((p) => Math.abs(p.t - 1.5) < 1e-6);
  assert.ok(Math.abs(fill.cx - 0.5) < 1e-6);
});

test('reframeAt interpolates between keyframes and holds at ends', () => {
  const faces = [
    { t: 0, cx: 0.3, cy: 0.4, fh: 0.3 },
    { t: 2, cx: 0.7, cy: 0.6, fh: 0.3 },
  ];
  const c0 = reframeAt(faces, 0.5, DEFAULT_MANUAL, A, SRC_16_9);
  const faceAt05 = { t: 0.5, cx: 0.4, cy: 0.45, fh: 0.3 };
  const expect = cropRectForFace(faceAt05, A, SRC_16_9);
  assert.ok(Math.abs(c0.x - expect.x) < 1e-9 && Math.abs(c0.y - expect.y) < 1e-9);
  const before = reframeAt(faces, -1, DEFAULT_MANUAL, A, SRC_16_9);
  assert.deepEqual(before, applyManual(cropRectForFace(faces[0], A, SRC_16_9), DEFAULT_MANUAL, A, SRC_16_9));
  // no faces: cover default
  const cover = reframeAt([], 1, DEFAULT_MANUAL, A, SRC_16_9);
  assert.equal(cover.h, 1);
});
