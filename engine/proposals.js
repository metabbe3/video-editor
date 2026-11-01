// proposals.js — Candidate cut proposal generation and management.
// Pure decision logic: no DOM, node-testable.
// Part of Nila Sprint 2: Propose -> Debate -> Apply flow.

import {
  TUNING, FILLER_RE, FILLER_ID_PHRASES, FILLERS_PHRASES,
  snapCutIn, snapCutOut, calibrateThreshold, normalizeKeeps,
} from './edit-engine.js';

/**
 * Generate cut proposals from transcript words, silence map, and energy curve.
 * Candidates are NOT auto-applied. Status rules:
 * - filler (matching FILLER_RE) -> default 'accepted'
 * - phrase / pause / gap -> default 'pending'
 */
export function generateProposals(words, duration, { silence = [], energy = null, hopSec = 0.02, tuning = TUNING } = {}) {
  const proposals = [];
  let propCounter = 0;
  const thresh = energy ? calibrateThreshold(energy) : -35;

  const addProp = (start, end, why, kind, status, wordIndices = [], meta = {}) => {
    let s = Math.max(0, start);
    let e = Math.min(duration, end);
    if (e - s < 0.02) return;
    if (energy) {
      s = snapCutOut(s, energy, hopSec, { threshold: thresh });
      e = snapCutIn(e, energy, hopSec, { threshold: thresh });
    }
    if (e - s < 0.02) return;

    proposals.push({
      id: `prop_${++propCounter}`,
      start: +s.toFixed(3),
      end: +e.toFixed(3),
      duration: +(e - s).toFixed(3),
      why,
      kind, // 'filler' | 'phrase' | 'pause' | 'gap'
      status, // 'accepted' | 'pending' | 'rejected'
      wordIndices,
      ...meta,
    });
  };

  // 1. Standalone fillers -> default accepted
  for (let i = 0; i < (words || []).length; i++) {
    const w = words[i];
    if (FILLER_RE.test(w.w)) {
      addProp(w.start - 0.02, w.end + 0.06, `filler "${w.w}"`, 'filler', 'accepted', [i], { wordText: w.w });
    }
  }

  // 1b. Indonesian & English filler phrases -> default pending
  const textAt = (idx) => words[idx]?.w.toLowerCase().replace(/[.,!?;:]+$/, '');
  const allPhrases = [...FILLER_ID_PHRASES, ...FILLERS_PHRASES];
  for (let i = 0; i < (words || []).length - 1; i++) {
    for (const ph of allPhrases) {
      const parts = ph.split(' ');
      let match = true;
      for (let j = 0; j < parts.length; j++) {
        if (i + j >= words.length || textAt(i + j) !== parts[j]) { match = false; break; }
      }
      if (match) {
        const wIdxs = [];
        for (let j = 0; j < parts.length; j++) wIdxs.push(i + j);
        addProp(words[i].start - 0.02, words[i + parts.length - 1].end + 0.06, `phrase "${ph}"`, 'phrase', 'pending', wIdxs, { phrase: ph });
        i += parts.length - 1;
        break;
      }
    }
  }

  // 2. Long pauses from silence detector -> default pending
  for (const s of silence) {
    const dur = s.end - s.start;
    if (dur < tuning.minSilence) continue;
    const half = tuning.residualPause / 2;
    const mid = s.minAt ?? (s.start + s.end) / 2;
    const cutStart = s.start;
    const cutEnd = Math.max(s.start, mid - half);
    if (cutEnd - cutStart > 0.04) {
      addProp(cutStart, cutEnd, `pause ${dur.toFixed(1)}s`, 'pause', 'pending', [], { pauseSec: dur });
    }
    const cutStart2 = Math.min(s.end, mid + half);
    const cutEnd2 = s.end;
    if (cutEnd2 - cutStart2 > 0.04) {
      addProp(cutStart2, cutEnd2, `pause ${dur.toFixed(1)}s`, 'pause', 'pending', [], { pauseSec: dur });
    }
  }

  // 3. Word-gap pauses (transcript level) -> default pending
  for (let i = 1; i < (words || []).length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap > tuning.pauseGapTrigger) {
      const half = tuning.residualPause / 2;
      const mid = (words[i - 1].end + words[i].start) / 2;
      const cut1Start = words[i - 1].end;
      const cut1End = mid - half;
      const cut2Start = mid + half;
      const cut2End = words[i].start - tuning.padLead;
      if (cut1End - cut1Start > 0.04) {
        addProp(cut1Start, cut1End, `gap ${gap.toFixed(1)}s`, 'gap', 'pending', [], { afterWord: i - 1, beforeWord: i, gapSec: gap });
      }
      if (cut2End - cut2Start > 0.04) {
        addProp(cut2Start, cut2End, `gap ${gap.toFixed(1)}s`, 'gap', 'pending', [], { afterWord: i - 1, beforeWord: i, gapSec: gap });
      }
    }
  }

  // Sort chronologically and deduplicate overlapping proposals
  proposals.sort((a, b) => a.start - b.start);
  return proposals;
}

/** Compute total cuts, duration reduced, and percentage */
export function proposalSummary(proposals, duration) {
  if (!proposals || !proposals.length || duration <= 0) {
    return { count: 0, durationSec: 0, percent: 0, text: 'No cuts proposed' };
  }
  // Merge intervals to avoid counting overlaps twice
  const accepted = proposals.filter((p) => p.status === 'accepted' || p.status === 'pending');
  let cutTime = 0;
  const merged = [];
  for (const p of [...accepted].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && p.start <= last.end) {
      last.end = Math.max(last.end, p.end);
    } else {
      merged.push({ start: p.start, end: p.end });
    }
  }
  for (const m of merged) cutTime += m.end - m.start;
  const pct = Math.min(95, Math.max(0, Math.round((cutTime / duration) * 100)));
  const count = proposals.length;
  return {
    count,
    durationSec: +cutTime.toFixed(1),
    percent: pct,
    text: `${count} cuts proposed · −${pct}% duration`,
  };
}

/** Convert accepted proposals into keeps for the EDL */
export function proposalsToKeeps(proposals, duration, tuning = TUNING) {
  const accepted = (proposals || []).filter((p) => p.status === 'accepted');
  if (!accepted.length) {
    return [{ in: 0, out: duration, why: 'speech' }];
  }
  // Invert accepted cuts into kept segments
  const sorted = accepted.sort((a, b) => a.start - b.start)
    .reduce((acc, r) => {
      const last = acc[acc.length - 1];
      if (last && r.start <= last.end) {
        last.end = Math.max(last.end, r.end);
        last.why ||= r.why;
      } else {
        acc.push({ ...r });
      }
      return acc;
    }, []);

  const keeps = [];
  let t = 0;
  for (const r of sorted) {
    if (r.start > t + 0.02) keeps.push({ in: t, out: r.start, why: 'speech' });
    t = Math.max(t, r.end);
  }
  if (t < duration - 0.02) keeps.push({ in: t, out: duration, why: 'speech' });
  return normalizeKeeps(keeps, duration, tuning);
}

/** Toggle a proposal between accepted and rejected */
export function toggleProposalStatus(proposals, id) {
  const p = proposals?.find((x) => x.id === id);
  if (!p) return null;
  p.status = p.status === 'accepted' ? 'rejected' : 'accepted';
  return p;
}

/** Accept all proposals */
export function acceptAllProposals(proposals) {
  for (const p of proposals || []) p.status = 'accepted';
  return proposals;
}

/** Reject / dismiss all proposals */
export function rejectAllProposals(proposals) {
  for (const p of proposals || []) p.status = 'rejected';
  return proposals;
}
