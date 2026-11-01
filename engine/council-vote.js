// council-vote.js — Local heuristic and GLM-assisted debate council.
// Pure decision logic: no DOM, node-testable.
// Part of Nila Sprint 2: 3-persona debate (MomentumEditor, Storyteller, AudioEngineer).

import { dbToLin } from './edit-engine.js';

const DRAMATIC_WORDS = /^(tapi|namun|karena|rahasianya|masalahnya|sudah|penting|ingat|bayangkan|tetapi|sebenarnya|but|however|because|secret|never|always|actually|listen|imagine|look|first|finally|key|why|what|how)/i;

/**
 * Vote on a single proposal using 3 distinct local heuristics.
 * Personas:
 * 1. MomentumEditor: high tempo, aggressive cuts of dead air.
 * 2. Storyteller: narrative pacing, preserves dramatic pauses before key words.
 * 3. AudioEngineer: acoustic energy, cuts only when RMS energy drops to true silence.
 */
export function voteProposalLocal(proposal, context = {}) {
  const { words = [], energy = null, hopSec = 0.02, thresholdDb = -35 } = context;
  const dur = proposal.duration || (proposal.end - proposal.start);
  const votes = [];

  // 1. MomentumEditor
  if (proposal.kind === 'filler' || proposal.kind === 'phrase') {
    votes.push({ persona: 'MomentumEditor', vote: 'cut', reason: 'Tighten rhythm, remove filler' });
  } else if (dur >= 0.35) {
    votes.push({ persona: 'MomentumEditor', vote: 'cut', reason: 'Speed up pacing, cut dead air' });
  } else {
    votes.push({ persona: 'MomentumEditor', vote: 'keep', reason: 'Natural rhythm beat' });
  }

  // 2. Storyteller
  if (proposal.kind === 'filler') {
    votes.push({ persona: 'Storyteller', vote: 'cut', reason: 'Distracting filler' });
  } else {
    // Look ahead to the word following this pause
    const nextWord = words.find((w) => w.start >= proposal.end - 0.05);
    const prevWord = [...words].reverse().find((w) => w.end <= proposal.start + 0.05);
    const isDramaticWord = nextWord && DRAMATIC_WORDS.test(nextWord.w.replace(/[.,!?;:]+$/, ''));
    const isPunctuationPause = prevWord && /[?!]$/.test(prevWord.w);
    const isCapitalizedOnset = nextWord && /^[A-Z][a-z]/.test(nextWord.w);

    if (dur <= 1.2 && (isDramaticWord || isPunctuationPause || isCapitalizedOnset)) {
      votes.push({
        persona: 'Storyteller',
        vote: 'keep',
        reason: isDramaticWord ? `jeda dramatis sebelum "${nextWord.w}"` : 'jeda dramatis untuk penekanan',
      });
    } else if (dur > 1.2) {
      votes.push({ persona: 'Storyteller', vote: 'cut', reason: 'Dead air loses audience' });
    } else {
      votes.push({ persona: 'Storyteller', vote: 'cut', reason: 'Routine pause' });
    }
  }

  // 3. AudioEngineer
  if (energy && energy.length && hopSec > 0) {
    const sIdx = Math.max(0, Math.floor(proposal.start / hopSec));
    const eIdx = Math.min(energy.length - 1, Math.ceil(proposal.end / hopSec));
    let minVal = Infinity;
    let sumVal = 0;
    let count = 0;
    for (let i = sIdx; i <= eIdx; i++) {
      const v = energy[i] ?? 0;
      if (v < minVal) minVal = v;
      sumVal += v;
      count++;
    }
    const avgVal = count > 0 ? sumVal / count : 0;
    const threshLin = dbToLin(thresholdDb);

    // If audio is truly silent / room tone in the valley -> clean cut
    if (minVal <= threshLin * 1.35) {
      votes.push({ persona: 'AudioEngineer', vote: 'cut', reason: `True silence (< ${thresholdDb.toFixed(0)}dB)` });
    } else {
      // Audio still has background noise, breath, or room rumble
      votes.push({ persona: 'AudioEngineer', vote: 'keep', reason: 'Ambient energy present, prevent gate pump' });
    }
  } else {
    // Energy curve not available -> duration heuristic
    if (dur >= 0.6) {
      votes.push({ persona: 'AudioEngineer', vote: 'cut', reason: 'Significant gap (> 0.6s)' });
    } else {
      votes.push({ persona: 'AudioEngineer', vote: 'keep', reason: 'Natural breath / room tone' });
    }
  }

  // Tally votes
  const cutVotes = votes.filter((v) => v.vote === 'cut');
  const keepVotes = votes.filter((v) => v.vote === 'keep');
  const decision = cutVotes.length >= 2 ? 'cut' : 'keep';
  const dissenting = votes.find((v) => v.vote !== decision);

  let summaryReason = '';
  if (decision === 'keep') {
    const storyKeep = votes.find((v) => v.persona === 'Storyteller' && v.vote === 'keep');
    const audioKeep = votes.find((v) => v.persona === 'AudioEngineer' && v.vote === 'keep');
    if (storyKeep) summaryReason = `kept: ${storyKeep.reason} (Storyteller)`;
    else if (audioKeep) summaryReason = `kept: ${audioKeep.reason} (AudioEngineer)`;
    else summaryReason = 'kept by council vote';
  } else {
    summaryReason = cutVotes[0]?.reason || 'cut by council vote';
  }

  return {
    decision,
    accepted: decision === 'cut',
    votes,
    consensus: `${Math.max(cutVotes.length, keepVotes.length)}-${Math.min(cutVotes.length, keepVotes.length)}`,
    dissent: dissenting ? dissenting.persona : null,
    summaryReason,
  };
}

