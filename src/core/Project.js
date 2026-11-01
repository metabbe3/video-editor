// Project — the state model. Everything that mutated the old ui.js S singleton,
// now behind explicit methods. No DOM, no fetch (testable).

import {
  TUNING, freezeWords, detectSilence, calibrateThreshold, heuristicKeeps,
  planFyp, applyManualOverrides, transitionsFor,
} from '../../engine/edit-engine.js';
import { buildTimeline } from '../../engine/timeline.js';
import { DEFAULT_MANUAL } from '../../engine/reframe.js';
import { PLATFORMS } from '../../engine/glm.js';
import { scheduleSfx } from './AudioMix.js';

/** merge <3s fragment keeps into the chronologically-previous keep (hook exempt) */
export function mergeMicroCards(keeps, minSec = 3.0) {
  const out = [];
  for (const k of keeps) {
    const prev = out[out.length - 1];
    const small = (k.out - k.in) < minSec;
    const adjacent = prev && Math.abs(k.in - prev.out) < 0.02;
    const notHook = out.length > 0; // the first surviving keep is the hook
    if (small && adjacent && notHook) prev.out = Math.max(prev.out, k.out);
    else out.push({ ...k });
  }
  return out;
}

/** concatenate two adjacent keeps (context-menu merge) */
export function mergeKeeps(keep, i) {
  if (i < 0 || i >= keep.length - 1) return keep;
  const out = keep.map((k) => ({ ...k }));
  out[i].out = Math.max(out[i].out, out[i + 1].out);
  out.splice(i + 1, 1);
  return out;
}

export class Project {
  constructor() {
    this.reg = null;            // { items, arollId, brollPool }
    this.analysis = null;       // { pcm, energy, hopSec, duration }
    this.words = null;          // frozen word array
    this.baseKeeps = null;
    this.glmResult = null;      // last applyGlm result
    this.variants = null;       // GLM 1->many clips
    this.activeVariant = 0;
    this.edl = null;
    this.useGlm = false;
    this.overrides = { cuts: [], keeps: [] }; // local/baseKeeps mode
    this.overlays = [];      // manual text/sticker overlays (survive rebuilds)
    this.feedback = [];         // Ask-AI memory
    this.settings = {
      platform: 'shorts', orientation: '9:16', resolution: 1080, fps: 30,
      captionsMode: 'word-pop', captionStyle: 'hormozi', fit: 'cover',
      jCuts: true, autoSfx: false, snap: true,
      quality: 0.1, volumeDb: 0, autoframe: true, vision: false, sfx: false,
      progressBar: false,
    };
  }

  get variant() { return this.variants?.[this.activeVariant] ?? null; }

  /** manual-edit overrides live in the active variant when one exists */
  get activeOverrides() {
    const v = this.variant;
    if (!v) return this.overrides;
    if (!v.overrides) v.overrides = { cuts: [], keeps: [] };
    return v.overrides;
  }

  /** persist live EDL state into the variant before switching/refining */
  writeBackVariant() {
    const v = this.variant;
    if (!v || !this.edl) return;
    v.keeps = this.edl.keep.map((k) => ({ ...k }));
    v.hookTitle = this.edl.hookTitle ?? v.hookTitle;
    v.faces = this.edl.faces ?? [];
    v.overrides = JSON.parse(JSON.stringify(this.activeOverrides));
  }

  switchVariant(i) {
    if (!this.variants?.[i] || i === this.activeVariant) return false;
    this.writeBackVariant();
    this.activeVariant = i;
    return true;
  }

  frameStyle() {
    const [aw, ah] = this.settings.orientation.split(':').map(Number);
    const short = this.settings.resolution;
    const even = (n) => Math.round(n / 2) * 2;
    const w = aw <= ah ? even(short) : even((short * aw) / ah);
    const h = aw <= ah ? even((short * ah) / aw) : even(short);
    return { w, h, fps: this.settings.fps, captionSize: even(h * 0.0375) };
  }

