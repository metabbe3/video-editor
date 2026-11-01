// test/sprint2.test.mjs — Unit tests for Nila Sprint 2 pure logic
// node --test test/sprint2.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adaptivePads, voiceActivityGuard, snapAsymmetricBoundary,
  snapCutIn, snapCutOut, calibrateThreshold, freezeWords,
} from '../engine/edit-engine.js';
import {
  generateProposals, proposalSummary, proposalsToKeeps,
  toggleProposalStatus, acceptAllProposals, rejectAllProposals,
} from '../engine/proposals.js';
import { voteProposalLocal, runDebateCouncil } from '../engine/council-vote.js';
import { parseChatCommand, applyChatOp } from '../engine/chat-ops.js';

const W = (w, start, end, i = 0) => ({ i, w, start, end });

// =========================================================================
// 1. Wave-Aware Boundaries (Engine Upgrade)
// =========================================================================

test('adaptivePads: clamps lead to [40ms, 120ms] and tail to [60ms, 180ms]', () => {
  // Small gaps: gapPrev = 0.08s -> 0.08 * 0.25 = 0.02s -> clamped to min 0.04s
  const prevSmall = W('hello', 0.0, 0.5);
  const w = W('world', 0.58, 0.9);
  const nextSmall = W('again', 0.95, 1.2);
  const smallPads = adaptivePads(w, prevSmall, nextSmall);
  assert.equal(smallPads.padLead, 0.04);
  assert.equal(smallPads.padTail, 0.06);

  // Large gaps: gapPrev = 2.0s -> 2.0 * 0.25 = 0.5s -> clamped to max 0.12s
  const prevBig = W('hello', 0.0, 0.5);
  const w2 = W('world', 2.5, 3.0);
  const nextBig = W('again', 5.0, 5.5);
  const bigPads = adaptivePads(w2, prevBig, nextBig);
  assert.equal(bigPads.padLead, 0.12);
  assert.equal(bigPads.padTail, 0.18);
});

test('adaptivePads: plosive on onset (/p|t|k|b|d|g/) enforces padLead >= 80ms', () => {
  const prev = W('see', 0.0, 0.5);
  // 'power' starts with 'p' (plosive) with small gap 0.08s
  const w = W('power', 0.58, 0.9);
  const pads = adaptivePads(w, prev, null);
  // Normally gap 0.08 * 0.25 = 0.02 -> 0.04s, but plosive lifts to min 0.08s
  assert.equal(pads.padLead, 0.08);

  // Non-plosive 'water' gets standard 0.04s
  const wNon = W('water', 0.58, 0.9);
  const padsNon = adaptivePads(wNon, prev, null);
  assert.equal(padsNon.padLead, 0.04);
});

test('voiceActivityGuard: does not cut sustained voicing plateau (> threshold * 0.5 for > 80ms)', () => {
  const hop = 0.02;
  const n = 100; // 2.0s
  const energy = new Float32Array(n);
  energy.fill(0.001); // quiet

  // Voiced plateau from 0.8s to 1.4s (30 hops = 600ms > 80ms)
  for (let i = 40; i <= 70; i++) energy[i] = 0.25;

  const threshold = 0.05; // voiceThresh = 0.025, 0.25 is well above it

  // Case A: cut-IN boundary lands in the middle of speech (1.0s = hop 50)
  // Guard must shift earlier to speech start (0.8s = hop 40)
  const guardedIn = voiceActivityGuard(1.0, energy, hop, threshold, 'in');
  assert.ok(Math.abs(guardedIn - 0.8) < 0.021, `got ${guardedIn}, expected 0.8`);

  // Case B: cut-OUT boundary lands in the middle of speech (1.0s)
  // Guard must shift later to speech end (1.42s = hop 71)
  const guardedOut = voiceActivityGuard(1.0, energy, hop, threshold, 'out');
  assert.ok(Math.abs(guardedOut - 1.42) < 0.021, `got ${guardedOut}, expected 1.42`);

  // Case C: boundary in quiet region (0.3s) is unaffected
  const guardedQuiet = voiceActivityGuard(0.3, energy, hop, threshold, 'in');
  assert.equal(guardedQuiet, 0.3);
});

test('snapCutIn snaps to rising attack edge, snapCutOut snaps to release', () => {
  const hop = 0.02;
  const energy = new Float32Array(150);
  energy.fill(0.001); // quiet valley

  // Valley from 0.0 to 1.0s, rising attack at 1.0s to 1.2s, speech plateau to 2.0s
  for (let i = 50; i < 60; i++) energy[i] = 0.001 + (i - 50) * 0.02;
  for (let i = 60; i <= 100; i++) energy[i] = 0.2;

  // cut-IN near 0.95s: should snap to attack rising edge ~1.02s
  const cutIn = snapCutIn(0.95, energy, hop, { threshold: 0.1 });
  assert.ok(cutIn >= 1.0 && cutIn <= 1.06, `got ${cutIn}`);

  // Now create a decay/release: from 2.0s (hop 100) energy drops to 2.2s (hop 110)
  for (let i = 100; i <= 110; i++) energy[i] = 0.2 - (i - 100) * 0.018;
  for (let i = 111; i < 150; i++) energy[i] = 0.001;

  // cut-OUT near 2.05s: should snap to decay/release edge ~2.18s
  const cutOut = snapCutOut(2.05, energy, hop, { threshold: 0.1 });
  assert.ok(cutOut >= 2.14 && cutOut <= 2.24, `got ${cutOut}`);
});

