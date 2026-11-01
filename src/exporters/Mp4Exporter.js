// Export — the exporter consumes the SAME drawFrame as the preview.
// Audio: sample-exact cuts at native resolution (48k mono program), 12ms join
// fades, BS.1770 LUFS normalize with peak safety. Video: per-output-frame
// VideoSampleSink decode (monotonic within segments) -> drawFrame -> avc.

import {
  Input, ALL_FORMATS, BlobSource, AudioBufferSink, VideoSampleSink,
  Output, Mp4OutputFormat, CanvasSource, AudioBufferSource, Quality, StreamTarget, BufferTarget,
} from 'https://cdn.jsdelivr.net/npm/mediabunny@1.64.0/+esm';
import { timelineOf } from '../core/Compositor.js';
import { arollLayers } from '../elements/VideoLayer.js';
import { TUNING } from '../../engine/edit-engine.js';
import { computeDuckEnvelope, renderSfx, audioInFor } from '../core/AudioMix.js';
import { resampleMonoTo } from '../../engine/analyze.js';
import { clipFadeGain, evalSpeedCurve } from '../../engine/clip-ops.js';

export async function exportVideo({ edl, getFile, canvas, compositor, onProgress, qualityFactor = 0.1, gainDb = 0, sfx = false }) {
  const tl = timelineOf(edl);
  const { fps, w: outW, h: outH } = edl.style;
  const RATE = 48000;
  // bits/pixel/frame: High 0.10 / Balanced 0.075 / Light 0.05 (research-verified ladder)
  const bitrate = outW * outH * fps * qualityFactor;

  // ---- audio program ----
  const aInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(getFile(edl.style.arollId)) });
  const aTrack = await aInput.getPrimaryAudioTrack();
  let program = null;
  if (aTrack) program = await assembleProgram(aTrack, tl, RATE, onProg(onProgress, 'audio'), { jCuts: edl.style.jCuts !== false, edl });
  if (program) {
    applyJoinFades(program, tl, RATE);
    // Mastering chain, memory-bounded (≤2 full-length arrays for a 30-min edit):
    // HPF and compression run IN PLACE; LUFS is measured by streaming
    // K-weighted blocks; gain applied in place. HPF -> comp -> measure -> gain.
    hp80InPlace(program, RATE);
    compressInPlace(program, RATE);
    const { gainDb: lufsDb } = loudnessGainStreaming(program, RATE);
    const gain = 10 ** ((lufsDb + gainDb) / 20);
    // data-driven SFX (post-measure so LUFS stays speech-anchored)
    if (edl.sfx?.length) {
      for (const e of edl.sfx) {
        const buf = renderSfx(e.kind, RATE, e.gainDb);
        const at = Math.round(e.at * RATE);
        for (let i = 0; i < buf.length && at + i < program.length; i++) program[at + i] += buf[i] * gain;
      }
      let pk = 0;
      for (let i = 0; i < program.length; i++) pk = Math.max(pk, Math.abs(program[i]));
      if (pk > 0.98) for (let i = 0; i < program.length; i++) program[i] *= 0.98 / pk;
    }
    if (Math.abs(gain - 1) > 0.001) for (let i = 0; i < program.length; i++) program[i] *= gain;
  }

  // BGM bed: loop the file under the mastered program at the ducking envelope
  // (post-LUFS so loudness stays speech-anchored, same rationale as SFX)
  if (edl.bgm?.src && program) {
    try {
      const bInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(getFile(edl.bgm.src)) });
      const bTrack = await bInput.getPrimaryAudioTrack();
      if (bTrack) {
        const bSink = new AudioBufferSink(bTrack);
        const bed = new Float32Array(program.length);
        let cursor = 0;
        while (cursor < program.length) {
          const chunk = Math.min(program.length - cursor, RATE * 30);
          for await (const { buffer } of bSink.buffers(0, chunk / RATE + 0.1)) {
            const mono = resampleMonoTo(buffer, RATE);
            for (let i = 0; i < mono.length && cursor < program.length; i++, cursor++) bed[cursor] = mono[i];
          }
          if (cursor < program.length) break; // single pass covers the edit via loop: restart sink
          break;
        }
        const env = computeDuckEnvelope(edl.words || [], tl, {});
        const base = 10 ** ((edl.bgm.gainDb ?? -20) / 20);
        for (let i = 0; i < program.length; i++) {
          const g = base * (env[Math.min(env.length - 1, Math.floor((i / RATE) / 0.05))] ?? 0.3);
          program[i] += bed[i % bed.length] * g;
        }
        let pk = 0;
        for (let i = 0; i < program.length; i++) pk = Math.max(pk, Math.abs(program[i]));
        if (pk > 0.98) for (let i = 0; i < program.length; i++) program[i] *= 0.98 / pk;
      }
    } catch (e) { console.warn('bgm mix skipped:', e.message); }
  }

  // Audio overlays (voiceover): mix into program at specified edited start time
  if (edl.audioOverlays?.length && program) {
    for (const ao of edl.audioOverlays) {
      try {
        const file = getFile(ao.src);
        if (!file) continue;
        const voInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
        const voTrack = await voInput.getPrimaryAudioTrack();
        if (voTrack) {
          const voSink = new AudioBufferSink(voTrack);
          let cursor = Math.round(ao.at * RATE);
          const vol = ao.volume ?? 1;
          for await (const { buffer } of voSink.buffers(0, ao.dur || 3600)) {
            const mono = resampleMonoTo(buffer, RATE);
            for (let i = 0; i < mono.length && cursor < program.length; i++, cursor++) {
              program[cursor] += mono[i] * vol;
            }
            if (cursor >= program.length) break;
          }
        }
      } catch (e) { console.warn('audioOverlay mix skipped:', e.message); }
    }
    let pk = 0;
    for (let i = 0; i < program.length; i++) pk = Math.max(pk, Math.abs(program[i]));
    if (pk > 0.98) for (let i = 0; i < program.length; i++) program[i] *= 0.98 / pk;
  }

  // ---- output target: stream to disk when possible, else buffer+download ----
  let target, handle = null;
  if (typeof showSaveFilePicker === 'function') {
    handle = await showSaveFilePicker({
      suggestedName: 'fyp-edit.mp4',
      types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
    });
    target = new StreamTarget(await handle.createWritable());
  } else {
    target = new BufferTarget();
  }

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const vsrc = new CanvasSource(canvas, { codec: 'avc', quality: new Quality({ bitrate }) });
  output.addVideoTrack(vsrc, { frameRate: fps });

  let asrc = null, audioBuffer = null;
  if (program) {
    const ac = new AudioContext({ sampleRate: RATE });
    audioBuffer = ac.createBuffer(1, program.length, RATE);
    audioBuffer.copyToChannel(program, 0);
    await ac.close();
    for (const codec of ['aac', 'opus']) {
      try { asrc = new AudioBufferSource({ codec, quality: new Quality({ bitrate: 96e3 }) }); output.addAudioTrack(asrc); break; }
      catch { asrc = null; }
    }
  }

  await output.start();
  if (asrc && audioBuffer) { await asrc.add(audioBuffer); asrc.close(); }

  // ---- video frames ----
  const ctx = canvas.getContext('2d');
  const sinks = new Map();     // `${srcId}#${parity}` -> VideoSampleSink (parity = seg%2,
  const lastFrame = new Map(); // so both sides of a crossfade decode monotonically)
  const getSink = async (srcId, parity = 0) => {
    const key = `${srcId}#${parity}`;
    if (!sinks.has(key)) {
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(getFile(srcId)) });
      const track = await input.getPrimaryVideoTrack();
      sinks.set(key, track ? new VideoSampleSink(track) : null);
    }
    return sinks.get(key);
  };
  const assets = { arollId: edl.style.arollId, frame: () => null };
  for (let i = 0; i < tl.frameCount; i++) {
    const t = tl.frameTime(i);
    const slot = (edl.broll || []).find((b) => t >= b.at && t < b.at + b.dur);
    const drawable = slot
      ? await resolveDrawable(slot.src, (t - slot.at) + (slot.srcIn || 0), { getSink, getFile, parity: 0 }, lastFrame)
      : await resolveAroll(t, { getSink, getFile, tl, edl }, lastFrame, assets);
    if (slot) assets.frame = () => drawable;
    compositor.renderFrame(ctx, t, edl, assets);
    vsrc.add(t, 1 / fps);
    if ((i & 15) === 0) {
      onProg(onProgress, 'video')(i / tl.frameCount);
      await new Promise((r) => setTimeout(r)); // keep the UI alive
    }
  }

  await output.finalize();
  if (!handle && target.buffer) {
    const url = URL.createObjectURL(new Blob([target.buffer], { type: 'video/mp4' }));
    window.__lastExportUrl = url; // e2e hook: lets the test probe the MP4 in-page
    const a = Object.assign(document.createElement('a'), { href: url, download: 'fyp-edit.mp4' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  onProgress?.({ stage: 'done' });
}

/** resolve every A-roll layer for output time t (parity sinks per segment) */
async function resolveAroll(t, env, lastFrame, assets) {
  const { edl, tl } = env;
  const layers = arollLayers(t, edl, tl);
  const map = new Map();
  for (const L of layers) {
    const seg = tl.segmentIndexAtSource(L.srcTime);
    const drawable = await resolveDrawable(
      edl.style.arollId, L.srcTime, { ...env, parity: seg == null ? 0 : seg % 2 }, lastFrame,
    );
    if (drawable) map.set(L.srcTime, drawable);
  }
  assets.frame = (srcId, srcTime) => map.get(srcTime) ?? lastFrame.get(`${srcId}#a`) ?? null;
  return layers.length;
}

async function resolveDrawable(srcId, srcTime, { getSink, getFile, parity = 0 }, lastFrame) {
  if (/\.(jpe?g|png|webp|gif)$/i.test(srcId)) {
    if (!lastFrame.has(srcId)) lastFrame.set(srcId, await createImageBitmap(await getFile(srcId)));
    return lastFrame.get(srcId);
  }
  const memoKey = `${srcId}#${parity}#memo`; // freeze frames ask for the same srcTime repeatedly
  const memo = lastFrame.get(memoKey);
  if (memo && Math.abs(memo.srcTime - srcTime) < 1e-9) return memo.drawable;
  const sink = await getSink(srcId, parity);
  if (sink) {
    const sample = await sink.getSample(srcTime);
    if (sample) {
      const drawable = sample.toVideoFrame ? sample.toVideoFrame() : sample; // VideoFrame is canvas-drawable
      lastFrame.set(`${srcId}#a`, drawable);
      lastFrame.set(memoKey, { srcTime, drawable });
      // earlier samples in the fallback slot are done — close to satisfy mediabunny's GC contract
      const prev = lastFrame.get(`${srcId}#prev`);
      if (prev && prev !== drawable) { prev.close?.(); }
      lastFrame.set(`${srcId}#prev`, drawable);
      return drawable;
    }
  }
  return lastFrame.get(`${srcId}#a`) || null;
}

async function assembleProgram(track, tl, rate, onProgress, opts = {}) {
  const { jCuts = true, edl } = opts;
  const sink = new AudioBufferSink(track);
  const lengths = tl.segments.map((s) => Math.round(s.dur * rate)); // dur includes freeze tails
  const out = new Float32Array(lengths.reduce((a, b) => a + b, 0)); // zero-filled: freeze stays silent
  let cursor = 0;
  for (let i = 0; i < tl.segments.length; i++) {
    const s = tl.segments[i];
    const spd = s.rate || 1;
    const curve = s.speedCurve;
    const k = edl?.keep?.[i];
    const fadeInSec = (k?.fadeIn || 0) / 1000;
    const fadeOutSec = (k?.fadeOut || 0) / 1000;
    const playLen = (s.out - s.in) / spd;

    // J-cut: audio leads picture on tight joins (only at native speed — a lead
    // span resampled by spd would drift; revisit if J-cut + retime matters)
    const aIn = jCuts && edl && spd === 1 && !curve ? audioInFor(edl.keep, i) : s.in;
    let got = 0, chunkOff = 0, srcPos = 0;
    try {
      for await (const { buffer } of sink.buffers(aIn, s.out)) {
        const mono = resampleMonoTo(buffer, rate);
        while (got < lengths[i] && srcPos < chunkOff + mono.length) {
          const p = srcPos - chunkOff;
          const i0 = Math.floor(p), frac = p - i0;
          const a = mono[i0] ?? 0, b = mono[i0 + 1] ?? a;
          let sample = a + (b - a) * frac;

          if (fadeInSec > 0 || fadeOutSec > 0) {
            const localT = got / rate;
            sample *= clipFadeGain(localT, playLen, fadeInSec, fadeOutSec);
          }

          out[cursor + got++] = sample;
          const progress = (s.out - s.in > 0) ? srcPos / (s.out - s.in) : 0;
          const stepRate = curve ? evalSpeedCurve(curve, progress) : spd;
          srcPos += stepRate;
        }
        chunkOff += mono.length;
        if (got >= lengths[i]) break;
      }
    } catch { /* short source: leave silence */ }
    cursor += lengths[i];
    onProgress?.(i / tl.segments.length);
  }
  return out;
}

function applyJoinFades(program, tl, rate) {
  const fade = Math.round(TUNING.joinFade * rate);
  let pos = 0;
  for (let i = 0; i < tl.segments.length; i++) {
    const len = Math.round(tl.segments[i].dur * rate);
    if (i > 0) for (let j = 0; j < fade && j < len; j++) program[pos + j] *= j / fade;
    if (i < tl.segments.length - 1) for (let j = 0; j < fade && j < len; j++) program[pos + len - 1 - j] *= j / fade;
    pos += len;
  }
}

const onProg = (onProgress, stage) => (p) => onProgress?.({ stage, p });

/** in-place 80 Hz high-pass (same RBJ coefficients as edit-engine.highPass80) */
function hp80InPlace(x, rate) {
  const w0 = (2 * Math.PI * 80) / rate;
  const cos = Math.cos(w0), sin = Math.sin(w0), Q = Math.SQRT1_2, alpha = sin / (2 * Q);
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0, b1 = -(1 + cos) / a0, b2 = (1 + cos) / 2 / a0;
  const a1 = (-2 * cos) / a0, a2 = (1 - alpha) / a0;
  let z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i] * b0 + z1;
    z1 = x[i] * b1 + z2 - a1 * v;
    z2 = x[i] * b2 - a2 * v;
    x[i] = v;
  }
}

