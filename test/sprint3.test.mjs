// test/sprint3.test.mjs — Unit tests for Nila Sprint 3 pure logic
// node --test test/sprint3.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDirectorIntent, detectVideoTypeAndStance,
  planFocusEdit, generate3Variants,
} from '../engine/director-intent.js';
import { runCouncilRound, voteProposalLocal } from '../engine/council-vote.js';
import { Project } from '../src/core/Project.js';
import { serializeProjectState, applyProjectSnapshot } from '../engine/project-store.js';

const W = (w, start, end, i = 0) => ({ i, w, start, end });

// =========================================================================
// 1. Director Intent Parser & Video Classifier (engine/director-intent.js)
// =========================================================================

test('parseDirectorIntent: parses load/analyze intent in ID and EN', () => {
  const p1 = parseDirectorIntent('editkan video ini', { hasMedia: true });
  assert.equal(p1.intents.length, 1);
  assert.equal(p1.intents[0].type, 'analyze');
  assert.equal(p1.intents[0].params.hasMedia, true);

  const p2 = parseDirectorIntent('analyze this video', { words: [W('hello', 0, 1)] });
  assert.equal(p2.intents[0].type, 'analyze');
  assert.equal(p2.intents[0].params.hasWords, true);

  const p3 = parseDirectorIntent('mulai edit', {});
  assert.equal(p3.intents[0].type, 'analyze');
  assert.equal(p3.intents[0].params.hasMedia, false);
});

test('parseDirectorIntent: parses focus intent with keyword and plan', () => {
  const words = [
    W('Halo', 0.0, 0.5, 0),
    W('pasar', 0.6, 1.0, 1),
    W('IHSG', 1.1, 1.6, 2),
    W('turun', 1.7, 2.2, 3),
    W('drastis.', 2.3, 2.8, 4),
    W('Namun', 3.5, 3.9, 5),
    W('investor', 4.0, 4.5, 6),
    W('tenang.', 4.6, 5.1, 7),
  ];

  const res = parseDirectorIntent('fokus ke IHSG turun', { words, analysis: { duration: 6.0 } });
  assert.equal(res.intents.length, 1);
  const it = res.intents[0];
  assert.equal(it.type, 'focus');
  assert.equal(it.params.term, 'IHSG turun');
  assert.ok(it.params.plan.matched);
  assert.ok(it.params.plan.wordIndices.includes(2));
  assert.ok(it.params.plan.wordIndices.includes(3));
});

test('parseDirectorIntent: parses variants intent with count', () => {
  const res1 = parseDirectorIntent('kasih 3 opsi shorts');
  assert.equal(res1.intents[0].type, 'variants');
  assert.equal(res1.intents[0].params.count, 3);
  assert.equal(res1.intents[0].params.variants.length, 3);

  const res2 = parseDirectorIntent('give me 3 options');
  assert.equal(res2.intents[0].type, 'variants');
  assert.equal(res2.intents[0].params.count, 3);
});

test('parseDirectorIntent: parses stance switch intent', () => {
  const res1 = parseDirectorIntent('bikin lebih agresif');
  assert.equal(res1.intents[0].type, 'stance');
  assert.equal(res1.intents[0].params.stance, 'ruthless');

  const res2 = parseDirectorIntent('calm storytelling');
  assert.equal(res2.intents[0].type, 'stance');
  assert.equal(res2.intents[0].params.stance, 'storyteller');

  const res3 = parseDirectorIntent('make it balanced');
  assert.equal(res3.intents[0].type, 'stance');
  assert.equal(res3.intents[0].params.stance, 'balanced');
});

test('parseDirectorIntent: parses refine intent and extracts feedback', () => {
  const res1 = parseDirectorIntent('rapat potongannya');
  assert.equal(res1.intents[0].type, 'refine');
  assert.equal(res1.intents[0].params.feedback, 'rapat potongannya');

  const res2 = parseDirectorIntent('hook lemot');
  assert.equal(res2.intents[0].type, 'refine');
  assert.equal(res2.intents[0].params.feedback, 'hook lemot');
});

test('parseDirectorIntent: parses export intent with target option', () => {
  const res1 = parseDirectorIntent('export yang A');
  assert.equal(res1.intents[0].type, 'export');
  assert.equal(res1.intents[0].params.targetOption.toLowerCase(), 'a');

  const res2 = parseDirectorIntent('render mp4');
  assert.equal(res2.intents[0].type, 'export');
  assert.equal(res2.intents[0].params.targetOption, null);
});

test('parseDirectorIntent: parses status and help commands', () => {
  const res1 = parseDirectorIntent('bisa apa?');
  assert.equal(res1.intents[0].type, 'status');

  const res2 = parseDirectorIntent('ada apa sekarang');
  assert.equal(res2.intents[0].type, 'status');
});

test('parseDirectorIntent: ambiguous query triggers question with max 3 options', () => {
  const res = parseDirectorIntent('bagusin');
  assert.equal(res.needsClarification, true);
  assert.ok(res.options.length <= 3);
  assert.ok(res.question.length > 0);
});