test('snapAsymmetricBoundary: Whisper drift guard reverts when |snap - wordBoundary| > 60ms', () => {
  const hop = 0.02;
  const energy = new Float32Array(200);
  energy.fill(0.15); // speech
  // Big distant valley at 1.30s (hop 65)
  energy[65] = 0.0001;
  // Local valley near wordBoundary at 1.48s (hop 74)
  energy[74] = 0.002;

  const wordBoundary = 1.5;
  // t is at 1.48s (hop 74) where local valley is
  const snapped = snapAsymmetricBoundary(1.48, energy, hop, {
    mode: 'in',
    wordBoundary,
    window: 0.2, // window reaches 1.30s (hop 65)
  });
  // Since snap to 1.30s is > 60ms away from wordBoundary (1.5s), and 1.48s is near wordBoundary,
  // Whisper drift guard reverts to wordBoundary (1.5)
  assert.equal(snapped, wordBoundary);
});

// =========================================================================
// 2. Proposal Flow & Summary (Sprint 2 Feature 1)
// =========================================================================

test('generateProposals: categorizes fillers as accepted, phrases and pauses as pending', () => {
  const words = freezeWords([
    W('so', 0.0, 0.3),
    W('um', 0.4, 0.6),            // standalone filler -> accepted
    W('nah', 1.0, 1.2),           // phrase 'nah jadi' -> pending
    W('jadi', 1.25, 1.5),
    W('kita', 2.8, 3.2),          // 1.3s gap from 1.5 to 2.8 -> pending gap
  ]);

  const props = generateProposals(words, 4.0);
  assert.ok(props.length >= 2);

  const fillerProp = props.find((p) => p.kind === 'filler');
  assert.ok(fillerProp, 'must have filler proposal');
  assert.equal(fillerProp.status, 'accepted');

  const phraseProp = props.find((p) => p.kind === 'phrase');
  assert.ok(phraseProp, 'must have phrase proposal');
  assert.equal(phraseProp.status, 'pending');

  const gapProp = props.find((p) => p.kind === 'gap');
  assert.ok(gapProp, 'must have gap proposal');
  assert.equal(gapProp.status, 'pending');
});

test('proposalSummary: calculates total count, duration reduction and formatted string', () => {
  const proposals = [
    { id: 'p1', start: 1.0, end: 1.5, status: 'accepted' }, // 0.5s
    { id: 'p2', start: 3.0, end: 4.0, status: 'pending' },  // 1.0s
    { id: 'p3', start: 6.0, end: 6.3, status: 'rejected' }, // 0.3s (excluded)
  ];
  const sum = proposalSummary(proposals, 10.0);
  assert.equal(sum.count, 3);
  assert.equal(sum.durationSec, 1.5);
  assert.equal(sum.percent, 15);
  assert.equal(sum.text, '3 cuts proposed · −15% duration');
});

test('proposalsToKeeps: converts only accepted proposals into keeps', () => {
  const duration = 10.0;
  const proposals = [
    { id: 'p1', start: 2.0, end: 3.0, status: 'accepted', why: 'filler' },
    { id: 'p2', start: 6.0, end: 7.0, status: 'rejected', why: 'dramatic pause' },
  ];
  const keeps = proposalsToKeeps(proposals, duration);
  // Only p1 cut: keeps should be [0..2.0] and [3.0..10.0]
  assert.equal(keeps.length, 2);
  assert.ok(Math.abs(keeps[0].in - 0.0) < 0.02);
  assert.ok(Math.abs(keeps[0].out - 2.0) < 0.02);
  assert.ok(Math.abs(keeps[1].in - 3.0) < 0.02);
  assert.ok(Math.abs(keeps[1].out - 10.0) < 0.02);
});

test('proposal status mutations: toggle, acceptAll, rejectAll', () => {
  const props = [
    { id: 'p1', status: 'pending' },
    { id: 'p2', status: 'accepted' },
  ];
  toggleProposalStatus(props, 'p1');
  assert.equal(props[0].status, 'accepted');
  toggleProposalStatus(props, 'p1');
  assert.equal(props[0].status, 'rejected');

  acceptAllProposals(props);
  assert.ok(props.every((p) => p.status === 'accepted'));

  rejectAllProposals(props);
  assert.ok(props.every((p) => p.status === 'rejected'));
});

// =========================================================================
// 3. Debate Council (Sprint 2 Feature 2)
// =========================================================================

