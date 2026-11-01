// Transcribe — windowed Whisper with per-window IndexedDB caching.
// 60s windows with 1s overlap; words whose midpoint falls in a window's
// overlap zone are dropped (the neighboring window owns them), so boundary
// words appear exactly once. A reload resumes at the first uncached window.
// ponytail: window edges can clip a word that spans >0.5s across a boundary —
// shrink the window if that ever shows up in practice.

import { cachedWords, saveWords } from './idb-cache.js';
export { cachedWords, saveWords };

const RATE = 16000;
export const WINDOW = 60;
const OVERLAP = 1;

export async function transcribe(pcm, { model = 'onnx-community/whisper-base_timestamped', cacheKey = '', language = 'auto', onProgress, signal } = {}) {
  const totalWindows = Math.ceil(pcm.length / (WINDOW * RATE));
  const words = [];
  // Language pin is PER FILE: window 0 detects (when auto), later windows reuse
  // it. The caller's cacheKey already encodes the REQUESTED language, so
  // windows are cached per language-lane and never cross-poisoned.
  let lang = (language === 'auto' || language === '') ? null : language;
  let detectedLanguage = null;
  for (let w = 0; w < totalWindows; w++) {
    signal?.throwIfAborted?.();
    const key = `${cacheKey}|w${w}`;
    let winWords = cacheKey ? await cachedWords(key) : null;
    if (!winWords) {
      const start = w * WINDOW * RATE;
      const end = Math.min(pcm.length, (w + 1) * WINDOW * RATE + OVERLAP * RATE);
      const seg = pcm.slice(start, end); // own buffer for the transfer
      const ran = await runWorker(seg, model, lang, onProgress, signal);
      if (ran.language) detectedLanguage = ran.language;
      if (!lang && ran.language) lang = ran.language; // pin what window 0 detected
      winWords = ran.words;
      winWords = winWords.map((x) => ({ ...x, start: x.start + start / RATE, end: x.end + start / RATE }));
      if (cacheKey) await saveWords(key, winWords);
    }
    const coreEnd = (w + 1) * WINDOW; // keep words whose midpoint is inside this window's core
    for (const x of winWords) {
      const mid = (x.start + x.end) / 2;
      if (w > 0 && mid < w * WINDOW + OVERLAP) continue;      // owned by previous window
      if (w < totalWindows - 1 && mid >= coreEnd - OVERLAP) continue; // owned by the next window
      words.push(x);
    }
    onProgress?.({ stage: 'window', done: w + 1, total: totalWindows });
  }
  return { words: words.filter((x) => x.w).sort((a, b) => a.start - b.start), language: detectedLanguage };
}

let sharedWorker = null;
function runWorker(pcmSlice, model, language, onProgress, signal) {
  // ONE persistent worker: the WASM/whisper model loads once for ALL windows
  // (re-creating it per window cost ~4 min of init each — measured the hard way)
  if (!sharedWorker) sharedWorker = new Worker(new URL('stt-worker.js', import.meta.url), { type: 'module' });
  const worker = sharedWorker;
  return new Promise((resolve, reject) => {
    // watchdog: a hung window (worker crash without error event, stuck IDB txn)
    // surfaces as a clear error instead of a forever-busy UI
    const watchdog = setTimeout(() => fail(new Error('transcription window timed out (10 min)')), 600_000);
    const settle = (fn, arg) => { clearTimeout(watchdog); fn(arg); };
    const fail = (e) => settle((err) => { worker.terminate(); sharedWorker = null; reject(err); }, e);
    signal?.addEventListener('abort', () => fail(new Error('cancelled')), { once: true });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        onProgress?.(m);
      } else if (m.type === 'done') {
        const words = (m.chunks || []).map((c) => ({
          w: (c.text || '').trim(),
          start: c.timestamp?.[0],
          end: c.timestamp?.[1],
        })).filter((x) => x.w && Number.isFinite(x.start) && Number.isFinite(x.end));
        settle(resolve, { language: m.language ?? null, words });
      } else if (m.type === 'error') {
        fail(new Error(m.message));
      }
    };
    worker.onerror = (e) => fail(new Error(e.message || 'worker failed'));
    worker.postMessage({ type: 'transcribe', pcm: pcmSlice, model, language }, [pcmSlice.buffer]);
  });
}
