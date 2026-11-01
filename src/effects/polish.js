// Polish — the visual grade pass shared by preview AND export (same canvas ops,
// parity by construction). LUT presets as ctx.filter chains, luma unsharp for HD,
// face-masked blur for skin. Pure helpers export for tests.

import { applyCubeLut } from './lut.js';

export const LUTS = {
  none: null,
  crisp: 'contrast(1.08) saturate(1.05) brightness(1.01)',
  warm: 'sepia(0.18) saturate(1.1) contrast(1.04) brightness(1.03)',
  punch: 'saturate(1.15) contrast(1.12)',
};

/** auto-levels: p2/p98 luminance stretch from a downsampled histogram (pure) */
export function autoLevelsOffsets(histogram, totalPixels) {
  let lo = 0, hi = 255, acc = 0;
  const lowN = totalPixels * 0.02, highN = totalPixels * 0.98;
  for (let i = 0; i < 256; i++) {
    acc += histogram[i];
    if (acc >= lowN) { lo = i; break; }
  }
  acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += histogram[i];
    if (acc >= highN) { hi = i; break; }
  }
  if (hi - lo < 30) return { contrast: 1, brightness: 0 }; // already wide / dark clip
  const stretch = 255 / (hi - lo);
  const contrast = Math.min(1.25, stretch * 0.6 + 0.4);
  const brightness = Math.max(0, Math.min(0.15, -lo / 255 * 0.4));
  return { contrast: +contrast.toFixed(3), brightness: +brightness.toFixed(3) };
}

/** 3x3 luma unsharp kernel amount 0-1 -> filter string is not expressive enough;
 *  the convolution runs on ImageData (applySharpen below) */
export function sharpenKernel(amount) {
  const c = 1 + amount * 4; // center weight 5x at amount=1
  return [0, -1, 0, -1, c, -1, 0, -1, 0];
}

/** apply polish to the full canvas AFTER the video layers are drawn.
 *  polish = { lut, lutMix, sharpen, skinSmooth, autoLevels, _levels } */
export function applyPolish(ctx, w, h, polish, faces, t) {
  if (!polish || ((polish.lut === 'none' && !polish.cubeLut) && !polish.sharpen && !polish.skinSmooth)) return;

  const snapshot = document.createElement('canvas');
  snapshot.width = w; snapshot.height = h;
  const sctx = snapshot.getContext('2d');
  sctx.drawImage(ctx.canvas, 0, 0);

  // 1. skin smoothing: blurred copy composited inside the face ellipse only
  if (polish.skinSmooth > 0 && faces?.length) {
    const face = nearestFace(faces, t);
    if (face) {
      ctx.save();
      ctx.beginPath();
      // face cx/cy/fh are normalized to the source frame
      const rx = face.fh * w * 0.42, ry = face.fh * h * 0.5;
      ctx.ellipse(face.cx * w, face.cy * h, rx, ry, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.filter = `blur(${4 + polish.skinSmooth * 6}px)`;
      ctx.globalAlpha = polish.skinSmooth * 0.85;
      ctx.drawImage(snapshot, 0, 0);
      ctx.restore();
    }
  }

  // 2. sharpen (luma unsharp at half-res, composited back)
  if (polish.sharpen > 0) {
    const half = document.createElement('canvas');
    half.width = Math.max(2, w >> 1); half.height = Math.max(2, h >> 1);
    const hctx = half.getContext('2d');
    hctx.drawImage(ctx.canvas, 0, 0, half.width, half.height);
    convolve(hctx, half.width, half.height, sharpenKernel(polish.sharpen));
    ctx.save();
    ctx.globalAlpha = Math.min(1, 0.35 + polish.sharpen * 0.5);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(half, 0, 0, w, h);
    ctx.restore();
  }

  // 3b. external .cube LUT (full-frame ImageData pass, blended by lutMix)
  if (polish.cubeLut) {
    const img = ctx.getImageData(0, 0, w, h);
    applyCubeLut(img, polish.cubeLut, polish.lutMix ?? 0.65);
    ctx.save();
    ctx.putImageData(img, 0, 0); // cube applies in place at intensity
    ctx.restore();
    return;
  }

  // 3. LUT preset at intensity (draw the snapshot back through the filter, blended)
  const chain = LUTS[polish.lut];
  if (chain) {
    let filter = chain;
    if (polish.autoLevels && polish._levels) {
      filter += ` contrast(${polish._levels.contrast}) brightness(${1 + polish._levels.brightness})`;
    }
    ctx.save();
    ctx.filter = filter;
    ctx.globalAlpha = polish.lutMix ?? 0.65;
    ctx.drawImage(snapshot, 0, 0);
    ctx.restore();
  } else if (polish.autoLevels && polish._levels) {
    ctx.save();
    ctx.filter = `contrast(${polish._levels.contrast}) brightness(${1 + polish._levels.brightness})`;
    ctx.globalAlpha = 0.8;
    ctx.drawImage(snapshot, 0, 0);
    ctx.restore();
  }
}

/** calibrate _levels from the current canvas (call once per file) */
export function calibrateLevels(ctx, w, h) {
  const tiny = document.createElement('canvas');
  tiny.width = 64; tiny.height = 64;
  const tctx = tiny.getContext('2d');
  tctx.drawImage(ctx.canvas, 0, 0, 64, 64);
  const data = tctx.getImageData(0, 0, 64, 64).data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    const l = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    hist[l]++;
  }
  return autoLevelsOffsets(hist, 64 * 64);
}

function nearestFace(faces, t) {
  let best = null, bestD = Infinity;
  for (const f of faces) { const d = Math.abs(f.t - t); if (d < bestD) { bestD = d; best = f; } }
  return bestD < 3 ? best : null;
}

function convolve(ctx2, w, h, kernel) {
  const src = ctx2.getImageData(0, 0, w, h);
  const out = ctx2.createImageData(w, h);
  const s = src.data, d = out.data;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      let r = 0, g = 0, b = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const k = kernel[(ky + 1) * 3 + (kx + 1)];
          const j = ((y + ky) * w + (x + kx)) * 4;
          r += s[j] * k; g += s[j + 1] * k; b += s[j + 2] * k;
        }
      }
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = s[i + 3];
    }
  }
  ctx2.putImageData(out, 0, 0);
}