  /** (re)build the EDL from the active source + FYP pass + manual overrides */
  buildEdl() {
    const v = this.variant;
    const keepsSrc = v ? v.keeps : this.baseKeeps;
    if (!keepsSrc) return null;
    const plat = PLATFORMS[this.settings.platform] ?? PLATFORMS.shorts;
    const plan = planFyp(keepsSrc, this.words, (ks) => buildTimeline(ks, { fps: this.settings.fps }), {
      emphases: this.useGlm && this.glmResult ? this.glmResult.emphases : [],
      brollHints: this.useGlm && this.glmResult ? this.glmResult.brollHints : [],
      tuning: { ...TUNING, ...plat.pacing, targetLen: plat.targetLen, joinPunches: plat.joinPunches, noTrim: plat.noTrim },
    });
    let keep = applyManualOverrides(plan.keeps, this.words, this.activeOverrides, this.analysis?.duration);
    keep = mergeMicroCards(keep);
    const tl = buildTimeline(keep, { fps: this.settings.fps });
    const st = this.frameStyle();
    this.edl = {
      style: {
        ...st, arollId: this.reg?.arollId,
        captionsMode: this.settings.captionsMode,
        captionStyle: this.settings.captionStyle,
        fit: this.settings.fit,
        captionWords: TUNING.captionMaxWords,
        reframe: this.edl?.style.reframe ?? { ...DEFAULT_MANUAL },
        progressBar: this.settings.progressBar,
      },
      hookTitle: v ? (v.hookTitle ?? '') : (this.glmResult?.hookTitle ?? ''),
      keep,
      punches: (plan.punches || []).filter((p) => p.at <= tl.duration),
      broll: this.assignBroll(plan.broll),
      words: this.words,
      faces: v ? (v.faces ?? []) : (this.edl?.faces ?? []),
      suggested: (this.useGlm && this.glmResult?.suggestedCuts) || [],
      chapters: (this.useGlm && this.glmResult?.chapters) || [],
      // no schema growth (red-team #1): steps ARE chapters; metrics derive from
      // emphases pointing at numeric words
      steps: (this.useGlm && this.glmResult?.chapters) || [],
      metrics: (this.useGlm ? this.numericEmphases() : []),
      keywords: (this.useGlm && this.glmResult?.emphases) || [],
      bgm: this.bgm ?? null,
      overlays: this.overlays ?? [],
      sfx: this.settings.autoSfx ? scheduleSfx({ keep, punches: (plan.punches || []).filter((p) => p.at <= tl.duration) }) : [],
      transitions: transitionsFor(keep, plat.transition),
    };
    return this.edl;
  }

  /** baseline heuristic cut after transcription (pacing from the platform preset) */
  computeBaseKeeps() {
    const plat = PLATFORMS[this.settings.platform] ?? PLATFORMS.shorts;
    this.baseKeeps = heuristicKeeps(this.words, this.analysis.duration, {
      silence: detectSilence(this.analysis.energy, this.analysis.hopSec, calibrateThreshold(this.analysis.energy)),
      energy: this.analysis.energy, hopSec: this.analysis.hopSec,
      tuning: { ...TUNING, ...plat.pacing },
    });
    return this.baseKeeps;
  }

  /** map GLM b-roll hints onto real pool files; unmatched hints are dropped
   *  (a hint without a resolvable src would crash the exporter) */
  assignBroll(hints) {
    const pool = this.reg?.brollPool ?? [];
    if (!hints?.length || !pool.length) return [];
    const used = new Set();
    return hints.map((h, i) => {
      const tokens = (h.topic || '').toLowerCase().split(/\W+/).filter((t) => t.length > 2);
      let pick = pool.find((f) => !used.has(f.id) && tokens.some((t) => f.name.toLowerCase().includes(t)));
      if (!pick) pick = pool.filter((f) => !used.has(f.id))[i % pool.length] ?? pool[i % pool.length];
      used.add(pick.id);
      return { ...h, src: pick.id };
    }).filter((h) => h.src);
  }

  /** emphases that point at a number/currency word -> metric callouts */
  numericEmphases() {
    return (this.glmResult?.emphases ?? [])
      .map((i) => this.words[i])
      .filter((w) => w && /[\d%$]|one|two|three|four|five|ten|hundred|thousand/i.test(w.w))
      .slice(0, 4)
      .map((w) => ({ at: this.words.indexOf(w), value: parseFloat(w.w.replace(/[^\d.]/g, '')) || 5, unit: /%/.test(w.w) ? '%' : '', up: !/cost|fail|down|loss/i.test(w.w), label: '' }));
  }

  resetEdit() {
    this.glmResult = null; this.edl = null; this.useGlm = false;
    this.variants = null; this.activeVariant = 0;
  }

  resetAll() {
    this.analysis = this.words = this.baseKeeps = null;
    this.resetEdit();
    this.overrides = { cuts: [], keeps: [] };
    this.overlays = [];
  }
}