test('parseDirectorIntent: multi-intent splits and runs in sequence', () => {
  const res = parseDirectorIntent('analyze video ini lalu fokus ke IHSG', {
    words: [W('IHSG', 0, 1)],
    analysis: { duration: 5 },
  });
  assert.equal(res.intents.length, 2);
  assert.equal(res.intents[0].type, 'analyze');
  assert.equal(res.intents[1].type, 'focus');
  assert.equal(res.intents[1].params.term, 'IHSG');
});

test('detectVideoTypeAndStance: classifies financial news as ruthless recommendation', () => {
  const words = [
    W('IHSG', 0, 0.5), W('anjlok', 0.6, 1.0), W('3.5%', 1.1, 1.5),
    W('ke', 1.6, 1.8), W('level', 1.9, 2.2), W('6800', 2.3, 2.8),
    W('saham', 3.0, 3.5), W('perbankan', 3.6, 4.0), W('turun', 4.1, 4.5),
    W('rugi', 4.6, 5.0), W('triliun', 5.1, 5.6),
  ];
  const verdict = detectVideoTypeAndStance(words);
  assert.equal(verdict.detectedType, 'news');
  assert.equal(verdict.recommendedStance, 'ruthless');
  assert.ok(verdict.options.length >= 2);
});

test('detectVideoTypeAndStance: classifies personal storytelling as storyteller recommendation', () => {
  const words = [
    W('Saya', 0, 0.5), W('ingin', 0.6, 1.0), W('cerita', 1.1, 1.5),
    W('tentang', 1.6, 2.0), W('pengalaman', 2.1, 2.7), W('hidup', 2.8, 3.2),
    W('suatu', 3.5, 3.9), W('hari', 4.0, 4.4), W('rasanya', 4.5, 5.0),
    W('berat', 5.1, 5.5), W('ingat', 5.6, 6.0), W('perjalanan', 6.1, 6.7),
  ];
  const verdict = detectVideoTypeAndStance(words);
  assert.equal(verdict.detectedType, 'story');
  assert.equal(verdict.recommendedStance, 'storyteller');
});

// =========================================================================
// 2. Council Iteration Engine (engine/council-vote.js)
// =========================================================================

test('runCouncilRound: applies ruthless stance weights and tighter pauses', () => {
  const proposals = [
    { id: 'p1', kind: 'pause', start: 1.0, end: 1.25, duration: 0.25, status: 'pending' },
    { id: 'p2', kind: 'pause', start: 2.0, end: 2.8, duration: 0.8, status: 'pending' },
  ];

  // In ruthless stance, MomentumEditor gets 1.3 weight and cuts 0.25s pause
  const resRuthless = runCouncilRound(proposals, { stance: 'ruthless' });
  const p1Ruth = resRuthless.proposals.find((p) => p.id === 'p1');
  assert.equal(p1Ruth.status, 'accepted');
  assert.ok(resRuthless.options.length >= 3);

  // In storyteller stance, 0.25s pause is kept
  const resStory = runCouncilRound(proposals, { stance: 'storyteller' });
  const p1Story = resStory.proposals.find((p) => p.id === 'p1');
  assert.equal(p1Story.status, 'rejected');
});

test('runCouncilRound: injects userFeedback into council voting context', () => {
  const proposals = [
    { id: 'p_hook', kind: 'pause', start: 1.0, end: 1.4, duration: 0.4, status: 'pending' },
  ];

  const res = runCouncilRound(proposals, {
    stance: 'balanced',
    userFeedback: 'hook lemot potong jeda awal',
  });
  const pHook = res.proposals[0];
  assert.equal(pHook.status, 'accepted');
  assert.ok(pHook.acceptedReason.includes('hook') || pHook.acceptedReason.includes('Tighten'));
});

// =========================================================================
// 3. Project Model Energy Null-Safety & Persistence
// =========================================================================

test('Project.computeProposals: safely handles analysis.energy null without crashing', () => {
  const p = new Project();
  p.analysis = { duration: 10, energy: null, hopSec: 0.02 };
  p.words = [
    W('hello', 0, 0.5, 0),
    W('um', 1.0, 1.4, 1),
    W('world', 2.0, 2.5, 2),
  ];

  const props = p.computeProposals();
  assert.ok(Array.isArray(props));
  assert.ok(props.length > 0);
  assert.equal(p.proposalsApplied, false);
});

test('project-store: serialize and apply preserve chatLog and stance', () => {
  const p = new Project();
  p.stance = 'ruthless';
  p.chatLog = [
    { role: 'user', text: 'make it ruthless', at: 1000 },
    { role: 'assistant', text: 'Switched stance to Ruthless Viral.', at: 1001 },
  ];

  const snap = serializeProjectState(p);
  assert.equal(snap.stance, 'ruthless');
  assert.equal(snap.chatLog.length, 2);

  const restored = new Project();
  applyProjectSnapshot(restored, snap);
  assert.equal(restored.stance, 'ruthless');
  assert.equal(restored.chatLog.length, 2);
  assert.equal(restored.chatLog[0].text, 'make it ruthless');
});
