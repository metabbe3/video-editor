// STT worker — Whisper word timestamps off the main thread. WASM always
// (WebGPU is field-unreliable for word timestamps AND breaks the detect
// session shape — ANALYSIS §2 + our own e2e). Language is handled PER JOB:
// the main thread owns the pin (a module-level pin here used to leak the
// previous file's language into the next file, force-English-ing it).

import { pipeline, env, Tensor } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

env.allowLocalModels = false;

const FILLER_SEED = 'Umm, so, uh, I was like, uhh... Well, you know, I mean, sort of, uh, basically...';
// Indonesian + tech code-switching seed: biases the decoder to Indonesian grammar
// while preserving exact English spelling for tech nouns
const ID_SEED = 'Jadi hari ini kita bahas iPhone, AppleCare, MagSafe, software, bug, freeze, battery, gaming — review teknologi dalam Bahasa Indonesia santai.';

let asr = null;

async function getPipeline(model) {
  if (asr?.model === model) return asr.pipe;
  const pipe = await pipeline('automatic-speech-recognition', model, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: (p) => postMessage({ type: 'progress', stage: 'load', data: serializeProgress(p) }),
  });
  asr = { pipe, model };
  return pipe;
}

/**
 * Vendored language auto-detection (transformers.js 4.3.2 silently forces 'en'
 * when `language` is omitted — PR #1541 not yet released). One forward pass
 * with just <|startoftranscript|>: encoder session -> merged decoder with a
 * zero-length KV cache + use_cache_branch=false; the language tokens compete
 * freely in the logits — argmax over lang_to_id. Returns e.g. '<|id|>'.
 */
async function detectLanguage(pipe, pcm) {
  try {
    const model = pipe.model;
    const gen = model.generation_config ?? {};
    const langToId = gen.lang_to_id ?? model.config?.lang_to_id;
    const sot = gen.decoder_start_token_id ?? model.config?.decoder_start_token_id;
    if (!langToId || sot == null) return null;
    const inputs = await pipe.processor(pcm.slice(0, 480_000)); // first 30s @16k
    const enc = model.sessions['model'];
    const dec = model.sessions['decoder_model_merged'];
    if (!enc || !dec) return null;
    const encOut = await enc.run({ input_features: inputs.input_features });
    const hidden = encOut.last_hidden_state ?? Object.values(encOut)[0];
    const feeds = {
      input_ids: new Tensor('int64', BigInt64Array.from([BigInt(sot)]), [1, 1]),
      encoder_hidden_states: hidden,
      use_cache_branch: new Tensor('bool', Uint8Array.from([0]), [1]),
    };
    for (const n of dec.inputNames ?? []) {
      if (n.startsWith('past_key_values.')) feeds[n] = new Tensor('float32', new Float32Array(0), [1, 8, 0, 64]);
    }
    const decOut = await dec.run(feeds);
    const logits = decOut.logits ?? Object.values(decOut)[0];
    const data = logits?.data;
    if (!data) return null;
    const langIds = new Set(Object.values(langToId));
    let best = null, bestV = -Infinity;
    for (let i = 0; i < data.length; i++) {
      if (!langIds.has(i)) continue;
      const v = Number(data[i]);
      if (v > bestV) { bestV = v; best = i; }
    }
    const token = Object.entries(langToId).find(([, v]) => v === best)?.[0];
    return token ?? null;
  } catch {
    return null;
  }
}

onmessage = async (e) => {
  const { type } = e.data;
  if (type !== 'transcribe') return;
  const { pcm, model } = e.data;
  let language = e.data.language;
  if (language === 'auto' || language === '') language = undefined;
  const englishOnly = /\.en(_timestamped)?$/.test(model);
  try {
    const pipe = await getPipeline(model);
    let used = language ?? null;
    if (!language && !englishOnly) {
      const detected = await detectLanguage(pipe, pcm); // per job, always fresh
      if (detected) {
        used = detected;
        postMessage({ type: 'progress', stage: 'language', data: detected });
      }
    }
    if (!used && englishOnly) used = 'en';
    postMessage({ type: 'progress', stage: 'infer-start' });
    const opts = {
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
      task: 'transcribe',
      initial_prompt: FILLER_SEED,
    };
    if (used) opts.language = used;
    opts.initial_prompt = /<\|id\|>|indonesian|^id$/i.test(String(used)) ? ID_SEED : FILLER_SEED;
    const out = await pipe(pcm, opts);
    postMessage({ type: 'done', chunks: out.chunks || [], language: used });
  } catch (err) {
    postMessage({ type: 'error', message: String(err?.message || err) });
  }
};

function serializeProgress(p) {
  return { status: p.status, file: p.file, progress: p.progress, loaded: p.loaded, total: p.total };
}