test('voteProposalLocal: Storyteller preserves dramatic pause before emphatic word', () => {
  const words = [
    W('ini', 0.0, 0.4),
    W('rahasianya', 1.2, 1.8), // dramatic word 'rahasianya' after 0.8s pause
  ];
  const proposal = { id: 'p1', kind: 'pause', start: 0.4, end: 1.2, duration: 0.8 };
  const verdict = voteProposalLocal(proposal, { words });

  // Storyteller votes keep; Momentum votes cut; Audio votes keep (< 0.6s fallback or ambient)
  const storyVote = verdict.votes.find((v) => v.persona === 'Storyteller');
  assert.equal(storyVote.vote, 'keep');
  assert.ok(storyVote.reason.includes('jeda dramatis'));
});

test('voteProposalLocal: AudioEngineer votes cut when RMS is in true silence valley', () => {
  const hop = 0.02;
  const energy = new Float32Array(100);
  energy.fill(0.0001); // -40dB true silence

  const proposal = { id: 'p1', kind: 'pause', start: 0.2, end: 0.8, duration: 0.6 };
  const verdict = voteProposalLocal(proposal, { energy, hopSec: hop, thresholdDb: -35 });

  const audioVote = verdict.votes.find((v) => v.persona === 'AudioEngineer');
  assert.equal(audioVote.vote, 'cut');
  assert.ok(audioVote.reason.includes('True silence'));
});

test('runDebateCouncil: tallies votes, updates statuses and produces summary string', async () => {
  const words = [W('hello', 0.0, 0.4), W('world', 1.2, 1.6)];
  const proposals = [
    { id: 'p1', kind: 'filler', status: 'accepted', duration: 0.2 },
    { id: 'p2', kind: 'pause', status: 'pending', start: 0.4, end: 1.2, duration: 0.8 },
  ];

  const { summary } = await runDebateCouncil(proposals, { words });
  assert.equal(summary.fillersAuto, 1);
  assert.ok(summary.text.includes('filler 1 auto'));
  assert.ok(summary.pauseAccepted + summary.pauseRejected >= 1);
});

// =========================================================================
// 4. AI Chat Box Operations (Sprint 2 Feature 4)
// =========================================================================

test('parseChatCommand: parses Indonesian and English commands accurately', () => {
  const selected = [W('IHSG', 2.0, 2.5, 3)];
  const allWords = [
    W('pasar', 0.0, 0.4, 0),
    W('saham', 0.5, 0.9, 1),
    W('dan', 1.0, 1.3, 2),
    W('IHSG', 1.4, 1.8, 3),
    W('hari', 1.9, 2.2, 4),
    W('ini', 2.3, 2.6, 5),
    W('IHSG', 3.0, 3.4, 6),
  ];

  // 1. Keep / protect (Indonesian)
  const cmdKeep = parseChatCommand('jangan dipotong bagian ini', { selectedWords: selected, allWords });
  assert.equal(cmdKeep.op, 'keep-range');
  assert.deepEqual(cmdKeep.wordIndices, [3]);

  // 2. Cut (English)
  const cmdCut = parseChatCommand('cut this word', { selectedWords: selected, allWords });
  assert.equal(cmdCut.op, 'cut-range');
  assert.deepEqual(cmdCut.wordIndices, [3]);

  // 3. Add pause (Indonesian)
  const cmdPause = parseChatCommand('kasih jeda 0.3s setelah kata ini', { selectedWords: selected, allWords });
  assert.equal(cmdPause.op, 'add-pause');
  assert.equal(cmdPause.sec, 0.3);
  assert.equal(cmdPause.atWord, 3);

  // 4. Zoom punch (English)
  const cmdPunch = parseChatCommand('zoom punch here', { selectedWords: selected, allWords });
  assert.equal(cmdPunch.op, 'add-punch');
  assert.equal(cmdPunch.atWord, 3);

  // 5. Search & multi-punch (Indonesian)
  const cmdMulti = parseChatCommand("cari semua 'IHSG' dan zoom punch", { selectedWords: [], allWords });
  assert.equal(cmdMulti.op, 'multi-punch');
  assert.equal(cmdMulti.term, 'ihsg');
  assert.deepEqual(cmdMulti.wordIndices, [3, 6]);
});

test('applyChatOp: modifies overrides and punches correctly', () => {
  const project = {
    words: [W('a', 0.0, 0.5, 0), W('b', 0.6, 1.0, 1)],
    activeOverrides: { cuts: [1], keeps: [] },
    edl: { keep: [{ in: 0, out: 1.0 }], punches: [] },
  };

  // Keep range clears cut and adds keep
  applyChatOp(project, { op: 'keep-range', wordIndices: [1] });
  assert.deepEqual(project.activeOverrides.keeps, [1]);
  assert.deepEqual(project.activeOverrides.cuts, []);

  // Add punch adds punch item
  applyChatOp(project, { op: 'add-punch', atWord: 0, scale: 1.15 });
  assert.equal(project.edl.punches.length, 1);
  assert.equal(project.edl.punches[0].scale, 1.15);
  assert.equal(project.edl.punches[0].at, 0.25);
});
