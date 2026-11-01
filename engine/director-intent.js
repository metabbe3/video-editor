// director-intent.js — Intent parser, video classifier, and edit planner for ChatDirector.
// Pure decision logic: no DOM, node-testable.
// Part of Nila Sprint 3: ChatDirector orchestration.

import { STANCES } from '../src/agents/council.js';

// Keywords indicative of financial, market, or data-dense recap videos
const NEWS_TERMS = /\b(ihsg|saham|triliun|miliar|juta|persen|%|inflasi|pasar|market|rupiah|dollar|crypto|bitcoin|cuan|rugi|profit|loss|revenue|growth|recap|news|headline|kuartal|quarter|investor|investasi|ekonomi|emiten|closing|opening|dividen|sahamnya|turun|anjlok|naik|melonjak)\b/i;

// Keywords indicative of narrative, personal story, or vlog videos
const STORY_TERMS = /\b(cerita|kisah|pengalaman|ingat|waktu\s+itu|suatu\s+hari|rasanya|perjalanan|hidup|personal|story|journey|remember|felt|feeling|life|happened|once\s+upon|terjadi|kenangan|pelajaran|bercerita|curhat)\b/i;

// Keywords indicative of educational or tutorial videos
const TUTORIAL_TERMS = /\b(cara|tutorial|langkah|panduan|tips|trik|belajar|metode|formula|guide|how\s+to|step|learn|method|trick|konsep|penjelasan|teknik|praktek|solusi)\b/i;

/**
 * Classify video type and recommend default council stance based on transcript words.
 * Pure heuristic: density of numerical/market terms vs narrative vs tutorial words.
 * Always returned as an advisory suggestion with clickable options, not auto-committed.
 */
export function detectVideoTypeAndStance(words = []) {
  if (!words || !words.length) {
    return {
      detectedType: 'general',
      recommendedStance: 'balanced',
      confidence: 0.5,
      stats: { newsHits: 0, storyHits: 0, tutorialHits: 0, numberCount: 0 },
      message: 'No transcript words available yet. Using Balanced stance as default.',
      options: [
        { label: '⚖️ Keep Balanced Stance', action: 'set_stance', stance: 'balanced' },
        { label: '🔪 Switch to Ruthless Viral', action: 'set_stance', stance: 'ruthless' },
        { label: '📖 Switch to Deep Storyteller', action: 'set_stance', stance: 'storyteller' },
      ],
    };
  }

  let newsHits = 0;
  let storyHits = 0;
  let tutorialHits = 0;
  let numberCount = 0;

  for (const w of words) {
    const raw = (w.w || '').toLowerCase();
    const clean = raw.replace(/[^\w%]/g, '');
    if (NEWS_TERMS.test(clean)) newsHits++;
    if (STORY_TERMS.test(clean)) storyHits++;
    if (TUTORIAL_TERMS.test(clean)) tutorialHits++;
    if (/\d/.test(raw) || /%/.test(raw)) numberCount++;
  }

  const totalWords = words.length;
  const newsScore = (newsHits * 1.5 + numberCount * 1.2) / totalWords;
  const storyScore = (storyHits * 2.0) / totalWords;
  const tutorialScore = (tutorialHits * 1.8) / totalWords;

  let detectedType = 'general';
  let recommendedStance = 'balanced';
  let reason = 'Balanced pacing suitable for general content.';

  if (newsScore > 0.04 && newsScore > storyScore) {
    detectedType = 'news';
    recommendedStance = 'ruthless';
    reason = `Detected data-dense / market recap content (${newsHits} key terms, ${numberCount} numbers). Fast ruthless cuts recommended.`;
  } else if (storyScore > 0.03 && storyScore > newsScore) {
    detectedType = 'story';
    recommendedStance = 'storyteller';
    reason = `Detected narrative / personal storytelling content (${storyHits} story terms). Preserving pauses and natural pacing recommended.`;
  } else if (tutorialScore > 0.03) {
    detectedType = 'tutorial';
    recommendedStance = 'balanced';
    reason = `Detected tutorial / explanatory content (${tutorialHits} guide terms). Balanced rhythm recommended for clarity.`;
  }

  return {
    detectedType,
    recommendedStance,
    confidence: +(Math.max(newsScore, storyScore, tutorialScore) * 10).toFixed(2),
    stats: { newsHits, storyHits, tutorialHits, numberCount, totalWords },
    message: reason,
    options: [
      {
        label: `Adopt recommended: ${STANCES[recommendedStance]?.label || recommendedStance}`,
        action: 'set_stance',
        stance: recommendedStance,
        recommended: true,
      },
      ...(['ruthless', 'balanced', 'storyteller']
        .filter((s) => s !== recommendedStance)
        .map((s) => ({
          label: `Use ${STANCES[s]?.label || s}`,
          action: 'set_stance',
          stance: s,
        }))),
    ],
  };
}