/** in-place RMS-anchored soft-knee compressor (mirrors edit-engine.compressProgram) */
function compressInPlace(x, rate) {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  const rmsDb = 20 * Math.log10(Math.max(1e-9, Math.sqrt(sum / Math.max(1, x.length))));
  const threshDb = rmsDb - 6, ratio = 2, kneeDb = 6;
  const atk = Math.max(1, Math.round(0.008 * rate));
  const rel = Math.max(1, Math.round(0.09 * rate));
  let env = 0;
  for (let i = 0; i < x.length; i++) {
    const db = 20 * Math.log10(Math.max(1e-9, Math.abs(x[i]))) - threshDb;
    const target = Math.max(0, db);
    const k = target > env ? atk : rel;
    env += (target - env) / k;
    const over = env - kneeDb / 2;
    const reduction = over > 0 ? (over + kneeDb / 2) * (1 - 1 / ratio) - kneeDb / 4
      : over > -kneeDb / 2 ? ((over + kneeDb / 2) ** 2) / (2 * kneeDb) * (1 - 1 / ratio) : 0;
    x[i] *= 10 ** (-Math.max(0, reduction) / 20);
  }
}

/** streaming gated-LUFS: K-weights one 400ms block at a time — no full copies.
 *  ponytail: filter state is not carried across blocks (each block restarts the
 *  biquads) — a ~1ms edge artifact per 400ms block; inaudible on speech. */
