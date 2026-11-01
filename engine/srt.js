// SRT — SubRip parse + serialize for caption import/export (pure).
// toSrt consumes caption chunks (the same {text,t0,t1} captionsOf produces).

const TS = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g;

const stamp = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4), s = Math.floor((ms % 6e4) / 1e3);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
};

/** "0:00:01,500 --> 0:00:03,000" -> seconds; null when unparsable */
export function parseStamp(str) {
  const m = [...String(str).matchAll(TS)];
  if (m.length < 2) return null;
  const toSec = (g) => (+g[1]) * 3600 + (+g[2]) * 60 + (+g[3]) + (+g[4].padEnd(3, '0')) / 1000;
  return { start: toSec(m[0]), end: toSec(m[1]) };
}

/** SRT text -> [{start, end, text}]; tolerates BOM, CRLF, missing index lines */
export function parseSrt(text) {
  const cues = [];
  for (const block of String(text).replace(/^﻿/, '').replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    const tsLine = lines.find((l) => l.includes('-->') && /\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test(l)); // inline regex: stateless (a shared /g would carry lastIndex between tests)
    if (!tsLine) continue;
    const ts = parseStamp(tsLine);
    if (!ts) continue;
    const textStart = lines.indexOf(tsLine) + 1;
    cues.push({ ...ts, text: lines.slice(textStart).join(' ').trim() });
  }
  return cues;
}

/** caption chunks [{text, t0, t1}] -> SRT text */
export function toSrt(chunks) {
  return (chunks || [])
    .filter((c) => c.text?.trim())
    .map((c, i) => `${i + 1}\n${stamp(c.t0)} --> ${stamp(c.t1)}\n${c.text.trim()}\n`)
    .join('\n');
}