/**
 * Find word spans matching a keyword or phrase, and compute a draft focus plan.
 * Returns proposed keeps and cuts without mutating the project directly.
 */
export function planFocusEdit(term, words = [], duration = 0, { padLeadSec = 0.4, padTailSec = 0.6 } = {}) {
  const q = String(term || '').trim().toLowerCase();
  if (!q || !words || !words.length) {
    return {
      matched: false,
      term: q,
      explanation: 'No transcript words or search term provided.',
      keeps: [{ in: 0, out: duration, why: 'all' }],
      cuts: [],
    };
  }

  const queryParts = q.split(/\s+/).filter(Boolean);
  const matchedIndices = [];

  // 1. Multi-word phrase search
  if (queryParts.length > 1) {
    for (let i = 0; i <= words.length - queryParts.length; i++) {
      let isMatch = true;
      for (let j = 0; j < queryParts.length; j++) {
        const w = (words[i + j].w || '').toLowerCase().replace(/[^\w]/g, '');
        const target = queryParts[j].replace(/[^\w]/g, '');
        if (!w.includes(target) && !target.includes(w)) {
          isMatch = false;
          break;
        }
      }
      if (isMatch) {
        for (let j = 0; j < queryParts.length; j++) matchedIndices.push(i + j);
      }
    }
  }

  // 2. Fallback to individual word search if no phrase matches
  if (!matchedIndices.length) {
    for (let i = 0; i < words.length; i++) {
      const w = (words[i].w || '').toLowerCase().replace(/[^\w]/g, '');
      if (queryParts.some((part) => {
        const p = part.replace(/[^\w]/g, '');
        return p.length >= 2 && (w.includes(p) || p.includes(w));
      })) {
        matchedIndices.push(i);
      }
    }
  }

  if (!matchedIndices.length) {
    return {
      matched: false,
      term: q,
      explanation: `No mention of "${term}" found in transcript.`,
      keeps: [{ in: 0, out: duration, why: 'all' }],
      cuts: [],
    };
  }

  // Find sentence / clause boundaries around matched words
  const expandToSentence = (idx) => {
    let start = idx;
    let end = idx;
    while (start > 0 && !/[.!?…]$/.test(words[start - 1].w)) start--;
    while (end < words.length - 1 && !/[.!?…]$/.test(words[end].w)) end++;
    return { start, end };
  };

  // Collect word ranges
  const keepIntervals = [];
  const coveredIndices = new Set();
  for (const idx of matchedIndices) {
    if (coveredIndices.has(idx)) continue;
    const span = expandToSentence(idx);
    for (let i = span.start; i <= span.end; i++) coveredIndices.add(i);

    const s = Math.max(0, words[span.start].start - padLeadSec);
    const e = Math.min(duration, words[span.end].end + padTailSec);
    keepIntervals.push({ in: +s.toFixed(3), out: +e.toFixed(3), why: `focus: "${term}"` });
  }

  // Merge overlapping keep intervals
  keepIntervals.sort((a, b) => a.in - b.in);
  const mergedKeeps = [];
  for (const k of keepIntervals) {
    const prev = mergedKeeps[mergedKeeps.length - 1];
    if (prev && k.in <= prev.out + 0.1) {
      prev.out = Math.max(prev.out, k.out);
    } else {
      mergedKeeps.push({ ...k });
    }
  }

  // Word indices to cut = everything not in coveredIndices
  const cutWordIndices = [];
  for (let i = 0; i < words.length; i++) {
    if (!coveredIndices.has(i)) cutWordIndices.push(i);
  }

  const matchCount = matchedIndices.length;
  const keepCount = coveredIndices.size;
  const cutCount = cutWordIndices.length;

  return {
    matched: true,
    term: q,
    matchCount,
    keepWordCount: keepCount,
    cutWordCount: cutCount,
    keeps: mergedKeeps,
    cuts: cutWordIndices,
    wordIndices: Array.from(coveredIndices),
    explanation: `Found ${matchCount} mention${matchCount === 1 ? '' : 's'} of "${term}". Keeping ${keepCount} surrounding words, cutting ${cutCount} other words.`,
  };
}