function loudnessGainStreaming(pcm, rate = 48000, target = -14) {
  const K1 = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [1, -1.69065929318241, 0.73248077421585] };
  const K2 = { b: [1, -2, 1], a: [1, -1.99004745483398, 0.99007225036621] };
  const biquad = (x, c, from, len) => {
    let z1 = 0, z2 = 0;
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const s = x[from + i];
      const v = s * c.b[0] + z1;
      z1 = s * c.b[1] + z2 - c.a[1] * v;
      z2 = s * c.b[2] - c.a[2] * v;
      out[i] = v;
    }
    return out;
  };
  const block = Math.round(0.4 * rate), hop = Math.round(0.1 * rate);
  const loud = (ms) => -0.691 + 10 * Math.log10(Math.max(ms, 1e-12));
  const blocks = [];
  for (let i = 0; i + block <= pcm.length; i += hop) {
    const k2 = biquad(biquad(pcm, K1, i, block), K2, 0, block);
    let ms = 0;
    for (let j = 0; j < block; j++) ms += k2[j] * k2[j];
    blocks.push(ms / block);
  }
  if (!blocks.length) return { gainDb: 0 };
  const absKept = blocks.filter((ms) => loud(ms) > -70);
  if (!absKept.length) return { gainDb: 0 };
  const rel = loud(absKept.reduce((a, ms) => a + ms, 0) / absKept.length) - 10;
  const pool = absKept.filter((ms) => loud(ms) > rel);
  const lufs = loud(pool.reduce((a, ms) => a + ms, 0) / pool.length);
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  const peakDb = 20 * Math.log10(Math.max(1e-9, peak));
  return { gainDb: Math.min(target - lufs, -peakDb - 0.1) };
}

