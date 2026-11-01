// chat-ops.js — Natural language command parser for inline AI Chat.
// Pure decision logic: no DOM, node-testable.
// Handles English and Indonesian commands for:
// - keep-range ("jangan dipotong", "biarkan", "protect")
// - cut-range ("potong", "hapus", "cut this")
// - add-pause ("kasih jeda 0.3s setelah kata ini", "add pause 0.5s")
// - add-punch ("zoom punch here", "kasih zoom")
// - multi-punch ("cari semua 'IHSG' dan zoom punch", "find all 'AI' and zoom")
// - bleep-words ("bleep kata IHSG", "sensor semua kata kasar")

import { findWordsToBleep } from './bleep.js';

/**
 * Parse a chat command locally with regex and phonetic matching.
 * @param {string} text - User prompt
 * @param {object} context - { selectedWords: [], allWords: [], currentEdl: null, playheadSrc: 0 }
 * @returns {object} { op, wordIndices, label, explanation, meta }
 */
export function parseChatCommand(text, context = {}) {
  const q = String(text || '').trim();
  const selectedWords = context.selectedWords || [];
  const allWords = context.allWords || [];
  const firstWord = selectedWords[0] || allWords[0] || null;
  const lastWord = selectedWords[selectedWords.length - 1] || firstWord;

  // 1. Multi-punch: "cari semua 'IHSG' dan zoom punch" / "find all 'AI' and zoom punch"
  const multiPunchMatch = q.match(/(?:cari|find|search)\s+(?:semua\s+|all\s+)?['"“]([^'"”]+)['"”].*?(?:zoom|punch)/i) ||
                          q.match(/(?:cari|find|search)\s+(?:semua\s+|all\s+)?(\w+).*?(?:zoom|punch)/i) ||
                          q.match(/(?:zoom|punch)\s+(?:semua\s+|all\s+)(?:kata\s+)?['"“]?(\w+)['"”]?/i);
  if (multiPunchMatch) {
    const term = multiPunchMatch[1].trim().toLowerCase();
    const matchingIndices = [];
    for (let i = 0; i < allWords.length; i++) {
      const cleanW = allWords[i].w.toLowerCase().replace(/[.,!?;:]+$/, '');
      if (cleanW === term) matchingIndices.push(i);
    }
    return {
      op: 'multi-punch',
      term,
      wordIndices: matchingIndices,
      scale: 1.15,
      label: `Zoom punch on ${matchingIndices.length} matches of "${term}"`,
      explanation: matchingIndices.length
        ? `Found ${matchingIndices.length} occurrences of "${term}" to punch in.`
        : `No occurrences of "${term}" found in transcript.`,
    };
  }

  // 1b. Bleep curse words: "sensor semua kata kasar", "bleep kata kasar", "censor curse words"
  if (/(?:sensor|bleep|censor|mute)\s+(?:semua\s+|all\s+)?(?:kata\s+kasar|curse\s+words?|profanit(?:y|ies)|swears?)/i.test(q)) {
    const matchingIndices = findWordsToBleep(allWords, 'curse');
    return {
      op: 'bleep-words',
      term: 'curse',
      wordIndices: matchingIndices,
      label: `Bleep ${matchingIndices.length} curse word${matchingIndices.length === 1 ? '' : 's'}`,
      explanation: matchingIndices.length
        ? `Found ${matchingIndices.length} profanities to censor with 1kHz bleep tone.`
        : 'No profanities detected in transcript.',
    };
  }

  // 1c. Bleep specific word: "bleep kata IHSG", "sensor kata 'anjing'", "censor word 'X'"
  const bleepWordMatch = q.match(/(?:bleep|sensor|censor|mute)\s+(?:semua\s+|all\s+)?(?:kata\s+|word\s+)?['"“]?([^'"”\s]+)['"”]?/i);
  if (bleepWordMatch && !/(?:kasar|curse|profanit)/i.test(bleepWordMatch[1])) {
    const term = bleepWordMatch[1].trim().toLowerCase().replace(/[.,!?;:]+$/, '');
    if (term && term !== 'this' && term !== 'ini') {
      const matchingIndices = [];
      for (let i = 0; i < allWords.length; i++) {
        const cleanW = allWords[i].w.toLowerCase().replace(/[.,!?;:]+$/, '');
        if (cleanW === term) matchingIndices.push(allWords[i].i ?? i);
      }
      return {
        op: 'bleep-words',
        term,
        wordIndices: matchingIndices,
        label: `Bleep "${term}" (${matchingIndices.length} occurrence${matchingIndices.length === 1 ? '' : 's'})`,
        explanation: matchingIndices.length
          ? `Censors ${matchingIndices.length} occurrences of "${term}" with 1kHz tone and mutes audio.`
          : `Word "${term}" not found in transcript.`,
      };
    }
  }

  // 2. Add pause: "kasih jeda 0.3s setelah kata ini", "add pause 0.5s"
  const pauseMatch = q.match(/(?:kasih|tambah(?:kan)?|add|insert)?\s*(?:jeda|pause)\s*(\d+(?:\.\d+)?)\s*(?:s|detik|sec)?/i) ||
                     q.match(/(\d+(?:\.\d+)?)\s*(?:s|detik|sec)\s*(?:jeda|pause)/i);
  if (pauseMatch) {
    const sec = Math.min(5, Math.max(0.1, parseFloat(pauseMatch[1]) || 0.3));
    const targetIdx = lastWord ? lastWord.i : 0;
    const targetText = lastWord ? `"${lastWord.w}"` : 'selected position';
    return {
      op: 'add-pause',
      atWord: targetIdx,
      sec: +sec.toFixed(2),
      wordIndices: [targetIdx],
      label: `Add ${sec}s pause after ${targetText}`,
      explanation: `Inserts a ${sec}s silence/pause after ${targetText}.`,
    };
  }

  // 3. Zoom punch: "zoom punch here", "zoom disini", "kasih zoom", "punch here"
  if (/(?:zoom\s*punch|zoom\s*in|punch|kasih\s*zoom)/i.test(q)) {
    const targetIdx = firstWord ? firstWord.i : 0;
    const targetText = firstWord ? `"${firstWord.w}"` : 'current point';
    return {
      op: 'add-punch',
      atWord: targetIdx,
      scale: 1.15,
      wordIndices: [targetIdx],
      label: `Zoom punch on ${targetText}`,
      explanation: `Applies 1.15× FYP zoom punch emphasis at ${targetText}.`,
    };
  }

  // 4. Keep / protect: "jangan dipotong", "biarkan", "keep this", "don't cut"
  if (/(?:jangan\s*di?potong|biarkan|pertahankan|protect|keep|don't\s*cut|save|do\s*not\s*cut)/i.test(q)) {
    const indices = selectedWords.length
      ? selectedWords.map((w) => w.i)
      : (firstWord ? [firstWord.i] : []);
    return {
      op: 'keep-range',
      wordIndices: indices,
      label: `Keep ${indices.length} word${indices.length === 1 ? '' : 's'}`,
      explanation: 'Protected from automatic and manual cuts (force-keep).',
    };
  }

  // 5. Cut / delete: "potong", "hapus", "buang", "cut this", "delete"
  if (/(?:potong|cut|delete|remove|buang|hapus|drop)/i.test(q)) {
    const indices = selectedWords.length
      ? selectedWords.map((w) => w.i)
      : (firstWord ? [firstWord.i] : []);
    return {
      op: 'cut-range',
      wordIndices: indices,
      label: `Cut ${indices.length} word${indices.length === 1 ? '' : 's'}`,
      explanation: 'Marked for removal from final edit (force-cut).',
    };
  }

  // Fallback: general query
  return {
    op: 'unknown',
    wordIndices: selectedWords.map((w) => w.i),
    label: 'Instruction not recognized',
    explanation: 'Try commands like: "jangan dipotong bagian ini", "kasih jeda 0.3s", "zoom punch here", or "cari semua \'X\' dan zoom punch".',
  };
}

/**
 * Execute chat operation on project model.
 * Returns true if state changed.
 */
export function applyChatOp(project, op) {
  if (!project || !op) return false;
  const ov = project.activeOverrides || project.overrides || { cuts: [], keeps: [] };
  const cuts = new Set((ov.cuts || []).filter((c) => typeof c === 'number'));
  const keeps = new Set(ov.keeps || []);

  switch (op.op) {
    case 'keep-range':
      for (const i of op.wordIndices || []) {
        cuts.delete(i);
        keeps.add(i);
      }
      ov.cuts = [...cuts];
      ov.keeps = [...keeps];
      return true;

    case 'cut-range':
      for (const i of op.wordIndices || []) {
        keeps.delete(i);
        cuts.add(i);
      }
      ov.cuts = [...cuts];
      ov.keeps = [...keeps];
      return true;

    case 'add-pause':
      if (project.edl && op.atWord != null) {
        const w = project.words?.[op.atWord];
        if (w) {
          // Find segment containing this word in edl
          const seg = project.edl.keep.find((k) => w.start >= k.in && w.start < k.out);
          if (seg) {
            seg.freeze = (seg.freeze || 0) + (op.sec || 0.3);
            return true;
          }
        }
      }
      return false;

    case 'add-punch':
      if (project.edl && op.atWord != null) {
        const w = project.words?.[op.atWord];
        if (w) {
          const punchAt = (w.start + w.end) / 2;
          project.edl.punches = project.edl.punches || [];
          project.edl.punches.push({
            at: punchAt,
            scale: op.scale || 1.15,
            ms: 400,
            kind: 'emphasis',
          });
          project.edl.punches.sort((a, b) => a.at - b.at);
          return true;
        }
      }
      return false;

    case 'multi-punch':
      if (project.edl && op.wordIndices?.length) {
        project.edl.punches = project.edl.punches || [];
        for (const idx of op.wordIndices) {
          const w = project.words?.[idx];
          if (w) {
            const punchAt = (w.start + w.end) / 2;
            if (!project.edl.punches.some((p) => Math.abs(p.at - punchAt) < 0.3)) {
              project.edl.punches.push({
                at: punchAt,
                scale: op.scale || 1.15,
                ms: 400,
                kind: 'emphasis',
              });
            }
          }
        }
        project.edl.punches.sort((a, b) => a.at - b.at);
        return true;
      }
      return false;

    case 'bleep-words':
      if (project.words && op.wordIndices?.length) {
        project.bleeps = project.bleeps || [];
        for (const idx of op.wordIndices) {
          if (project.words[idx]) {
            project.words[idx].bleep = true;
            if (!project.bleeps.includes(idx)) project.bleeps.push(idx);
          }
        }
        return true;
      }
      return false;

    default:
      return false;
  }
}
