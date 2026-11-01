// .cube 3D LUT — parser + nearest-neighbor apply with intensity blend. Pure.

/** parse a .cube (3D) text into { size, data: Float32Array(size³*3) } */
export function parseCube(text) {
  let size = 0;
  const vals = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('LUT_3D_SIZE')) { size = Number(t.split(/\s+/)[1]); continue; }
    if (t.startsWith('LUT_1D') || t.startsWith('DOMAIN_') || t.startsWith('TITLE')) continue;
    const p = t.split(/\s+/).map(Number);
    if (p.length === 3 && p.every(Number.isFinite)) vals.push(p[0], p[1], p[2]);
  }
  if (!size || vals.length !== size * size * size * 3) return null;
  return { size, data: new Float32Array(vals) };
}

/** apply: nearest-neighbor sample of the LUT on ImageData rgb, blended by intensity */
export function applyCubeLut(imageData, lut, intensity = 1) {
  const { size, data } = lut;
  const px = imageData.data;
  const step = 1 / (size - 1);
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const ri = Math.min(size - 1, Math.round((r / 255) / step));
    const gi = Math.min(size - 1, Math.round((g / 255) / step));
    const bi = Math.min(size - 1, Math.round((b / 255) / step));
    // .cube index order: r outer, g middle, b inner — red*step²+green*step+blue
    const idx = (ri * size * size + gi * size + bi) * 3;
    px[i] = r + (data[idx] * 255 - r) * intensity;
    px[i + 1] = g + (data[idx + 1] * 255 - g) * intensity;
    px[i + 2] = b + (data[idx + 2] * 255 - b) * intensity;
  }
  return imageData;
}
