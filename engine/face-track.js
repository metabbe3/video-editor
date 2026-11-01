// Face track — MediaPipe face detection over the KEPT segments only (sampled
// on the edited timeline, 2 fps). Returns normalized keyframes for reframe.js.
// Browser-only module (CDN imports); the math is in lib/reframe.js (node-safe).

import { FaceDetector, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0';
import { Input, ALL_FORMATS, BlobSource, VideoSampleSink } from 'https://cdn.jsdelivr.net/npm/mediabunny@1.64.0/+esm';
import { smoothFaceTrack } from './reframe.js';
import { buildTimeline } from './timeline.js';

let detector = null;
async function getDetector() {
  if (detector) return detector;
  const fileset = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm');
  detector = await FaceDetector.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
      delegate: 'GPU',
    },
    runningMode: 'IMAGE',
    minDetectionConfidence: 0.4,
  });
  return detector;
}

const scratch = document.createElement('canvas');
const SCRATCH_W = 320;

/**
 * Sample faces along the edited timeline. getFile(srcId) -> File.
 * Returns smoothed keyframes [{t, cx, cy, fh}] (normalized to source frame).
 */
export async function sampleFaceTrack(edl, getFile, { fps = 2, onProgress } = {}) {
  const det = await getDetector();
  const tl = buildTimeline(edl.keep, { fps: edl.style.fps });
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(getFile(edl.style.arollId)) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) return [];
  const sink = new VideoSampleSink(track);
  const first = await sink.getSample(0);
  const sw = first?.displayWidth || first?.codedWidth || 1080;
  const sh = first?.displayHeight || first?.codedHeight || 1920;
  first?.close?.();

  const dt = 1 / fps;
  const steps = Math.max(1, Math.ceil(tl.duration / dt));
  const raw = [];
  for (let i = 0; i <= steps; i++) {
    const t = Math.min(tl.duration - 0.01, i * dt);
    if (t < 0) break;
    const src = tl.editedToSource(t)?.src ?? 0;
    const sample = await sink.getSample(src);
    if (!sample) { raw.push(null); continue; }
    const vf = sample.toVideoFrame ? sample.toVideoFrame() : sample;
    const h = Math.max(2, Math.round((SCRATCH_W * sh) / sw));
    scratch.width = SCRATCH_W; scratch.height = h;
    const c2 = scratch.getContext('2d', { willReadFrequently: true });
    c2.drawImage(vf, 0, 0, SCRATCH_W, h);
    vf.close?.();
    const res = det.detect(scratch);
    const d = pickFace(res?.detections);
    raw.push(d ? {
      t,
      cx: (d.boundingBox.originX + d.boundingBox.width / 2) / SCRATCH_W,
      cy: (d.boundingBox.originY + d.boundingBox.height / 2) / h,
      fh: d.boundingBox.height / h,
    } : null);
    if ((i & 7) === 0) onProgress?.(i / steps);
  }
  return smoothFaceTrack(raw, dt);
}

/** biggest-score face, mildly preferring faces near the previous center of screen */
function pickFace(dets) {
  if (!dets?.length) return null;
  return dets.reduce((best, d) => {
    const score = (d.boundingBox?.width || 0) * (d.boundingBox?.height || 0) * (d.categories?.[0]?.score ?? 1);
    const bestScore = (best.boundingBox?.width || 0) * (best.boundingBox?.height || 0) * (best.categories?.[0]?.score ?? 1);
    return score > bestScore ? d : best;
  });
}
