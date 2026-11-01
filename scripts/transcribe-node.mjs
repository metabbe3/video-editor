// Node transcription for the long-form test — same model, same windowing and
// overlap rules as lib/transcribe.js, so its output seeds the app's IndexedDB
// window cache and the in-browser flow picks it up as if it transcribed it.
// Usage: node scripts/transcribe-node.mjs <in-16k-mono.wav> <out-words.json>

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pipeline, env } = await import(require.resolve('@huggingface/transformers', { paths: [new URL('./node-deps/node_modules', import.meta.url).pathname] }));

env.allowLocalModels = false;
const WINDOW = 60, OVERLAP = 1, RATE = 16000;
const FILLER_SEED = 'Umm, so, uh, I was like, uhh... Well, you know, I mean, sort of, uh, basically...';

function readWav16k(path) {
  const buf = readFileSync(path);
  // find data chunk (RIFF/fmt assumed 16-bit PCM mono 16k from ffmpeg)
  let off = 12;
  while (off < buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const n = size >> 1;
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return f;
    }
    off += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

const [inPath, outPath] = process.argv.slice(2);
const pcm = readWav16k(inPath);
console.log(`audio: ${(pcm.length / RATE).toFixed(1)}s`);

const asr = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base_timestamped', {
  dtype: 'q8',
  progress_callback: (p) => { if (p.status === 'progress' && p.file?.endsWith?.('.onnx')) console.log(`load ${p.file} ${Math.round(p.progress ?? 0)}%`); },
});

const totalWindows = Math.ceil(pcm.length / (WINDOW * RATE));
const words = [];
for (let w = 0; w < totalWindows; w++) {
  const t0 = Date.now();
  const start = w * WINDOW * RATE;
  const end = Math.min(pcm.length, (w + 1) * WINDOW * RATE + OVERLAP * RATE);
  const out = await asr(pcm.slice(start, end), {
    return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5, initial_prompt: FILLER_SEED,
  });
  const offset = start / RATE;
  const coreEnd = (w + 1) * WINDOW;
  for (const c of out.chunks || []) {
    const wd = { w: (c.text || '').trim(), start: c.timestamp?.[0] + offset, end: c.timestamp?.[1] + offset };
    if (!wd.w || !Number.isFinite(wd.start) || !Number.isFinite(wd.end)) continue;
    const mid = (wd.start + wd.end) / 2;
    if (w > 0 && mid < w * WINDOW + OVERLAP) continue;
    if (w < totalWindows - 1 && mid >= coreEnd - OVERLAP) continue;
    words.push(wd);
  }
  console.log(`window ${w + 1}/${totalWindows} in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${words.length} words so far`);
}

words.sort((a, b) => a.start - b.start);
writeFileSync(outPath, JSON.stringify(words));
console.log(`done: ${words.length} words -> ${outPath}`);