/**
 * Generate 3 variant proposals locally:
 * 1. Hook-led (Ruthless): fast hook punch, tight cuts, duration ~18-25s.
 * 2. Data-led (Balanced): numbers highlighted with punches, duration ~25-40s.
 * 3. Story-led (Storyteller): preserves dramatic pauses and narrative context, duration ~40-60s.
 */
export function generate3Variants(words = [], duration = 0, { proposals = [], baseKeeps = [] } = {}) {
  const totalWords = (words || []).length;
  const safeDur = duration || (words?.[totalWords - 1]?.end ?? 30);

  // Variant A: Hook-led (Ruthless)
  const hookEndIdx = Math.min(totalWords - 1, Math.max(5, Math.floor(totalWords * 0.45)));
  const vA = {
    id: 'variant_hook',
    index: 0,
    title: 'Hook-Led (Ruthless Viral)',
    hookTitle: words?.[0] ? `Why ${words[0].w}...` : 'Fast Hook',
    stance: 'ruthless',
    targetLen: Math.min(25, safeDur * 0.5),
    description: 'Fast 15-25s cut. Strips all dead air and delivers the punchline immediately.',
    keeps: baseKeeps.length ? baseKeeps.slice(0, Math.ceil(baseKeeps.length * 0.6)) : [{ in: 0, out: safeDur * 0.5, why: 'hook' }],
  };

  // Variant B: Data-led (Balanced)
  const vB = {
    id: 'variant_data',
    index: 1,
    title: 'Data-Led (Balanced Creator)',
    hookTitle: 'The Big Numbers',
    stance: 'balanced',
    targetLen: Math.min(40, safeDur * 0.75),
    description: 'Balanced 25-40s cut. Retains key statistics, numbers, and clear explanations.',
    keeps: baseKeeps.length ? baseKeeps : [{ in: 0, out: safeDur * 0.75, why: 'balanced' }],
  };

  // Variant C: Story-led (Deep Storyteller)
  const vC = {
    id: 'variant_story',
    index: 2,
    title: 'Story-Led (Deep Narrative)',
    hookTitle: 'The Complete Journey',
    stance: 'storyteller',
    targetLen: Math.min(60, safeDur),
    description: 'Full 40-60s narrative. Preserves dramatic pauses, storytelling rhythm, and conclusion.',
    keeps: [{ in: 0, out: safeDur, why: 'full narrative' }],
  };

  return [vA, vB, vC];
}

/**
 * Parse natural user chat (EN + ID) into one or more structured intent plans.
 * Supports:
 * - load/analyze
 * - focus
 * - variants
 * - refine
 * - stance
 * - export
 * - status/help
 *
 * Ambiguous instructions trigger questions with max 3 options (don't guess).
 */
