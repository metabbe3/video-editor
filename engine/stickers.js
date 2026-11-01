// stickers.js — Pure emoji stickers registry and contextual suggestion engine.
// Pure decision logic: no DOM, node-testable.
// Part of Nila Sprint 4: Gap-fill bundle.

export const BUILTIN_EMOJIS = [
  '📈', '📉', '💰', '🔥', '⚡', '✅',
  '❌', '😂', '😮', '💡', '🎯', '⚠',
];

export const STICKER_KEYWORD_MAP = {
  '📉': ['turun', 'drop', 'anjlok', 'bearish', 'loss', 'rugi', 'crash', 'down', 'minus'],
  '📈': ['naik', 'growth', 'profit', 'bullish', 'cuan', 'melonjak', 'up', 'tinggi', 'tumbuh'],
  '💰': ['uang', 'money', 'duit', 'biaya', 'rupiah', 'dollar', 'saham', 'investasi', 'cuan', 'dana'],
  '🔥': ['viral', 'fire', 'hot', 'populer', 'keren', 'mantap', 'heboh', 'trending'],
  '⚡': ['cepat', 'flash', 'speed', 'kilat', 'listrik', 'energi', 'fast', 'seketika'],
  '✅': ['benar', 'sukses', 'berhasil', 'done', 'yes', 'valid', 'clear', 'tepat', 'pasti'],
  '❌': ['salah', 'gagal', 'batal', 'error', 'no', 'stop', 'zonk', 'keliru'],
  '😂': ['lucu', 'ngakak', 'haha', 'wkwk', 'laugh', 'kocak', 'humor'],
  '😮': ['kaget', 'wow', 'shock', 'surprise', 'omg', 'astaga', 'gila', 'hebat'],
  '💡': ['ide', 'tips', 'paham', 'trik', 'insight', 'konsep', 'solusi', 'tahu', 'cara'],
  '🎯': ['target', 'tujuan', 'fokus', 'goal', 'arah', 'strategi', 'tepat'],
  '⚠': ['bahaya', 'warning', 'hati-hati', 'alert', 'awas', 'risiko', 'danger', 'perhatian'],
};

/**
 * Scan transcript words and generate contextual sticker suggestions.
 * @param {Array<object>} words - Transcript words {w, start, end, i}
 * @param {object} [options]
 * @param {number} [options.maxSuggestions=6]
 * @returns {Array<{wordIndex: number, word: string, char: string, at: number}>}
 */
export function suggestStickers(words = [], { maxSuggestions = 6 } = {}) {
  if (!words || !words.length) return [];
  const suggestions = [];
  const seenIndices = new Set();

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w || !w.w) continue;
    const clean = String(w.w).toLowerCase().replace(/[^\w]/g, '');
    if (!clean) continue;

    for (const [emoji, keywords] of Object.entries(STICKER_KEYWORD_MAP)) {
      if (keywords.includes(clean)) {
        if (!seenIndices.has(i)) {
          seenIndices.add(i);
          suggestions.push({
            wordIndex: w.i ?? i,
            word: w.w,
            char: emoji,
            at: w.start,
          });
          break;
        }
      }
    }

    if (suggestions.length >= maxSuggestions) break;
  }

  return suggestions;
}
