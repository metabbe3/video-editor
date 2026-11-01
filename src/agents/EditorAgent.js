// EditorAgent — GLM refine orchestration: persona prompt call, variant splice,
// self-critique loop, long-form contract. Ported from ui.js refineInternal;
// DOM-free (the UI observes via return values + project state).

import { glmRefine, PLATFORMS } from '../../engine/glm.js';
import { applyGlm, salvageJsonArrays } from '../../engine/edit-engine.js';
import { visionIndex, visionContextLines } from '../../engine/vision-index.js';
import { councilSystem } from './council.js';

export class EditorAgent {
  constructor(project, settings) {
    this.p = project;          // Project model
    this.s = settings;         // live settings accessor: { key(), endpoint(), model(), vision() }
  }

  /** honest CURRENT CUT word ranges (stale k.words after trims lie to GLM) */
  currentKeeps() {
    const words = this.p.words, edl = this.p.edl;
    if (!edl?.keep?.length) return null;
    return edl.keep.map((k) => {
      const a = words.findIndex((w) => w.end > k.in);
      let b = -1;
      for (let i = words.length - 1; i >= 0; i--) if (words[i].start < k.out) { b = i; break; }
      return b >= a && a >= 0 ? { ...k, words: [a, b] } : k;
    });
  }

  async visionContext() {
    if (!this.s.vision() || !this.p.reg?.arollId) return '';
    try {
      const entries = await visionIndex(
        { apiKey: this.s.key(), baseUrl: this.s.endpoint(), model: this.s.model() },
        { arollId: this.p.reg.arollId, getFile: (id) => this.p.reg.items.find((r) => r.id === id)?.file,
          duration: this.p.analysis.duration, candidateKeeps: this.p.baseKeeps ?? [] },
      );
      return entries.length ? visionContextLines(entries) : '';
    } catch (e) {
      console.warn('vision pass failed (continuing without):', e.message);
      return '';
    }
  }

  async refine({ ask = '', onStatus = () => {}, getPrompt = () => '', council = false, stance = 'balanced' } = {}) {
    const p = this.p;
    const instructions = ask || getPrompt();
    const platform = p.settings.platform;
    const plat = PLATFORMS[platform] ?? PLATFORMS.shorts;
    let feedback = p.feedback.slice(-5);
    const currentKeeps = this.currentKeeps();
    const visionContext = await this.visionContext();

    const maxPasses = (p.variants?.length || council) ? 1 : 3; // variant/council mode: single pass (the debate happens inside the call)
    let result = null, truncated = false, passes = 0;
    for (let pass = 1; pass <= maxPasses; pass++) {
      onStatus(`GLM editing (pass ${pass})…`);
      const out = await glmRefine(
        { apiKey: this.s.key(), baseUrl: this.s.endpoint(), model: this.s.model(), maxTokens: plat.maxTokens },
        {
          words: p.words, duration: p.analysis.duration,
          brollNames: (p.reg?.brollPool ?? []).map((f) => f.name),
          instructions, feedback, currentKeeps, platform, visionContext,
          systemOverride: council ? councilSystem(stance, (p.edl?.keep ?? []).filter((k) => k.locked).map((k) => k.words ?? [0, 0]).filter((r) => r && r[0] != null)) : null,
        },
      );
      if (out.truncated && out.longForm && passes < 1) { onStatus('Truncated — retrying long-form…'); continue; }
      if (out.truncated && out.longForm) throw new Error('long-form response truncated twice');
      truncated = out.truncated;
      result = applyGlm(truncated ? salvageJsonArrays(out.raw) : out.raw, p.words, p.analysis.duration, {
        energy: p.analysis.energy, hopSec: p.analysis.hopSec,
      });
      passes = pass;
      if ((result.confidence ?? 1) >= 0.75 || pass === maxPasses) break;
      feedback = [...feedback, `Self-critique from pass ${pass}: ${result.selfCritique}`].slice(-5);
    }

    // splice: replace ONLY the active variant's clip; others keep their state
    p.writeBackVariant();
    if (result.variants?.length > 1 && p.variants?.length && p.activeVariant < result.variants.length) {
      const kept = { ...p.variants[p.activeVariant] };
      result = { ...result, variants: result.variants.map((v, i) =>
        (i === p.activeVariant ? { ...kept, ...v, overrides: kept.overrides, faces: kept.faces } : p.variants[i] ?? v)) };
    }
    if (council) {
      const { evaluate } = await import('../core/ScoreEngine.js');
      const { timelineOf } = await import('../core/Compositor.js');
      const before = p.edl ? evaluate(p.edl, timelineOf(p.edl), p.words, { platform: p.settings.platform }).total : null;
      p.lastDebate = { log: result.debateLog || [], scoreBefore: before, stance, secs: 0 };
    }
    p.glmResult = result;
    p.variants = result.variants ?? null;
    p.useGlm = true;
    if (ask) p.feedback = [...p.feedback, ask].slice(-5);
    return { truncated, confidence: result?.confidence ?? 0, passes };
  }
}
