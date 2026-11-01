// bleep.js — Pure function 1kHz censor tone synthesis & per-word audio muting.
// Pure decision logic: no DOM, node-testable.
// Part of Nila Sprint 4: Gap-fill bundle.

export const BLEEP_FREQ = 1000; // 1 kHz standard broadcast censor tone
export const DEFAULT_BLEEP_DURATION = 0.08; // 80 ms min tone
export const DEFAULT_ENVELOPE_MS = 10; // 10 ms smooth attack/release to prevent clicks

/**
 * Built-in dictionary of common offensive words for automatic profanity sensor.
 */
export const CURSE_WORDS = [
  // Indonesian
  'anjing', 'babi', 'bangsat', 'kontol', 'memek', 'jembut', 'pantek',
  'tai', 'taik', 'goblok', 'tolol', 'bajingan', 'kampret', 'perek', 'sialan',
  // English
  'fuck', 'fucking', 'fucked', 'shit', 'bullshit', 'bitch', 'asshole',
  'bastard', 'cunt', 'dick', 'damn', 'pussy',
];

/**
 * Generate 1kHz censor tone PCM buffer with smooth envelope.
 * @param {object} options
 * @param {number} [options.sampleRate=48000] - Audio sample rate
 * @param {number} [options.durationSec=0.08] - Tone duration in seconds
 * @param {number} [options.freq=1000] - Sine tone frequency (Hz)
 * @param {number} [options.envelopeMs=10] - Envelope attack/release duration (ms)
 * @param {number} [options.gain=0.6] - Tone amplitude (0.0 to 1.0)
 * @returns {Float32Array} PCM buffer
 */
export function generateBleepTone({
  sampleRate = 48000,
  durationSec = DEFAULT_BLEEP_DURATION,
  freq = BLEEP_FREQ,
  envelopeMs = DEFAULT_ENVELOPE_MS,
  gain = 0.6,
} = {}) {
  const numSamples = Math.max(1, Math.round(durationSec * sampleRate));
  const envSamples = Math.min(Math.floor(numSamples / 2), Math.round((envelopeMs / 1000) * sampleRate));
  const out = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Envelope: linear or raised sine ramp
    let env = 1.0;
    if (envSamples > 0) {
      if (i < envSamples) {
        env = i / envSamples;
      } else if (i > numSamples - envSamples) {
        env = (numSamples - i) / envSamples;
      }
    }
    const sine = Math.sin(2 * Math.PI * freq * t);
    out[i] = sine * env * gain;
  }

  return out;
}

/**
 * Apply bleep censor (mute original audio + mix 1kHz tone) onto a mono PCM buffer.
 * Pure function: operates on provided buffer or clones it.
 * @param {Float32Array} pcm - Source PCM audio samples
 * @param {number} sampleRate - Audio sample rate (e.g. 48000)
 * @param {Array<{start: number, end: number}>} bleepSpans - Spans to censor in seconds
 * @param {object} [options]
 * @param {boolean} [options.clone=true] - If true, returns a new copy without mutating input
 * @returns {Float32Array} Processed PCM
 */
export function applyBleepsToPcm(pcm, sampleRate, bleepSpans = [], { clone = true } = {}) {
  if (!pcm || !pcm.length) return pcm;
  const out = clone ? new Float32Array(pcm) : pcm;
  if (!bleepSpans || !bleepSpans.length) return out;

  for (const span of bleepSpans) {
    const startSec = Math.max(0, span.start);
    const endSec = Math.max(startSec + DEFAULT_BLEEP_DURATION, span.end);
    const durSec = endSec - startSec;

    const startIdx = Math.round(startSec * sampleRate);
    const endIdx = Math.min(out.length, Math.round(endSec * sampleRate));
    if (startIdx >= out.length || startIdx >= endIdx) continue;

    // 1. Mute speech audio inside the span with 5ms crossfade at edges
    const crossfade = Math.min(Math.floor((endIdx - startIdx) / 2), Math.round(0.005 * sampleRate));
    for (let i = startIdx; i < endIdx; i++) {
      if (crossfade > 0 && i < startIdx + crossfade) {
        const factor = (startIdx + crossfade - i) / crossfade;
        out[i] *= factor;
      } else if (crossfade > 0 && i > endIdx - crossfade) {
        const factor = (i - (endIdx - crossfade)) / crossfade;
        out[i] *= factor;
      } else {
        out[i] = 0;
      }
    }

    // 2. Mix in synthesized 1kHz bleep tone
    const tone = generateBleepTone({
      sampleRate,
      durationSec: durSec,
      freq: BLEEP_FREQ,
      envelopeMs: DEFAULT_ENVELOPE_MS,
      gain: 0.6,
    });

    for (let i = 0; i < tone.length && startIdx + i < endIdx; i++) {
      out[startIdx + i] += tone[i];
    }
  }

  return out;
}

/**
 * Check if a word matches profanity list or specific term.
 * @param {object} word - { w: string, i: number }
 * @param {string|Array<string>} [terms] - Term or list of terms to match, or 'curse'
 * @returns {boolean}
 */
export function matchesBleepTerm(word, terms) {
  if (!word || !word.w) return false;
  const raw = String(word.w).toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
  if (!raw) return false;

  if (!terms || terms === 'curse' || terms === 'curses') {
    return CURSE_WORDS.includes(raw);
  }

  const list = Array.isArray(terms) ? terms : [terms];
  return list.some((t) => {
    const clean = String(t).toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
    return clean && clean === raw;
  });
}

/**
 * Filter words matching bleep criteria.
 * @param {Array<object>} words - List of transcript words
 * @param {string|Array<string>} criteria - 'curse' or word string/array
 * @returns {Array<number>} Word indices matching
 */
export function findWordsToBleep(words = [], criteria = 'curse') {
  if (!words || !words.length) return [];
  const matches = [];
  for (let i = 0; i < words.length; i++) {
    if (matchesBleepTerm(words[i], criteria)) {
      matches.push(words[i].i ?? i);
    }
  }
  return matches;
}