export function parseDirectorIntent(rawText, projectState = {}) {
  const text = String(rawText || '').trim();
  if (!text) {
    return {
      rawText: '',
      intents: [],
      needsClarification: false,
      message: 'Please ask an editing instruction, e.g. "analyze this video", "focus on IHSG", or "give me 3 options".',
      options: [
        { label: '🔍 Analyze this video', action: 'analyze' },
        { label: '⚡ Give me 3 short options', action: 'variants' },
        { label: '📊 Status of project', action: 'status' },
      ],
    };
  }

  // Check for multi-intent splitting ("lalu", "kemudian", "terus", "dan", "setelah itu", "then", "and", "after that")
  const clauses = text
    .split(/\s*(?:\b(?:lalu|kemudian|terus|setelah\s+itu|then|after\s+that)\b|;\s*|\band\s+then\b)\s*/i)
    .map((c) => c.trim())
    .filter(Boolean);

  // If there's an explicit chain, parse each clause; otherwise parse the whole text
  const intentList = [];
  const targetClauses = clauses.length > 1 ? clauses : [text];

  for (const clause of targetClauses) {
    const single = parseSingleClauseIntent(clause, projectState);
    if (single.needsClarification) {
      return single; // Return clarification immediately
    }
    if (single.intent) {
      intentList.push(single.intent);
    }
  }

  if (!intentList.length) {
    // Ambiguous query handling: check if user gave a very short / vague command
    if (/^(bagusin|editin|buat\s*bagus|keren|bagus|edit|potong|bikin\s*oke|make\s*it\s*better|do\s*magic)$/i.test(text)) {
      return {
        rawText: text,
        intents: [],
        needsClarification: true,
        question: 'How would you like to edit this video?',
        options: [
          { label: '🔪 Ruthless Viral (Fast pacing)', action: 'stance_ruthless' },
          { label: '⚖️ Balanced Creator (Natural rhythm)', action: 'stance_balanced' },
          { label: '📖 Deep Storyteller (Dramatic pauses)', action: 'stance_storyteller' },
        ],
      };
    }

    // Default unknown fallback -> help intent
    return {
      rawText: text,
      intents: [
        {
          type: 'help',
          params: {},
          confidence: 0.3,
          description: 'Instruction not recognized. Presenting capabilities and options.',
        },
      ],
      needsClarification: false,
      message: `I didn't quite catch "${text}". Here are things you can do:`,
      options: [
        { label: '🔍 Analyze this video', action: 'analyze' },
        { label: '⚡ Give me 3 short options', action: 'variants' },
        { label: '🔪 Make it ruthless', action: 'stance_ruthless' },
      ],
    };
  }

  return {
    rawText: text,
    intents: intentList,
    needsClarification: false,
    options: null,
  };
}

/**
 * Parse a single instruction clause into an intent object.
 */
