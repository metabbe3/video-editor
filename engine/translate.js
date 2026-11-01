// translate.js — Pure caption translation payload builder and validator.
// Pure decision logic: no DOM, node-testable.
// Part of Nila Sprint 4: Gap-fill bundle.

export const TARGET_LANGUAGES = {
  en: { id: 'en', label: 'English', flag: '🇬🇧' },
  id: { id: 'id', label: 'Bahasa Indonesia', flag: '🇮🇩' },
  es: { id: 'es', label: 'Spanish', flag: '🇪🇸' },
  ja: { id: 'ja', label: 'Japanese', flag: '🇯🇵' },
  zh: { id: 'zh', label: 'Mandarin Chinese', flag: '🇨🇳' },
  ko: { id: 'ko', label: 'Korean', flag: '🇰🇷' },
};

/**
 * Build GLM messages payload to translate captions into target language.
 * Adheres to keep-ranges word-index contract.
 * @param {Array<object>} words - Transcript words [{i, w, start, end}]
 * @param {string} targetLang - Language key ('en', 'id', 'es', etc.)
 * @returns {Array<{role: string, content: string}>} Chat messages
 */
export function buildTranslationMessages(words = [], targetLang = 'en') {
  const lang = TARGET_LANGUAGES[targetLang]?.label || targetLang;
  const wordList = words.map((w, idx) => `${w.i ?? idx}:${w.w}`).join(' ');

  const system = `You are an expert subtitler and subtitle translator.
Translate the provided indexed word sequence into natural, punchy ${lang}.
Preserve word indices exactly. Each translated item must have "i" (integer index) and "w" (translated word or short phrase).
The output must match the number of words or align strictly by index.
Do NOT omit indices. Do NOT hallucinate indices.
Reply with a SINGLE JSON object matching exactly:
{"translations":[{"i":<int>,"w":"<translated word>"}]}`;

  const user = `Translate these indexed words into ${lang}:\n${wordList}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Parse and validate GLM translation response.
 * Preserves original word timing (start, end, keep) exactly.
 * @param {string|object} response - JSON string or object from GLM
 * @param {Array<object>} originalWords - Source transcript words
 * @returns {Array<object>} Cloned words with translated text
 */
export function parseTranslationResponse(response, originalWords = []) {
  if (!originalWords || !originalWords.length) return [];

  let data = response;
  if (typeof response === 'string') {
    try {
      data = JSON.parse(response);
    } catch {
      // Try stripping markdown fences
      const clean = response.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      data = JSON.parse(clean);
    }
  }

  const translations = Array.isArray(data?.translations) ? data.translations : [];
  const transMap = new Map();
  for (const t of translations) {
    if (t && typeof t.i === 'number' && t.w != null) {
      transMap.set(t.i, String(t.w).trim());
    }
  }

  // Clone words and apply translated text, strictly preserving start and end times
  return originalWords.map((w, idx) => {
    const wordIdx = w.i ?? idx;
    const transW = transMap.get(wordIdx);
    return {
      ...w,
      originalW: w.w,
      w: transW || w.w,
      translated: Boolean(transW),
    };
  });
}
