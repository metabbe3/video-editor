// Analyze — ranged audio decode -> 16 kHz mono PCM -> windowed RMS energy.
// The SAME 16k buffer feeds Whisper and the energy map, so word timestamps and
// silence boundaries share one timebase by construction (file-absolute seconds).

import { Input, ALL_FORMATS, BlobSource, AudioBufferSink } from 'https://cdn.jsdelivr.net/npm/mediabunny@1.64.0/+esm';

export const STT_RATE = 16000;

export async function analyzeAudio(file, onProgress) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error('No audio track in the A-roll file.');
  const duration = await input.computeDuration();

  const sink = new AudioBufferSink(track);
  const pcm = new Float32Array(Math.ceil(duration * STT_RATE) + STT_RATE);
  // NOTE: files with edit-list/AAC priming can carry NEGATIVE buffer timestamps —
  // clamp before set() or the whole analyze crashes (found via the ogg-sourced fixture)
  const setAt = (arr, at) => {
    const a = Math.max(0, at | 0);
    if (a >= pcm.length) return;
    const take = Math.min(arr.length, pcm.length - a);
    if (take > 0) pcm.set(arr.subarray(0, take), a);
  };

  // NOTE: end must be a real duration — `Infinity` truncates the stream on long files
  for await (const { buffer, timestamp } of sink.buffers(0, duration)) {
    const at = Math.round(timestamp * STT_RATE); // integer sample cursor — no drift
    if (at >= pcm.length) break;
    setAt(resampleMonoTo(buffer, STT_RATE), at);
    onProgress?.(Math.min(1, timestamp / duration));
  }

  // windowed RMS, ~20ms hop
  const hop = Math.round(STT_RATE * 0.02);
  const energy = new Float32Array(Math.max(1, Math.floor(pcm.length / hop)));
  for (let b = 0; b < energy.length; b++) {
    let s = 0;
    const end = Math.min(pcm.length, (b + 1) * hop);
    for (let i = b * hop; i < end; i++) s += pcm[i] * pcm[i];
    energy[b] = Math.sqrt(s / Math.max(1, end - b * hop));
  }
  return { pcm, energy, hopSec: hop / STT_RATE, duration, sampleRate: STT_RATE };
}

/** downmix to mono + linear resample to `rate` (16k for STT, 48k for the export program) */
export function resampleMonoTo(buffer, rate) {
  const ch = buffer.numberOfChannels;
  const src = buffer.getChannelData(0);
  const n = buffer.length;
  if (ch === 1 && buffer.sampleRate === rate) return src.slice();
  const outN = Math.round((n * rate) / buffer.sampleRate);
  const out = new Float32Array(outN);
  const chs = [];
  for (let c = 0; c < ch; c++) chs.push(buffer.getChannelData(c));
  for (let i = 0; i < outN; i++) {
    const pos = (i * buffer.sampleRate) / rate;
    const i0 = Math.min(n - 1, Math.floor(pos));
    const i1 = Math.min(n - 1, i0 + 1);
    const f = pos - i0;
    let v = 0;
    for (const c of chs) v += c[i0] * (1 - f) + c[i1] * f;
    out[i] = v / chs.length;
  }
  return out;
}