function parseSingleClauseIntent(clause, state = {}) {
  const q = clause.trim();

  // 1. Analyze / Load: "editkan video ini", "analyze", "analisis video ini", "mulai edit"
  if (/(?:editkan\s*video(?:\s*ini)?|analyze(?:\s*this\s*video)?|analis(?:is|a)(?:\s*video(?:\s*ini)?)?|mulai\s*edit|transcribe|auto\s*cut|auto\s*edit)/i.test(q)) {
    const hasWords = Boolean(state.words && state.words.length);
    const hasMedia = Boolean(state.reg?.arollId || state.hasMedia);
    return {
      intent: {
        type: 'analyze',
        params: { hasWords, hasMedia },
        confidence: 0.95,
        description: hasWords
          ? 'Run analysis and candidate cut proposals on loaded transcript.'
          : hasMedia
            ? 'Transcribe and analyze loaded A-roll video.'
            : 'Requires picking a folder first before analyzing.',
      },
      needsClarification: false,
    };
  }

  // 2. Focus: "fokus ke IHSG turun", "bagian mana yang bicara soal X", "potong semua kecuali bagian X", "focus on X", "keep only X"
  const focusMatch = q.match(/(?:fokus(?:kan)?\s+(?:ke|pada)?|focus\s+on|bagian\s+mana\s+yang\s+(?:bicara|bahas|omong(?:in)?)\s+(?:soal|tentang)?|potong\s+semua\s+kecuali\s+(?:bagian)?|keep\s+only|cut\s+everything\s+except)\s+['"“]?([^'"”.,!?]+)['"”]?/i);
  if (focusMatch) {
    const term = focusMatch[1].trim();
    const plan = planFocusEdit(term, state.words || [], state.analysis?.duration || 0);
    return {
      intent: {
        type: 'focus',
        params: { term, plan },
        confidence: 0.9,
        description: `Focus edit on topic "${term}".`,
      },
      needsClarification: false,
    };
  }

  // 3. Variants: "kasih 3 opsi shorts", "bikin opsi", "berapa versi?", "give 3 options", "3 gaya"
  const variantMatch = q.match(/(?:kasih|buat(?:kan)?|bikin|generate|give\s*me)\s*(\d+)?\s*(?:opsi|varian|versi|gaya|pilihan|options|variants|versions)/i) ||
                        q.match(/(\d+)\s*(?:opsi|varian|versi|gaya|pilihan|options|variants|versions)/i) ||
                        q.match(/(?:berapa\s+(?:opsi|versi|varian))/i);
  if (variantMatch) {
    const count = parseInt(variantMatch[1] || '3', 10);
    const variants = generate3Variants(state.words || [], state.analysis?.duration || 0, {
      proposals: state.proposals || [],
      baseKeeps: state.baseKeeps || [],
    });
    return {
      intent: {
        type: 'variants',
        params: { count, variants },
        confidence: 0.9,
        description: `Generate ${count} distinct video variant styles (Hook-led, Data-led, Story-led).`,
      },
      needsClarification: false,
    };
  }

  // 4. Stance switch: "bikin lebih agresif", "calm storytelling", "ruthless", "make it balanced", "lebih santai"
  const stanceMatch = q.match(/(?:bikin|buat|jadikan|ubah|ganti|set|switch|make\s*it)?\s*(?:lebih\s+)?(agresif|ruthless|viral|santai|calm|storytelling|story|cerita|balanced|seimbang)/i);
  if (stanceMatch && !/potong/i.test(q)) {
    const rawStance = stanceMatch[1].toLowerCase();
    let targetStance = 'balanced';
    if (/agresif|ruthless|viral/.test(rawStance)) targetStance = 'ruthless';
    else if (/santai|calm|storytelling|story|cerita/.test(rawStance)) targetStance = 'storyteller';
    else if (/balanced|seimbang/.test(rawStance)) targetStance = 'balanced';

    return {
      intent: {
        type: 'stance',
        params: { stance: targetStance },
        confidence: 0.92,
        description: `Switch council stance to ${STANCES[targetStance]?.label || targetStance}.`,
      },
      needsClarification: false,
    };
  }

  // 5. Refine / Feedback: "rapat potongannya", "hook lemot", "jangan potong bagian ini", "tighter cuts"
  if (/(?:rapat(?:kan)?\s*potongan|potongan(?:nya)?\s*rapat|tighter\s*cuts?|hook\s*(?:lemot|lambat|slow)|pacing\s*(?:terlalu\s*)?(?:lambat|cepat)|jangan\s*potong|cut\s*(?:more\s*)?pauses?|keep\s*(?:more\s*)?pauses?)/i.test(q)) {
    return {
      intent: {
        type: 'refine',
        params: { feedback: q },
        confidence: 0.88,
        description: `Iterate council debate on active edit using feedback: "${q}".`,
      },
      needsClarification: false,
    };
  }

  // 6. Export: "export yang A", "render opsi 2", "export video", "render mp4", "download"
  const exportMatch = q.match(/(?:export|render|ekspor|unduh|download|simpan\s+mp4|save\s+mp4)(?:\s+(?:video|mp4|yang\s+([abc\d]+)|opsi\s*(\d+)|variant\s*(\d+)))?/i);
  if (exportMatch) {
    const targetOption = exportMatch[1] || exportMatch[2] || exportMatch[3] || null;
    return {
      intent: {
        type: 'export',
        params: { targetOption },
        confidence: 0.95,
        description: targetOption ? `Export selected variant (${targetOption}).` : 'Export MP4 of the active timeline.',
      },
      needsClarification: false,
    };
  }

  // 7. Status / Help: "bisa apa?", "ada apa sekarang", "status", "help"
  if (/(?:bisa\s+apa|ada\s+apa\s+sekarang|status|help|bantuan|what\s+can\s+you\s+do|project\s+status|ringkasan|info)/i.test(q)) {
    return {
      intent: {
        type: 'status',
        params: {},
        confidence: 0.95,
        description: 'Summarize project status, duration, cuts, variants, and active stance.',
      },
      needsClarification: false,
    };
  }

  return { intent: null, needsClarification: false };
}