/** procedural whooshes at punch/join times (red-team placement: AFTER the LUFS
 *  measure, riding the same gain, one peak clamp after). Enveloped + sweeping
 *  bandpass noise — not raw hiss. ponytail: single-pole sweep, good enough. */
function mixSfx(program, rate, tl, punches, gain) {
  const dur = 0.4;
  const taps = punches.map((p) => p.at).filter((t) => t > 0.2 && t < tl.duration - 0.3);
  for (const at of taps) {
    const start = Math.round(at * rate);
    const n = Math.round(dur * rate);
    // sweeping resonant one-pole bandpass: y += a*(x - y); freq rises with p
    let y = 0, lp = 0;
    for (let i = 0; i < n; i++) {
      const p = i / n;
      const env = Math.sin(Math.PI * p) ** 2 * 0.06 * gain; // -24 dB-ish rel
      const f = 400 + 2400 * p;                              // sweep up
      const a = 1 - Math.exp((-2 * Math.PI * f) / rate);
      const x = Math.random() * 2 - 1;
      y += a * (x - y);
      lp += a * (y - lp);
      const idx = start + i;
      if (idx < program.length) program[idx] += lp * env;
    }
  }
  let peak = 0;
  for (let i = 0; i < program.length; i++) peak = Math.max(peak, Math.abs(program[i]));
  if (peak > 0.98) for (let i = 0; i < program.length; i++) program[i] *= 0.98 / peak;
}