/**
 * Execute debate council on all pending proposals.
 * Can optionally query GLM for borderline (2-1 split) proposals if apiKey is supplied.
 */
export async function runDebateCouncil(proposals, context = {}, { glmClient = null } = {}) {
  let fillersAuto = 0;
  let pauseAccepted = 0;
  let pauseRejected = 0;
  let dissentCount = 0;

  for (const p of proposals || []) {
    if (p.kind === 'filler' && p.status === 'accepted') {
      fillersAuto++;
      continue;
    }
    // Only vote on pending or contested proposals
    if (p.status === 'pending' || !p.debateVerdict) {
      const verdict = voteProposalLocal(p, context);
      p.debateVerdict = verdict;
      p.status = verdict.accepted ? 'accepted' : 'rejected';
      if (verdict.accepted) {
        pauseAccepted++;
        p.acceptedReason = verdict.summaryReason;
      } else {
        pauseRejected++;
        p.keptReason = verdict.summaryReason;
      }
      if (verdict.dissent) dissentCount++;
    } else if (p.status === 'accepted') {
      pauseAccepted++;
    } else if (p.status === 'rejected') {
      pauseRejected++;
    }
  }

  // Optional GLM second opinion for up to 10 contested (2-1) proposals
  if (glmClient?.apiKey) {
    const borderline = (proposals || []).filter((p) => p.debateVerdict?.consensus === '2-1').slice(0, 10);
    if (borderline.length) {
      try {
        await arbitrateWithGlm(borderline, context, glmClient);
      } catch (err) {
        console.warn('GLM council arbitration skipped (using local verdict):', err?.message || err);
      }
    }
  }

  const dissentText = dissentCount ? ` (${dissentCount} vote lawan)` : '';
  const text = `filler ${fillersAuto} auto · pause: ${pauseAccepted} accepted / ${pauseRejected} rejected${dissentText}`;

  return {
    proposals,
    summary: {
      fillersAuto,
      pauseAccepted,
      pauseRejected,
      dissentCount,
      text,
    },
  };
}

/** Single batch GLM call to arbitrate contested proposals */
async function arbitrateWithGlm(proposals, context, glmClient) {
  const items = proposals.map((p, i) => ({
    id: p.id,
    kind: p.kind,
    duration: p.duration,
    why: p.why,
    localVerdict: p.debateVerdict?.decision,
  }));

  const prompt = `You are a Senior Video Editor arbitrating contested video cut proposals.
For each proposal below, decide "cut" or "keep" based on high retention vs storytelling:
${JSON.stringify(items)}

Respond with ONE JSON array of objects:
[{"id": "prop_...", "decision": "cut"|"keep", "reason": "<short 4-8 word reason>"}]`;

  const resp = await fetch(`${glmClient.baseUrl || 'https://api.z.ai/v1'}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${glmClient.apiKey}` },
    body: JSON.stringify({
      model: glmClient.model || 'glm-5.3-flash',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }),
  });
  if (!resp.ok) return;
  const json = await resp.json();
  const text = json.choices?.[0]?.message?.content || '';
  const parsed = JSON.parse(text.replace(/```(json)?|```/g, '').trim());
  if (!Array.isArray(parsed)) return;

  for (const item of parsed) {
    const p = proposals.find((x) => x.id === item.id);
    if (p && (item.decision === 'cut' || item.decision === 'keep')) {
      p.status = item.decision === 'cut' ? 'accepted' : 'rejected';
      p.glmSecondOpinion = { decision: item.decision, reason: item.reason };
      if (item.decision === 'keep') p.keptReason = `kept: ${item.reason} (AI)`;
      else p.acceptedReason = `cut: ${item.reason} (AI)`;
    }
  }
}
