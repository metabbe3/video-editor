// App — wires Project + Compositor + Playback + EditorAgent + UI views.
// Thin: DOM events in, project methods out, views re-render on state change.

import { pickFolder, buildRegistry } from '../engine/ingest.js';
import { analyzeAudio } from '../engine/analyze.js';
import { transcribe } from '../engine/transcribe.js';
import { freezeWords, removedView, transitionsFor } from '../engine/edit-engine.js';
import { timelineOf } from './core/Compositor.js';
import { Project } from './core/Project.js';
import { Compositor } from './core/Compositor.js';
import { createPreview } from './core/Playback.js';
import { createTimelineView } from './ui/TimelineView.js';
import { EditorAgent } from './agents/EditorAgent.js';
import { exportVideo } from './exporters/Mp4Exporter.js';
import { sampleFaceTrack } from '../engine/face-track.js';
import { evaluate } from './core/ScoreEngine.js';
import { fitToTarget } from './core/DurationBudget.js';
import { groupTakes, cutsForSelection } from './core/TakeStacks.js';
import { renderStoryScript } from './ui/StoryScript.js';
import { renderMediaBin, insertBrollAt, autoFillBroll, resolveBroll } from './ui/MediaBin.js';
import { mergeKeeps } from './core/Project.js';
import { parseCube } from './effects/lut.js';
import { checkEdl } from './core/QaGate.js';
import { STANCES } from './agents/council.js';
import { calibrateLevels } from './effects/polish.js';
import { fixPhonetics } from '../engine/edit-engine.js';
import { LANG_NAMES, CAPTION_LABELS, langName } from './ui/labels.js';
import { initShell } from './ui/Shell.js';
import { renderInspector } from './ui/Inspector.js';
import { overlayHit } from './elements/OverlayElement.js';
import { drawGuides, GUIDE_MODES } from './elements/guides.js';
import { toSrt } from '../engine/srt.js';
import { renderSfx, SFX_PRESETS } from './core/AudioMix.js';
import { captionsOf } from './core/Compositor.js';
import { saveProject, loadProject, makeProjectKey, serializeProjectState, applyProjectSnapshot } from '../engine/project-store.js';
import { PLATFORM_EXPORT_PRESETS, normalizeCropRect } from '../engine/clip-ops.js';
import {
  generateProposals, proposalSummary, proposalsToKeeps,
  toggleProposalStatus, acceptAllProposals, rejectAllProposals,
} from '../engine/proposals.js';
import { runDebateCouncil } from '../engine/council-vote.js';
import { parseChatCommand, applyChatOp } from '../engine/chat-ops.js';
import { calibrateThreshold, FILLER_RE } from '../engine/edit-engine.js';
import { ChatDirector } from './agents/ChatDirector.js';
import { ChatPanel } from './ui/ChatPanel.js';
import { computeDuckGainCurve } from '../engine/duck.js';
import { BUILTIN_EMOJIS, suggestStickers } from '../engine/stickers.js';
import { buildTranslationMessages, parseTranslationResponse } from '../engine/translate.js';
import { glmChat } from '../engine/glm.js';
import { removeKeyframe } from '../engine/keyframes.js';

const $ = (id) => document.getElementById(id);
const LS = { get: (k, d) => localStorage.getItem(k) ?? d, set: (k, v) => localStorage.setItem(k, v) };

export class App {
  constructor() {
    this.project = new Project();
    this.compositor = new Compositor();
    this.preview = createPreview($('player'), (id) => this.project.reg?.items.find((r) => r.id === id)?.file, this.compositor);
    this.agent = new EditorAgent(this.project, {
      key: () => $('glmKey').value.trim(),
      endpoint: () => $('glmEndpoint').value,
      model: () => $('glmModel').value,
      vision: () => $('visionOn').checked,
    });
    this.director = new ChatDirector(this, this.project);
    this.busy = false;
    this.undoStack = [];
    this.redoStack = [];
    this.trimAnchor = null;
    this.selectedClipIndex = null;
    this.cropModeClipIndex = null;
    this.isRecordingVo = false;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.pendingRestoreSnapshot = null;
    this.faceTimer = 0;
    this._saveTimer = 0;
    this.contextTargetWords = [];
    this.pendingChatOp = null;
    this.pendingChatQuery = '';
    this.tlv = createTimelineView($('timeline'), this.timelineHost());
    this.shell = initShell();
    this.chatPanel = new ChatPanel(this, this.director, this.project);
    this.director.panel = this.chatPanel; // late-bind: director constructed before panel exists
    this.wire();
    this.restoreSettings();
  }

  timelineHost() {
    const app = this;
    return {
      getEdl: () => this.project.edl,
      getProposals: () => (this.project.proposalsApplied ? [] : (this.project.proposals || [])),
      getEnergy: () => this.project.analysis,
      seekTo: (t) => { this.preview.seekTo(t); this.drawAll(t); },
      trimSeg: (i, edge, t) => this.trimSegment(i, edge, t),
      commitTrim: () => { this.trimAnchor = null; this.refreshDerived(); },
      redraw: () => this.drawAll(),
      getSnap: () => this.project.settings.snap !== false,
      snapPoints: () => {
        const p = this.project;
        if (!p.edl) return [];
        const tl = timelineOf(p.edl);
        const pts = [this.preview.editedTime()];
        for (let i = 0; i < tl.segments.length; i++) { pts.push(tl.starts[i]); pts.push(tl.starts[i] + tl.segments[i].dur); }
        for (const w of p.words) { const e = tl.sourceToEdited(w.start); if (e != null) pts.push(e); }
        return pts;
      },
      reorderSegment: (from, to) => this.reorderSegment(from, to),
      selectClip: (i) => this.selectClip(i),
      getSelected: () => this.selectedClipIndex,
      getRazor: () => this.razor,
      razorSplit: (t) => this.splitAt(t),
      onDrop: (payload, t, lane) => this.onTimelineDrop(payload, t, lane),
      getDuckCurve: () => this.preview?.duckCurve || null,
      commitKeyframe: () => { this.pushUndo(); this.scheduleSave(); this.preview.redraw(); },
      deleteKeyframe: (seg, propName, kfIndex) => {
        const k = this.project.edl?.keep?.[seg];
        if (k?.keyframes?.[propName]) {
          this.pushUndo();
          k.keyframes[propName] = removeKeyframe(k.keyframes[propName], kfIndex);
          this.scheduleSave();
          this.drawAll();
          renderInspector(this);
          this.toast('Keyframe deleted');
        }
      },
      selectOverlay: (idx) => {
        this.selectedOverlayIndex = idx;
        this.selectedClipIndex = null;
        renderInspector(this);
      },
      commitOverlayChange: () => {
        this.pushUndo();
        this.scheduleSave();
        this.renderOverlayList();
        this.preview.redraw();
      },
      onTransitionClick: (seg, at, trans) => {
        this.openTransitionMenu(seg, at, trans);
      },
    };
  }

  // ---------- settings restore ----------
  restoreSettings() {
    const p = this.project.settings;
    p.platform = LS.get('platform', 'shorts');
    p.orientation = LS.get('orient', '9:16');
    p.resolution = Number(LS.get('res', '1080'));
    p.fps = Number(LS.get('fps', '30'));
    p.captionsMode = LS.get('cap', 'word-pop');
    p.captionStyle = LS.get('capStyle', 'hormozi');
    p.fit = LS.get('fit', 'cover');
    try {
      const savedAdj = JSON.parse(LS.get('adjust', 'null'));
      if (savedAdj) p.adjust = Object.assign(p.adjust, savedAdj);
    } catch {}
    $('platform').value = p.platform;
    $('orient').value = p.orientation;
    $('resSel').value = String(p.resolution);
    $('fpsSel').value = String(p.fps);
    $('capMode').value = p.captionsMode === 'off' ? 'off' : 'word-pop';
    $('capStyle').value = p.captionStyle;
    $('fitMode').value = p.fit;
    if ($('adjBright')) $('adjBright').value = String(p.adjust?.brightness || 0);
    if ($('adjContrast')) $('adjContrast').value = String(p.adjust?.contrast || 0);
    if ($('adjSat')) $('adjSat').value = String(p.adjust?.saturation || 0);
    if ($('adjTemp')) $('adjTemp').value = String(p.adjust?.temperature || 0);
    if ($('adjBrightV')) $('adjBrightV').textContent = String(p.adjust?.brightness || 0);
    if ($('adjContrastV')) $('adjContrastV').textContent = String(p.adjust?.contrast || 0);
    if ($('adjSatV')) $('adjSatV').textContent = String(p.adjust?.saturation || 0);
    if ($('adjTempV')) $('adjTempV').textContent = String(p.adjust?.temperature || 0);
    $('volDb').value = LS.get('vol', '0');
    // GLM credentials + prompt (the round-7 rewrite dropped these — the AI
    // silently stopped working because the key booted empty and the endpoint
    // reset to standard, which 429s the coding-plan token)
    $('glmKey').value = LS.get('glm.key', '');
    $('glmEndpoint').value = LS.get('glm.endpoint', $('glmEndpoint').value);
    $('glmModel').value = LS.get('glm.model', $('glmModel').value);
    $('glmPrompt').value = LS.get('glm.prompt', '');
    $('sttModel').value = LS.get('stt.model', $('sttModel').value);
    $('sttLang').value = LS.get('stt.lang', 'auto');
    // persist on change
    for (const [id, k] of [['glmKey', 'glm.key'], ['glmEndpoint', 'glm.endpoint'], ['glmModel', 'glm.model'], ['glmPrompt', 'glm.prompt'], ['sttModel', 'stt.model'], ['sttLang', 'stt.lang']]) {
      $(id).addEventListener('change', () => LS.set(k, $(id).value));
    }
    $('zoneChip')?.classList.toggle('on', false); // superseded by #guideChip
    this.preview.setVolume?.(Number(LS.get('vol', '0')));
  }

  status(s) { $('status').textContent = s; }
  toast(msg, ms = 2600) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove('show'), ms);
  }
  setBusy(b) { this.busy = b; this.syncButtons(); }

  drawAll(t) {
    this.tlv.draw(t ?? (this.project.edl ? this.preview.editedTime() : -1));
    if (this.project.edl) $('timeLabel').textContent = `${this.preview.editedTime().toFixed(1)} / ${timelineOf(this.project.edl).duration.toFixed(1)}s`;
  }

  // ---------- wiring ----------
  wire() {
    const on = (id, ev, fn) => $(id)?.addEventListener(ev, fn);

    on('restoreBtn', 'click', () => this.restoreLastEdit());
    on('dismissRestoreBtn', 'click', () => this.hideRestoreBanner());
    on('voBtn', 'click', () => this.toggleVoiceover());

    // Proposal bar actions
    on('applyAllPropsBtn', 'click', () => this.applyAllProposals());
    on('debatePropsBtn', 'click', () => this.debateProposals());
    on('dismissAllPropsBtn', 'click', () => this.dismissAllProposals());

    // Context menu actions
    document.querySelectorAll('#transcriptContextMenu .ctx-item').forEach((b) => {
      b.onclick = () => this.handleContextAction(b.dataset.action);
    });

    // Inline chat box actions
    on('inlineChatForm', 'submit', (e) => this.submitInlineChat(e));
    on('applyChatOpBtn', 'click', () => this.applyChatOperation());
    on('revertChatOpBtn', 'click', () => this.revertChatOperation());
    on('closeChatBtn', 'click', () => this.closeInlineChat());

    // Click outside to dismiss context menu / inline chat
    document.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('#transcriptContextMenu')) this.closeContextMenu();
      if (!e.target.closest('#inlineChatBox') && !e.target.closest('#transcriptContextMenu')) {
        this.closeInlineChat();
      }
    });

    // Color adjust sliders (Global polish / Looks)
    const updateAdj = (key, val, labelId) => {
      this.project.settings.adjust[key] = Number(val);
      if ($(labelId)) $(labelId).textContent = String(val);
      LS.set('adjust', JSON.stringify(this.project.settings.adjust));
      if (this.project.edl) {
        this.project.edl.style.adjust = { ...this.project.settings.adjust };
        this.preview.redraw();
      }
      this.scheduleSave();
    };
    on('adjBright', 'input', () => updateAdj('brightness', $('adjBright').value, 'adjBrightV'));
    on('adjContrast', 'input', () => updateAdj('contrast', $('adjContrast').value, 'adjContrastV'));
    on('adjSat', 'input', () => updateAdj('saturation', $('adjSat').value, 'adjSatV'));
    on('adjTemp', 'input', () => updateAdj('temperature', $('adjTemp').value, 'adjTempV'));

    // Platform export presets
    on('exportPreset', 'change', () => {
      const val = $('exportPreset').value;
      if (val === 'custom') return;
      const preset = PLATFORM_EXPORT_PRESETS[val];
      if (!preset) return;
      this.pushUndo();
      const p = this.project.settings;
      p.orientation = preset.orientation;
      p.resolution = preset.resolution;
      p.fps = preset.fps;
      p.quality = preset.quality;
      $('orient').value = preset.orientation;
      $('resSel').value = String(preset.resolution);
      $('fpsSel').value = String(preset.fps);
      $('quality').value = String(preset.quality);
      LS.set('orient', preset.orientation);
      LS.set('res', String(preset.resolution));
      LS.set('fps', String(preset.fps));
      LS.set('quality', String(preset.quality));
      document.querySelectorAll('#aspectSeg button').forEach((x) => {
        x.style.background = x.dataset.orient === preset.orientation ? 'var(--bg-raise)' : '';
      });
      if (this.project.edl) {
        this.rebuild();
        this.syncFrame();
      }
      this.toast(`Preset applied: ${preset.label}`);
    });

    on('pickBtn', 'click', async () => {
      if (this.busy) return;
      const entries = await pickFolder();
      if (!entries?.length) return;
      this.project.reg = buildRegistry(entries);
      this.renderFiles();
      $('emptyMsg').style.display = this.project.reg.arollId ? 'none' : '';
      this.syncButtons();
    });
    on('analyzeBtn', 'click', () => this.analyze());
    on('refineBtn', 'click', () => this.refineFlow(false));
    on('askBtn', 'click', () => this.refineFlow(true));
    on('askInput', 'keydown', (e) => { if (e.key === 'Enter') this.refineFlow(true); });
    on('exportBtn', 'click', () => this.export());
    on('playBtn', 'click', () => this.togglePlay());
    on('settingsBtn', 'click', () => this.shell.show('settings'));
    on('copyChaptersBtn', 'click', () => this.copyChapters());
    on('modeChip', 'click', () => {
      const p = this.project;
      if (!p.glmResult) return;
      p.useGlm = !p.useGlm;
      this.rebuild();
    });
    // ✨ Polish — lives in the Effects panel now
    this.compositor.polish = this.project.settings.polish ??= { lut: 'none', lutMix: 0.65, sharpen: 0, skinSmooth: 0, autoLevels: true };
    on('polishChip', 'click', () => this.shell.show('effects'));
    for (const b of document.querySelectorAll('[data-lut]')) {
      b.onclick = () => {
        this.compositor.polish.lut = b.dataset.lut;
        LS.set('polish', JSON.stringify(this.compositor.polish));
        document.querySelectorAll('[data-lut]').forEach((x) => x.style.background = x.dataset.lut === this.compositor.polish.lut ? 'var(--bg-raise)' : '');
        this.preview.redraw();
      };
    }
    for (const [id, key] of [['polishMix', 'lutMix'], ['polishSharp', 'sharpen'], ['polishSkin', 'skinSmooth']]) {
      on(id, 'input', () => {
        this.compositor.polish[key] = Number($(id).value) / 100;
        LS.set('polish', JSON.stringify(this.compositor.polish));
        this.preview.redraw();
      });
    }
    on('polishLevels', 'change', () => {
      this.compositor.polish.autoLevels = $('polishLevels').checked;
      LS.set('polish', JSON.stringify(this.compositor.polish));
      this.preview.redraw();
    });

    // 🎵 music — lives in the Sounds panel now
    on('musicChip', 'click', () => this.shell.show('sound'));
    const refreshMusicSel = () => {
      const sel = $('bgmSel');
      if (!sel) return;
      sel.textContent = '';
      const none = document.createElement('option');
      none.value = ''; none.textContent = 'None';
      sel.appendChild(none);
      for (const r of (this.project.reg?.items ?? []).filter((x) => x.kind === 'audio' || x.kind === 'video')) {
        const o = document.createElement('option');
        o.value = r.id; o.textContent = r.name;
        sel.appendChild(o);
      }
      if (this.project.bgm?.src) sel.value = this.project.bgm.src;
    };
    $('musicChip')?.addEventListener('click', refreshMusicSel);

    const addMusicBtn = $('addMusicBtn');
    const musicFileInput = $('musicFileInput');
    if (addMusicBtn && musicFileInput) {
      addMusicBtn.onclick = () => musicFileInput.click();
      musicFileInput.onchange = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const id = `music_${Date.now()}_${file.name}`;
        this.project.reg = this.project.reg || { items: [] };
        this.project.reg.items.push({ id, name: file.name, kind: 'audio', file });

        this.pushUndo();
        this.project.bgm = {
          src: id,
          name: file.name,
          gainDb: Number($('bgmVol').value) || -12,
          autoDuck: $('bgmDuck').checked,
        };
        this.project.edl = { ...(this.project.edl || {}), bgm: this.project.bgm };

        // Also add to audioOverlays for timeline visibility and audio mixing
        this.project.edl.audioOverlays = this.project.edl.audioOverlays || [];
        this.project.edl.audioOverlays.push({
          id, src: id, at: 0, dur: 3600, volume: 1, name: file.name, isMusic: true,
        });

        refreshMusicSel();
        $('bgmSel').value = id;
        this.refreshDerived();
        this.scheduleSave();
        this.toast(`Background music added: ${file.name}`);
      };
    }

    on('bgmSel', 'change', () => {
      const p = this.project;
      p.bgm = $('bgmSel').value ? { src: $('bgmSel').value, gainDb: Number($('bgmVol').value), autoDuck: $('bgmDuck').checked } : null;
      if (p.edl) p.edl.bgm = p.bgm;
      LS.set('bgm', JSON.stringify(p.bgm ?? ''));
      this.refreshDerived();
    });
    on('bgmVol', 'input', () => {
      const val = Number($('bgmVol').value);
      if ($('bgmVolV')) $('bgmVolV').textContent = `${val}dB`;
      if (this.project.bgm) {
        this.project.bgm.gainDb = val;
        if (this.project.edl) this.project.edl.bgm = this.project.bgm;
        LS.set('bgm', JSON.stringify(this.project.bgm));
      }
    });
    on('bgmDuck', 'change', () => {
      if (this.project.bgm) {
        this.project.bgm.autoDuck = $('bgmDuck').checked;
        if (this.project.edl) this.project.edl.bgm = this.project.bgm;
        LS.set('bgm', JSON.stringify(this.project.bgm));
      }
    });
    on('autoSfx', 'change', () => { this.project.settings.autoSfx = $('autoSfx').checked; LS.set('autosfx', $('autoSfx').checked ? '1' : '0'); if (this.project.edl) this.rebuild(); });

    // 🌐 Auto-translate captions
    const transBtn = $('translateCaptionsBtn');
    const resetTransBtn = $('resetTranslateBtn');
    if (transBtn) {
      transBtn.onclick = async () => {
        const p = this.project;
        if (!p.words?.length) return this.toast('No transcript available to translate');
        const glmKey = LS.get('glm_key') || p.settings.glmKey;
        if (!glmKey) return this.toast('Set GLM API key in Settings first');

        const targetLang = $('targetLangSel').value || 'en';
        transBtn.disabled = true;
        transBtn.textContent = 'Translating…';
        try {
          p.translations = p.translations || {};
          let translatedWords = p.translations[targetLang];
          if (!translatedWords) {
            const messages = buildTranslationMessages(p.words, targetLang);
            const res = await glmChat({ apiKey: glmKey }, messages, { jsonMode: true });
            translatedWords = parseTranslationResponse(res.content, p.words);
            p.translations[targetLang] = translatedWords;
          }

          this.pushUndo();
          p.words = translatedWords;
          if (p.edl) p.edl.words = translatedWords;
          this.rebuild();
          this.renderTranscript();
          if (resetTransBtn) resetTransBtn.hidden = false;
          this.toast(`Captions translated to ${targetLang}!`);
        } catch (err) {
          console.error(err);
          this.toast(`Translation failed: ${err.message}`);
        } finally {
          transBtn.disabled = false;
          transBtn.textContent = 'Translate';
        }
      };
    }
    if (resetTransBtn) {
      resetTransBtn.onclick = () => {
        const p = this.project;
        if (!p.words?.length) return;
        this.pushUndo();
        p.words = p.words.map((w) => ({ ...w, w: w.originalW || w.w, translated: false }));
        if (p.edl) p.edl.words = p.words;
        this.rebuild();
        this.renderTranscript();
        resetTransBtn.hidden = true;
        this.toast('Restored original captions');
      };
    }

    // ⧓ Transition popup handlers
    on('closeTransBtn', 'click', () => {
      const m = $('transitionMenu');
      if (m) m.style.display = 'none';
    });
    on('transTypeSel', 'change', () => this.applySelectedTransition());
    on('transDurRng', 'input', () => {
      if ($('transDurVal')) $('transDurVal').textContent = `${$('transDurRng').value}ms`;
      this.applySelectedTransition();
    });

    // ✍️ text + 😀 sticker panels
    for (const b of document.querySelectorAll('[data-addtext]')) {
      b.onclick = () => this.addOverlay({ type: 'text', preset: b.dataset.addtext, text: b.dataset.addtext === 'subtitle' ? 'new subtitle' : 'NEW TEXT' });
    }
    const emojiGrid = $('emojiGrid');
    if (emojiGrid) {
      emojiGrid.textContent = '';
      for (const ch of BUILTIN_EMOJIS) {
        const b = document.createElement('button');
        b.className = 'big';
        b.textContent = ch;
        b.onclick = () => this.addOverlay({ type: 'sticker', char: ch });
        emojiGrid.appendChild(b);
      }
    }
    for (const b of document.querySelectorAll('[data-addshape]')) {
      b.onclick = () => this.addOverlay({ type: 'sticker', shape: b.dataset.addshape });
    }

    // 🔊 procedural SFX library (Sounds panel) — audition + pin at playhead
    const sfxLib = $('sfxLib');
    if (sfxLib) {
      $('sfxLibHead').hidden = false;
      sfxLib.hidden = false;
      for (const kind of SFX_PRESETS) {
        const cell = document.createElement('div');
        cell.style.cssText = 'display:flex;gap:2px;min-width:0';
        const play = document.createElement('button');
        play.textContent = `🔊 ${kind}`;
        play.onclick = () => this.auditionSfx(kind);
        const pin = document.createElement('button');
        pin.textContent = '📌';
        pin.title = 'pin at playhead';
        pin.onclick = () => {
          const p = this.project;
          if (!p.edl) return this.toast('Analyze first');
          p.edl = { ...p.edl, sfx: [...(p.edl.sfx || []), { at: Math.max(0, this.preview.editedTime() - 0.08), kind, gainDb: -14 }] };
          this.refreshDerived();
          this.toast(`${kind} pinned at playhead`);
        };
        cell.append(play, pin);
        sfxLib.appendChild(cell);
      }
    }

    // 💬 SRT export (captions of the edited timeline)
    on('srtExport', 'click', () => {
      const p = this.project;
      if (!p.edl) return this.toast('Analyze a video first');
      const srt = toSrt(captionsOf(p.edl));
      if (!srt) return this.toast('No captions to export');
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([srt], { type: 'text/plain' })),
        download: 'captions.srt',
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
      this.toast('captions.srt downloaded');
    });

    // 🧲 snap toggle
    let snapOn = LS.get('snap', '1') === '1';
    const syncSnap = () => { $('snapChip').classList.toggle('on', snapOn); this.project.settings.snap = snapOn; };
    on('snapChip', 'click', () => { snapOn = !snapOn; LS.set('snap', snapOn ? '1' : '0'); syncSnap(); });
    syncSnap();

    // council stance
    $('stanceSel').value = LS.get('stance', 'balanced');
    $('councilOn').checked = LS.get('council', '1') === '1';
    on('stanceSel', 'change', () => LS.set('stance', $('stanceSel').value));
    on('councilOn', 'change', () => { LS.set('council', $('councilOn').checked ? '1' : '0'); $('refineBtn').textContent = $('councilOn').checked ? '🧠 Council debate' : 'Refine with GLM'; });
    if ($('councilOn').checked) $('refineBtn').textContent = '🧠 Council debate';
    // debate drawer
    on('debateChip', 'click', () => this.renderDebate());

    // razor toggle
    this.razor = false;
    on('razorChip', 'click', () => {
      this.razor = !this.razor;
      $('razorChip').classList.toggle('on', this.razor);
      $('timeline').style.cursor = this.razor ? 'crosshair' : '';
    });
    // track labels toggle
    on('toggleLabelsBtn', 'click', () => {
      const on = this.tlv?.toggleLabels?.();
      $('toggleLabelsBtn')?.classList.toggle('on', !!on);
    });
    // .cube LUT load
    on('cubeFile', 'change', async () => {
      const f = $('cubeFile').files[0];
      if (!f) return;
      const lut = parseCube(await f.text());
      if (!lut) return this.toast('Invalid .cube file');
      this.compositor.polish ??= { lut: 'none', lutMix: 0.65, sharpen: 0, skinSmooth: 0, autoLevels: true };
      this.compositor.polish.cubeLut = lut;
      this.toast(`LUT ${f.name} (${lut.size}³) loaded`);
      this.preview.redraw();
    });

    // guides (preview-only): off → safe → grid → tiktok
    this.guideMode = LS.get('guides', 'off');
    this.preview.overlay = (ctx, w, h) => {
      drawGuides(ctx, w, h, this.guideMode);
      if (this.cropModeClipIndex != null) this.drawCropOverlay(ctx, w, h);
    };
    const syncGuides = () => {
      $('guideChip').classList.toggle('on', this.guideMode !== 'off');
      $('guideChip').title = `preview guides: ${GUIDE_MODES.join(' → ')}`;
    };
    on('guideChip', 'click', () => {
      this.guideMode = GUIDE_MODES[(GUIDE_MODES.indexOf(this.guideMode) + 1) % GUIDE_MODES.length];
      LS.set('guides', this.guideMode);
      syncGuides();
      this.preview.redraw();
    });
    syncGuides();
    on('faceChip', 'click', () => {
      const p = this.project;
      p.settings.autoframe = !p.settings.autoframe;
      $('faceChip').classList.toggle('on', p.settings.autoframe);
      if (p.settings.autoframe) this.scheduleFacePass();
      else if (p.edl) { p.edl.faces = []; this.preview.redraw(); this.drawAll(); }
    });
    on('zoomRange', 'input', () => this.setReframe({ zoom: +$('zoomRange').value }));
    on('progOn', 'change', () => {
      this.project.settings.progressBar = $('progOn').checked;
      if (this.project.edl) { this.project.edl.style.progressBar = $('progOn').checked; this.preview.redraw(); this.drawAll(); }
    });
    on('sfxOn', 'change', () => LS.set('sfx', $('sfxOn').checked ? '1' : '0'));
    const applyDur = (target) => {
      const p = this.project;
      if (!p.edl) return;
      this.pushUndo();
      const fitted = fitToTarget(p.edl.keep, target);
      p.edl = { ...p.edl, keep: fitted, transitions: transitionsFor(fitted) };
      this.refreshDerived();
      this.toast(`Fitted to ~${target}s`);
    };
    on('durSlider', 'input', () => { $('durVal').textContent = `${$('durSlider').value}s`; });
    on('durSlider', 'change', () => applyDur(Number($('durSlider').value)));
    // story-script tabs
    this.scriptTab = 'script';
    on('tabScript', 'click', () => this.switchScriptTab('script'));
    on('tabRaw', 'click', () => this.switchScriptTab('raw'));
    // word search (both views)
    on('wordSearch', 'input', () => {
      const q = $('wordSearch').value.trim().toLowerCase();
      const el = this.scriptTab === 'script' ? $('scriptView') : $('transcript');
      for (const sp of el.querySelectorAll(this.scriptTab === 'script' ? '[data-idx]' : '.w')) {
        const hit = !q || sp.textContent.toLowerCase().includes(q);
        sp.style.opacity = hit ? '' : '0.25';
      }
    });
    // aspect segmented control
    for (const b of document.querySelectorAll('#aspectSeg button')) {
      b.onclick = () => {
        document.querySelectorAll('#aspectSeg button').forEach((x) => x.style.background = '');
        b.style.background = 'var(--bg-raise)';
        this.project.settings.orientation = b.dataset.orient;
        LS.set('orient', b.dataset.orient);
        $('orient').value = b.dataset.orient;
        if (this.project.edl) this.rebuild();
      };
    }
    // export diagnostics popover
    on('errRetry', 'click', () => { $('errPop').style.display = 'none'; this.export(); });
    on('errEdl', 'click', () => {
      const blob = new Blob([JSON.stringify(this.project.edl, null, 1)], { type: 'application/json' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'edl.json' });
      a.click();
    });
    on('dur30', 'click', () => applyDur(28));
    on('dur60', 'click', () => applyDur(55));
    on('dur90', 'click', () => applyDur(85));

    for (const [id, key] of [['platform', 'platform'], ['orient', 'orientation'], ['resSel', 'resolution'], ['fpsSel', 'fps'], ['capMode', 'captionsMode'], ['capStyle', 'captionStyle'], ['fitMode', 'fit']]) {
      on(id, 'change', () => {
        const map = { resolution: Number, fps: Number };
        this.project.settings[key] = map[key] ? map[key]($(id).value) : $(id).value;
        LS.set(key, $(id).value);
        if (this.project.edl) { this.rebuild(); this.syncFrame(); }
      });
    }
    on('volDb', 'input', () => {
      LS.set('vol', $('volDb').value);
      this.preview.setVolume?.(+$('volDb').value);
    });
    on('tlZoomIn', 'click', () => this.tlv.zoom(1.3));
    on('tlZoomOut', 'click', () => this.tlv.zoom(1 / 1.3));
    on('tlFit', 'click', () => { this.tlv.fit(); this.drawAll(); });

    // player pan / zoom / reset — overlays drag first, reframe pan second
    const wrap = $('playerWrap');
    let pan = null;
    wrap.addEventListener('pointerdown', (e) => {
      if (!this.project.edl || e.target.closest('button')) return;
      wrap.setPointerCapture(e.pointerId);
      const r = wrap.getBoundingClientRect();
      if (this.cropModeClipIndex != null) {
        this.pushUndo();
        const startX = (e.clientX - r.left) / r.width;
        const startY = (e.clientY - r.top) / r.height;
        pan = { crop: true, startX, startY };
        return;
      }
      const nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height;
      const hi = overlayHit(this.project.overlays, nx, ny, this.preview.editedTime());
      if (hi != null) { this.pushUndo(); pan = { ov: hi }; return; }
      pan = { x: e.clientX, y: e.clientY };
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!pan || !this.project.edl) return;
      const r = wrap.getBoundingClientRect();
      if (pan.crop) {
        const curX = (e.clientX - r.left) / r.width;
        const curY = (e.clientY - r.top) / r.height;
        const x = Math.min(pan.startX, curX);
        const y = Math.min(pan.startY, curY);
        const w = Math.abs(curX - pan.startX);
        const h = Math.abs(curY - pan.startY);
        if (w > 0.02 && h > 0.02) {
          const rect = normalizeCropRect({ x, y, w, h });
          const clip = this.project.edl?.keep?.[this.cropModeClipIndex];
          if (clip) {
            clip.cropRect = rect;
            this.preview.redraw();
          }
        }
        return;
      }
      if (pan.ov != null) {
        this.updateOverlay(pan.ov, { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }, { quiet: true });
        return;
      }
      if (!this.project.edl?.style.reframe) return;
      const m = this.project.edl.style.reframe;
      this.setReframe({ px: m.px - (e.clientX - pan.x) / r.width / m.zoom, py: m.py - (e.clientY - pan.y) / r.height / m.zoom });
      pan = { x: e.clientX, y: e.clientY };
    });
    wrap.addEventListener('pointerup', () => {
      if (pan?.crop) {
        this.refreshDerived();
        this.renderInspector();
        this.scheduleSave();
      }
      pan = null;
    });
    wrap.addEventListener('wheel', (e) => {
      if (!this.project.edl) return;
      e.preventDefault();
      this.setReframe({ zoom: Math.min(4, Math.max(0.6, this.project.edl.style.reframe.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))) });
    }, { passive: false });
    wrap.addEventListener('dblclick', () => this.setReframe({ zoom: 1, px: 0, py: 0 }));

    this.preview.onTime = (t) => { this.drawAll(t); this.highlightWord(); };
    this.preview.onEnded = () => { $('playBtn').textContent = 'Play'; };

    document.addEventListener('keydown', (e) => {
      // ⌘K / Ctrl+K toggles the ChatDirector sidebar
      if (e.code === 'KeyK' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.chatPanel?.toggle();
        return;
      }
      // Escape closes sidebar and modals
      if (e.code === 'Escape') {
        this.chatPanel?.close();
        this.closeContextMenu();
        this.closeInlineChat();
        if (this.razor) { this.razor = false; $('razorChip').classList.remove('on'); $('timeline').style.cursor = ''; }
        this.selectClip(null);
      }
      if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      const p = this.project;
      if (e.code === 'Space') { e.preventDefault(); this.togglePlay(); }
      if (e.code === 'KeyZ' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
      if (!p.edl) return;
      const tl = timelineOf(p.edl), t = this.preview.editedTime();
      if (e.code === 'ArrowLeft') { this.preview.seekTo(t - 1 / 30); this.drawAll(); }
      if (e.code === 'ArrowRight') { this.preview.seekTo(t + 1 / 30); this.drawAll(); }
      if (e.code === 'KeyJ') { this.preview.seekTo(t - 3); this.drawAll(); }
      if (e.code === 'KeyL') { this.preview.seekTo(Math.min(t + 3, tl.duration)); this.drawAll(); }
      if (e.code === 'KeyK' && !e.metaKey && !e.ctrlKey && this.preview.playing) this.togglePlay();
      if (e.code === 'KeyS' && !e.metaKey && !e.ctrlKey) this.splitAt(t);
      if (e.code === 'KeyD' && !e.metaKey && !e.ctrlKey) this.duplicateClip(this.selectedClipIndex ?? tl.segmentAt(t));
      if ((e.code === 'Delete' || e.code === 'Backspace') && /BODY/.test(e.target.tagName)) this.deleteClipAt(this.selectedClipIndex ?? tl.segmentAt(t));
      if (e.code === 'KeyI') this.trimAtPlayhead('in');
      if (e.code === 'KeyO') this.trimAtPlayhead('out');
      if (e.code === 'KeyQ') this.rippleToPlayhead('left');
      if (e.code === 'KeyW') this.rippleToPlayhead('right');
    });
  }

  syncFrame() {
    if (!this.project.edl) return;
    const { w, h } = this.project.edl.style;
    $('playerWrap').style.aspectRatio = `${w} / ${h}`;
  }

  setReframe(patch) {
    const edl = this.project.edl;
    if (!edl) return;
    Object.assign(edl.style.reframe, patch);
    $('zoomRange').value = edl.style.reframe.zoom;
    $('zoomVal').textContent = `${edl.style.reframe.zoom.toFixed(1)}×`;
    this.preview.redraw();
    this.drawAll();
  }

  // ---------- files ----------
  renderFiles() {
    const p = this.project;
    const list = $('fileList');
    list.textContent = '';
    for (const r of p.reg.items.slice(0, 80)) {
      const div = document.createElement('div');
      div.className = 'f' + (r.id === p.reg.arollId ? ' aroll' : '');
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = r.kind === 'video' ? 'vid' : r.kind;
      const n = document.createElement('span');
      n.textContent = r.path;
      div.append(k, n);
      if (r.kind === 'video') {
        div.style.cursor = 'pointer';
        div.onclick = async () => {
          if (this.busy || r.id === p.reg.arollId) return;
          p.reg.arollId = r.id;
          p.resetAll();
          this.renderFiles();
          this.renderTranscript();
          this.renderVariants();
          this.renderChapters();
          this.drawAll(-1);
          this.syncButtons();
          this.toast(`Editing ${r.name} — analyzing…`);
          this.analyze(); // one-click: switch file = transcribe + AI pipeline
        };
      }
      list.appendChild(div);
    }
    const sel = $('arollSel');
    sel.textContent = '';
    for (const r of p.reg.items.filter((x) => x.kind === 'video')) {
      const o = document.createElement('option');
      o.value = r.id; o.textContent = r.name;
      sel.appendChild(o);
    }
    sel.value = p.reg.arollId ?? '';
    sel.onchange = () => { p.reg.arollId = sel.value; p.resetAll(); this.renderFiles(); this.renderTranscript(); this.renderChapters(); this.drawAll(-1); this.syncButtons(); };
    const curAroll = p.reg.items?.find((x) => x.id === p.reg.arollId);
    if (curAroll?.file) {
      this.checkSavedEdit(curAroll.file, curAroll.name);
    }
  }

  // ---------- analyze ----------
  /** transcribe-first guard: every AI feature requires the transcript.
   *  If the active file has no words yet, run the full analysis pipeline
   *  (decode + transcribe) before the AI call — no silent skips. */
  async ensureTranscript() {
    const p = this.project;
    if (p.words?.length) return true;
    if (!p.reg?.arollId) { this.toast('Pick a video first'); return false; }
    this.toast('Transcribing first…', 4000);
    await this.analyze({ skipAutoRefine: true });
    return p.words?.length > 0;
  }

  async analyze(opts = {}) {
    const p = this.project;
    if (this.busy || !p.reg?.arollId) return;
    this.setBusy(true);
    p.resetEdit();
    try {
      const file = p.reg.items.find((r) => r.id === p.reg.arollId).file;
      const model = $('sttModel').value;
      const lang = $('sttLang').value;
      LS.set('stt.model', model); LS.set('stt.lang', lang);
      this.status('Decoding audio…');
      p.analysis = await analyzeAudio(file);
      this.status('Transcribing…');
      const { words, language } = await transcribe(p.analysis.pcm, {
        model, language: lang,
        cacheKey: `${p.reg.arollId}|${model}|${lang}|${file.size}`,
      });
      p.words = fixPhonetics(freezeWords(words));
      if (!p.words.length) throw new Error('No speech found.');
      if (language) this.status(`Language: ${langName(language)} — generating cut proposals…`);
      p.computeProposals();
      p.useGlm = false; p.glmResult = null; p.variants = null; p.activeVariant = 0;
      this.rebuild();
      this.renderProposalBar();
      this.status(`Ready · ${p.words.length} words · ${p.proposals?.length || 0} cuts proposed`);
      this.playNow();
    } catch (e) {
      console.error(e);
      this.toast(`Analyze failed: ${e.message}`, 4200);
      this.status('Analyze failed');
    } finally { this.setBusy(false); }
  }

  keptSec() { return this.project.edl ? this.project.edl.keep.reduce((a, k) => a + k.out - k.in, 0) : 0; }

  rebuild() {
    const p = this.project;
    const prevT = this.preview.tl ? this.preview.editedTime() : 0;
    p.buildEdl();
    if (!p.edl) return;
    $('emptyMsg').style.display = 'none';
    this.preview.setEdl(p.edl, { keepTime: prevT > 0.02 });
    this.tlv.fit();
    this.renderTranscript();
    this.renderProposalBar();
    this.renderVariants();
    this.renderChapters();
    this.renderScore();
    this.renderScriptTabs();
    this.renderMediaBin();
    this.renderInspector();
    this.renderOverlayList();
    $('durChip').textContent = p.edl ? `${timelineOf(p.edl).duration.toFixed(1)}s` : '';
    this.drawAll();
    this.syncFrame();
    this.syncButtons();
    if (p.settings.autoframe) this.scheduleFacePass();
    this.chatPanel?.renderStatusLine();
    this.scheduleSave();
  }

  refreshDerived() {
    const p = this.project;
    const keep = p.edl.keep.filter((k) => k.out > k.in);
    const tl = timelineOf({ ...p.edl, keep });
    p.edl = { ...p.edl, keep, punches: (p.edl.punches || []).filter((x) => x.at <= tl.duration), transitions: transitionsFor(keep) };
    this.preview.setEdl(p.edl, { keepTime: true });
    this.renderTranscript();
    this.drawAll();
    if (p.settings.autoframe) this.scheduleFacePass();
    this.chatPanel?.renderStatusLine();
    this.scheduleSave();
  }

  scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.persistProject(), 1000);
  }

  async persistProject() {
    const p = this.project;
    if (!p.reg?.arollId || !p.edl) return;
    const arollItem = p.reg.items?.find((r) => r.id === p.reg.arollId);
    const file = arollItem?.file;
    const key = makeProjectKey(arollItem?.name || p.reg.arollId, file?.size);
    const snap = serializeProjectState(p);
    await saveProject(key, snap);
  }

  async checkSavedEdit(file, name) {
    if (!file && !name) return;
    const key = makeProjectKey(name || file?.name, file?.size);
    const snap = await loadProject(key);
    if (snap && snap.edl) {
      this.pendingRestoreSnapshot = snap;
      const banner = $('restoreBanner');
      const msg = $('restoreMsg');
      if (banner && msg) {
        const timeAgo = snap.savedAt ? new Date(snap.savedAt).toLocaleTimeString() : 'earlier';
        msg.textContent = `Saved edit found for ${name || file.name} (${timeAgo}). Restore last edit?`;
        banner.hidden = false;
      }
      if (!this.project.edl && snap.words?.length) {
        this.restoreLastEdit(true);
      }
    } else {
      this.hideRestoreBanner();
    }
  }

  hideRestoreBanner() {
    this.pendingRestoreSnapshot = null;
    const banner = $('restoreBanner');
    if (banner) banner.hidden = true;
  }

  restoreLastEdit(isAuto = false) {
    const snap = this.pendingRestoreSnapshot;
    if (!snap) return;
    const p = this.project;
    applyProjectSnapshot(p, snap);
    if (p.reg?.arollId && p.edl) p.edl.style.arollId = p.reg.arollId;
    this.rebuild();
    this.renderProposalBar();
    this.chatPanel?.renderMessages();
    this.chatPanel?.renderStatusLine();
    if (!isAuto) {
      this.hideRestoreBanner();
      this.toast('Restored last edit');
    }
  }

  toggleCropMode(i) {
    if (this.cropModeClipIndex === i) {
      this.cropModeClipIndex = null;
    } else {
      this.cropModeClipIndex = i;
      this.selectClip(i);
      this.toast('Crop mode: drag on player to set crop rectangle');
    }
    this.renderInspector();
    this.preview.redraw();
  }

  drawCropOverlay(ctx, w, h) {
    const p = this.project;
    const clip = p.edl?.keep?.[this.cropModeClipIndex];
    if (!clip) return;
    const cr = normalizeCropRect(clip.cropRect || { x: 0, y: 0, w: 1, h: 1 });
    const x = cr.x * w, y = cr.y * h, cw = cr.w * w, ch = cr.h * h;

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, w, y);
    ctx.fillRect(0, y + ch, w, h - (y + ch));
    ctx.fillRect(0, y, x, ch);
    ctx.fillRect(x + cw, y, w - (x + cw), ch);

    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, cw, ch);

    ctx.fillStyle = '#fff';
    const s = 6;
    ctx.fillRect(x - s / 2, y - s / 2, s, s);
    ctx.fillRect(x + cw - s / 2, y - s / 2, s, s);
    ctx.fillRect(x - s / 2, y + ch - s / 2, s, s);
    ctx.fillRect(x + cw - s / 2, y + ch - s / 2, s, s);
    ctx.restore();
  }

  async toggleVoiceover() {
    if (!this.isRecordingVo) {
      if (!navigator.mediaDevices?.getUserMedia) {
        return this.toast('Microphone not supported in this browser');
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.recordedChunks = [];
        this.mediaRecorder = new MediaRecorder(stream);
        this.mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) this.recordedChunks.push(e.data);
        };
        this.recordStartT = this.preview.tl ? this.preview.editedTime() : 0;
        this.recordStartTime = performance.now();
        this.isRecordingVo = true;
        this.mediaRecorder.start();
        const btn = $('voBtn');
        if (btn) {
          btn.textContent = '⏹ Stop VO';
          btn.style.background = 'var(--danger)';
          btn.style.color = '#fff';
          btn.style.borderColor = 'var(--danger)';
        }
        this.toast('Recording voiceover… click Stop when done');
      } catch (err) {
        this.toast(`Microphone error: ${err.message}`);
      }
    } else {
      this.isRecordingVo = false;
      const btn = $('voBtn');
      if (btn) {
        btn.textContent = '🎙️ Voiceover';
        btn.style.background = '';
        btn.style.color = '';
        btn.style.borderColor = '';
      }
      if (this.mediaRecorder) {
        this.mediaRecorder.onstop = () => {
          const blob = new Blob(this.recordedChunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
          const dur = (performance.now() - this.recordStartTime) / 1000;
          const id = `vo-${Date.now()}`;
          const name = `Voiceover ${new Date().toLocaleTimeString()}`;
          const file = new File([blob], `${id}.webm`, { type: blob.type });

          this.project.reg = this.project.reg || { items: [] };
          this.project.reg.items.push({ id, name, kind: 'audio', file });

          this.pushUndo();
          this.project.edl = this.project.edl || {};
          this.project.edl.audioOverlays = this.project.edl.audioOverlays || [];
          this.project.edl.audioOverlays.push({
            id, src: id, at: Math.max(0, this.recordStartT), dur: Math.max(0.5, dur), volume: 1, name,
          });
          this.refreshDerived();
          this.scheduleSave();
          this.toast(`Voiceover recorded (${dur.toFixed(1)}s)`);
        };
        this.mediaRecorder.stop();
        this.mediaRecorder.stream?.getTracks().forEach((t) => t.stop());
      }
    }
  }

  // ---------- face pass ----------
  scheduleFacePass() {
    clearTimeout(this.faceTimer);
    this.faceTimer = setTimeout(() => this.runFacePass(), 400);
  }
  calibratePolish() {
    if (this._levelsDone || !this.project.edl || !this.compositor.polish?.autoLevels) return;
    const cv = $('player');
    this.compositor.polish._levels = calibrateLevels(cv.getContext('2d'), cv.width, cv.height);
    this._levelsDone = true;
  }

  async runFacePass() {
    const p = this.project;
    if (!p.edl || !p.reg?.arollId) return;
    try {
      const faces = await sampleFaceTrack(p.edl, (id) => p.reg.items.find((r) => r.id === id)?.file);
      if (!p.edl || !faces.length) return;
      p.edl.faces = faces;
      const v = p.variant;
      if (v) v.faces = faces;
      this.calibratePolish();
      this.preview.redraw();
      this.drawAll();
      this.status(`Auto-framed · ${faces.length} keyframes`);
    } catch (e) { console.warn('face pass failed:', e); }
  }

  // ---------- refine / ask ----------
  async refineFlow(isAsk) {
    const p = this.project;
    if (this.busy) return;
    if (!await this.ensureTranscript()) return;
    const key = $('glmKey').value.trim();
    if (!key) { this.shell.show('settings'); return this.toast('Enter a GLM API key in Settings.'); }
    LS.set('glm.key', key);
    const ask = isAsk ? $('askInput').value.trim() : '';
    if (isAsk) $('askInput').value = '';
    this.setBusy(true);
    try {
      const t0 = performance.now();
      const { truncated, confidence, passes } = await this.agent.refine({
        ask,
        onStatus: (s) => this.status(s),
        getPrompt: () => $('glmPrompt').value,
        council: $('councilOn').checked,
        stance: $('stanceSel').value || 'balanced',
      });
      if (this.project.lastDebate) {
        this.project.lastDebate.secs = ((performance.now() - t0) / 1000).toFixed(1);
        const { evaluate } = await import('./core/ScoreEngine.js');
        this.project.lastDebate.scoreAfter = this.project.edl ? evaluate(this.project.edl, timelineOf(this.project.edl), this.project.words, { platform: this.project.settings.platform }).total : null;
        $('debateChip').hidden = false;
        $('debateChip').textContent = `🧠 Council · ${this.project.lastDebate.scoreBefore ?? '–'}→${this.project.lastDebate.scoreAfter ?? '–'} ▾`;
      }
      LS.set('glm.prompt', $('glmPrompt').value);
      this.rebuild();
      this.status(`${ask ? 'AI applied' : 'GLM edit'} · ${this.keptSec().toFixed(1)}s · conf ${confidence.toFixed(2)} (${passes})${truncated ? ' · salvaged' : ''}`);
    } catch (e) {
      console.error(e);
      this.toast(`Refine failed: ${e.message}`, 4200);
      this.status('Refine failed');
    } finally { this.setBusy(false); }
  }

  // ---------- variants ----------
  renderVariants() {
    const p = this.project;
    const row = $('variantRow');
    row.textContent = '';
    if (!p.variants || p.variants.length < 2) { row.hidden = true; return; }
    row.hidden = false;
    p.variants.forEach((v, i) => {
      const chip = document.createElement('button');
      chip.className = 'chip' + (i === p.activeVariant ? ' on' : '');
      const vd = v.keeps.reduce((a, k) => a + k.out - k.in, 0);
      chip.textContent = `${i + 1}. ${v.title} · ${v.score || '–'} · ${Math.round(vd)}s`;
      chip.title = 'Director\'s Cut: score · duration';
      chip.onclick = () => {
        if (this.busy) return;
        this.pushUndo();
        if (p.switchVariant(i)) { this.rebuild(); this.toast(`Variant ${i + 1}`); }
      };
      row.appendChild(chip);
    });
  }

  // ---------- chapters ----------
  renderChapters() {
    const p = this.project;
    const el = $('chapters');
    el.textContent = '';
    $('chapterBar').style.display = 'none';
    const chapters = p.edl?.chapters ?? [];
    if (!chapters.length) { el.hidden = true; return; }
    const tl = timelineOf(p.edl);
    const fmt = (t) => {
      const s = Math.max(0, Math.floor(t));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
      return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    const lines = [];
    for (const c of chapters) {
      let t = tl.sourceToEdited(p.words[c.from]?.start ?? 0);
      if (t == null) for (let i = c.from; i <= c.to; i++) { const e = tl.sourceToEdited(p.words[i]?.start ?? 0); if (e != null) { t = e; break; } }
      if (t == null) continue;
      lines.push(`${fmt(t)} ${c.title}`);
      const div = document.createElement('div');
      div.textContent = `${fmt(t)}  ${c.title}`;
      div.style.cssText = 'font-family:var(--mono);font-size:11.5px;padding:2px 0;cursor:pointer;color:var(--ink-2)';
      div.onclick = () => { this.preview.seekTo(t + 0.01); this.drawAll(t + 0.01); };
      el.appendChild(div);
    }
    el.dataset.desc = lines.join('\n');
    el.hidden = !lines.length;
    $('chapterBar').style.display = lines.length ? '' : 'none';
  }
  copyChapters() {
    const desc = $('chapters')?.dataset?.desc;
    if (!desc) return this.toast('No chapters');
    navigator.clipboard?.writeText(desc).then(() => this.toast('YouTube description copied'), () => this.toast('Clipboard blocked'));
  }

  // ---------- transcript ----------
  wordKept(w) {
    return this.project.edl?.keep.some((k) => w.start >= k.in - 0.01 && w.start < k.out);
  }

  wordProposal(w) {
    const p = this.project;
    if (!p.proposals || p.proposalsApplied) return null;
    return p.proposals.find((pr) => pr.wordIndices?.includes(w.i));
  }

  wordCutReason(w) {
    const p = this.project;
    if (this.wordKept(w)) return null;
    const ov = p.activeOverrides;
    if (ov.cuts.includes(w.i)) return 'manual';
    if (FILLER_RE.test(w.w)) return `filler "${w.w}"`;
    const prop = p.proposals?.find((pr) => pr.wordIndices?.includes(w.i));
    if (prop) return prop.why;
    return 'pause';
  }

  renderProposalBar() {
    const p = this.project;
    const bar = $('proposalBar');
    const info = $('proposalInfo');
    const debateBar = $('debateSummaryBar');
    if (!bar || !info) return;

    if (!p.proposals || !p.proposals.length || p.proposalsApplied) {
      bar.style.display = 'none';
      if (debateBar) debateBar.style.display = 'none';
      return;
    }

    const sum = proposalSummary(p.proposals, p.analysis?.duration || 1);
    info.textContent = sum.text;
    bar.style.display = 'flex';

    if (p.debateSummary?.text && debateBar) {
      debateBar.textContent = `⚖ Council: ${p.debateSummary.text}`;
      debateBar.style.display = 'block';
    } else if (debateBar) {
      debateBar.style.display = 'none';
    }
  }

  applyAllProposals() {
    const p = this.project;
    if (!p.proposals?.length) return;
    this.pushUndo();
    for (const prop of p.proposals) {
      if (prop.status !== 'rejected') prop.status = 'accepted';
    }
    p.applyProposals();
    this.rebuild();
    this.renderProposalBar();
    this.toast(`Applied cuts (${this.keptSec().toFixed(1)}s kept)`);
  }

  async debateProposals() {
    const p = this.project;
    if (!p.proposals?.length) return;
    this.setBusy(true);
    this.status('Council debating borderline proposals…');
    try {
      const glmKey = $('glmKey')?.value.trim();
      const glmClient = glmKey ? { apiKey: glmKey, baseUrl: $('glmEndpoint')?.value, model: $('glmModel')?.value } : null;
      const { summary } = await runDebateCouncil(p.proposals, {
        words: p.words,
        energy: p.analysis?.energy,
        hopSec: p.analysis?.hopSec,
        thresholdDb: p.analysis?.energy ? calibrateThreshold(p.analysis.energy) : -35,
      }, { glmClient });
      p.debateSummary = summary;
      this.renderProposalBar();
      this.renderTranscript();
      this.drawAll(-2);
      this.toast('Council debate finished');
      this.status(`Debate finished · ${summary.text}`);
    } catch (err) {
      console.error(err);
      this.toast(`Debate failed: ${err.message}`);
    } finally {
      this.setBusy(false);
    }
  }

  dismissAllProposals() {
    const p = this.project;
    if (!p.proposals?.length) return;
    this.pushUndo();
    rejectAllProposals(p.proposals);
    p.proposalsApplied = true;
    p.baseKeeps = [{ in: 0, out: p.analysis.duration, why: 'speech' }];
    this.rebuild();
    this.renderProposalBar();
    this.toast('All proposed cuts dismissed');
  }

  renderTranscript() {
    const p = this.project;
    const el = $('transcript');
    el.textContent = '';
    $('wordDetail').textContent = p.words ? 'click: cut/keep/toggle · dblclick: sentence · right-click: options' : 'word-level timings appear after Analyze';
    if (!p.words) return;
    const fmt = (t) => { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(3).padStart(6, '0')}`; };
    const frag = document.createDocumentFragment();
    let clickTimer = 0;

    const inProposalPhase = !p.proposalsApplied && p.proposals && p.proposals.length > 0;

    const pausePropsAfter = new Map();
    if (inProposalPhase) {
      for (const prop of p.proposals) {
        if (prop.kind === 'pause' || prop.kind === 'gap') {
          let afterIdx = prop.afterWord;
          if (afterIdx == null) {
            for (let i = p.words.length - 1; i >= 0; i--) {
              if (p.words[i].end <= prop.start + 0.05) { afterIdx = i; break; }
            }
          }
          if (afterIdx != null && afterIdx >= 0) {
            if (!pausePropsAfter.has(afterIdx)) pausePropsAfter.set(afterIdx, []);
            pausePropsAfter.get(afterIdx).push(prop);
          }
        }
      }
    }

    for (let i = 0; i < p.words.length; i++) {
      const w = p.words[i];
      const sp = document.createElement('span');
      sp.className = 'w';
      sp.textContent = w.w;
      sp.dataset.idx = String(w.i);
      if (w.bleep) {
        sp.classList.add('bleeped');
        sp.title = 'Bleeped (1kHz censor tone)';
      }

      const prop = this.wordProposal(w);
      const isKept = this.wordKept(w);

      if (inProposalPhase && prop) {
        if (prop.status === 'accepted' || prop.status === 'pending') {
          sp.classList.add('proposed', prop.status);
          const durMs = Math.round(prop.duration * 1000);
          sp.title = `Proposed cut: ${prop.why} (${prop.status}) · ${durMs}ms`;
        } else if (prop.status === 'rejected') {
          sp.classList.add('kept-by-debate');
          sp.title = prop.keptReason || 'kept: jeda dramatis (Storyteller)';
        }
      } else {
        if (!isKept) {
          sp.classList.add('cut');
          const reason = this.wordCutReason(w);
          sp.title = `Cut: ${reason}`;
        } else {
          const debProp = p.proposals?.find((pr) => pr.wordIndices?.includes(w.i) && pr.status === 'rejected');
          if (debProp) {
            sp.classList.add('kept-by-debate');
            sp.title = debProp.keptReason || 'kept: jeda dramatis (Storyteller)';
          }
        }
      }

      sp.onmouseenter = () => {
        const ms = Math.round((w.end - w.start) * 1000);
        if (inProposalPhase && prop) {
          $('wordDetail').textContent = `“${w.w}” · ${fmt(w.start)} → ${fmt(w.end)} · ${ms}ms · proposed: ${prop.why} [${prop.status}]`;
        } else if (!isKept) {
          $('wordDetail').textContent = `“${w.w}” · ${fmt(w.start)} → ${fmt(w.end)} · ${ms}ms · cut: ${this.wordCutReason(w)}`;
        } else {
          const debProp = p.proposals?.find((pr) => pr.wordIndices?.includes(w.i) && pr.status === 'rejected');
          const keptInfo = debProp?.keptReason ? ` · ${debProp.keptReason}` : '';
          $('wordDetail').textContent = `“${w.w}” · ${fmt(w.start)} → ${fmt(w.end)} · ${ms}ms · kept${keptInfo}`;
        }
      };

      sp.onclick = () => {
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => {
          if (inProposalPhase && prop) {
            toggleProposalStatus(p.proposals, prop.id);
            this.renderTranscript();
            this.renderProposalBar();
            this.drawAll(-2);
            this.toast(prop.status === 'accepted' ? 'Cut proposal accepted' : 'Proposal rejected (kept)');
          } else {
            this.toggleWord(w.i, [w.i]);
          }
        }, 220);
      };

      sp.ondblclick = () => { clearTimeout(clickTimer); this.toggleSentence(w.i); };
      sp.oncontextmenu = (e) => {
        e.preventDefault();
        this.openTranscriptContextMenu(e, w);
      };

      frag.append(sp, document.createTextNode(' '));

      if (pausePropsAfter.has(i)) {
        for (const pauseProp of pausePropsAfter.get(i)) {
          const chip = document.createElement('span');
          chip.className = `w proposed pause-chip ${pauseProp.status}`;
          chip.textContent = `⏸ ${pauseProp.duration}s`;
          chip.title = `${pauseProp.why} (${pauseProp.status}) · click to ${pauseProp.status === 'accepted' ? 'reject' : 'accept'}`;
          chip.onclick = (e) => {
            e.stopPropagation();
            toggleProposalStatus(p.proposals, pauseProp.id);
            this.renderTranscript();
            this.renderProposalBar();
            this.drawAll(-2);
            this.toast(pauseProp.status === 'accepted' ? 'Pause cut accepted' : 'Pause cut rejected (kept)');
          };
          frag.append(chip, document.createTextNode(' '));
        }
      }
    }
    el.appendChild(frag);
    this.renderTakeStacks(el);
    this.renderStickerSuggestions();
  }

  openTranscriptContextMenu(e, clickedWord) {
    const sel = window.getSelection();
    let selectedWords = [clickedWord];
    if (sel && !sel.isCollapsed) {
      const selectedSpans = $('transcript').querySelectorAll('.w');
      const inRange = [];
      for (const sp of selectedSpans) {
        if (sel.containsNode(sp, true) && sp.dataset.idx != null) {
          const idx = Number(sp.dataset.idx);
          if (this.project.words[idx]) inRange.push(this.project.words[idx]);
        }
      }
      if (inRange.length > 0) selectedWords = inRange;
    }
    this.contextTargetWords = selectedWords;

    const menu = $('transcriptContextMenu');
    if (!menu) return;
    menu.style.display = 'block';
    menu.style.left = `${Math.min(window.innerWidth - 170, e.clientX)}px`;
    menu.style.top = `${Math.min(window.innerHeight - 150, e.clientY)}px`;
  }

  closeContextMenu() {
    const menu = $('transcriptContextMenu');
    if (menu) menu.style.display = 'none';
  }

  handleContextAction(action) {
    this.closeContextMenu();
    const words = this.contextTargetWords;
    if (!words || !words.length) return;
    const indices = words.map((w) => w.i);

    switch (action) {
      case 'cut':
        this.pushUndo();
        for (const i of indices) {
          this.project.activeOverrides.keeps = this.project.activeOverrides.keeps.filter((x) => x !== i);
          if (!this.project.activeOverrides.cuts.includes(i)) this.project.activeOverrides.cuts.push(i);
        }
        this.rebuild();
        this.toast(`Cut ${words.length} word${words.length > 1 ? 's' : ''}`);
        break;

      case 'keep':
        this.pushUndo();
        for (const i of indices) {
          this.project.activeOverrides.cuts = this.project.activeOverrides.cuts.filter((x) => x !== i);
          if (!this.project.activeOverrides.keeps.includes(i)) this.project.activeOverrides.keeps.push(i);
        }
        this.rebuild();
        this.toast(`Kept ${words.length} word${words.length > 1 ? 's' : ''}`);
        break;

      case 'ask-ai':
        this.openInlineChat(words);
        break;

      case 'punch':
        if (!this.project.edl) return;
        this.pushUndo();
        const w0 = words[0];
        const punchAt = (w0.start + w0.end) / 2;
        this.project.edl.punches = this.project.edl.punches || [];
        this.project.edl.punches.push({ at: punchAt, scale: 1.15, ms: 400, kind: 'emphasis' });
        this.project.edl.punches.sort((a, b) => a.at - b.at);
        this.refreshDerived();
        this.toast(`Zoom punch added on "${w0.w}"`);
        break;

      case 'bleep':
        this.pushUndo();
        this.project.bleeps = this.project.bleeps || [];
        let anyBleeped = false;
        for (const w of words) {
          w.bleep = !w.bleep;
          if (w.bleep) {
            anyBleeped = true;
            if (!this.project.bleeps.includes(w.i)) this.project.bleeps.push(w.i);
          } else {
            this.project.bleeps = this.project.bleeps.filter((x) => x !== w.i);
          }
        }
        this.renderTranscript();
        this.scheduleSave();
        this.toast(anyBleeped ? `🔕 Bleeped ${words.length} word${words.length > 1 ? 's' : ''}` : `Unbleeped ${words.length} word${words.length > 1 ? 's' : ''}`);
        break;
    }
  }

  openInlineChat(words) {
    const box = $('inlineChatBox');
    if (!box) return;
    this.chatWords = words;
    this.clearChatDiff();
    this.renderChatHistory();

    const menu = $('transcriptContextMenu');
    const x = parseInt(menu?.style.left || '100', 10);
    const y = parseInt(menu?.style.top || '100', 10);
    box.style.left = `${Math.min(window.innerWidth - 340, Math.max(10, x))}px`;
    box.style.top = `${Math.min(window.innerHeight - 280, Math.max(10, y))}px`;
    box.style.display = 'block';

    const input = $('inlineChatInput');
    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 50);
    }
  }

  closeInlineChat() {
    const box = $('inlineChatBox');
    if (box) box.style.display = 'none';
    this.clearChatDiff();
  }

  clearChatDiff() {
    this.pendingChatOp = null;
    const card = $('chatDiffCard');
    if (card) card.style.display = 'none';
    const transcript = $('transcript');
    if (transcript) {
      transcript.querySelectorAll('.chat-diff-highlight').forEach((el) => el.classList.remove('chat-diff-highlight'));
    }
  }

  renderChatHistory() {
    const el = $('chatHistory');
    if (!el) return;
    el.innerHTML = '';
    const history = this.project.chatHistory || [];
    if (!history.length) {
      const hint = document.createElement('div');
      hint.style.cssText = 'color:var(--ink-2);font-style:italic';
      hint.textContent = 'Ask AI to modify cuts, pauses, or punches for selected words.';
      el.appendChild(hint);
      return;
    }
    for (const h of history.slice(-5)) {
      const row = document.createElement('div');
      row.style.cssText = 'padding:3px 6px;border-radius:4px;background:var(--bg-raise)';
      row.innerHTML = `<span style="font-weight:600;color:var(--accent)">You:</span> ${h.text} <span style="color:var(--ink-2);font-size:10px">(${h.applied ? 'applied' : 'reverted'})</span>`;
      el.appendChild(row);
    }
  }

  async submitInlineChat(e) {
    if (e) e.preventDefault();
    const input = $('inlineChatInput');
    const q = input?.value.trim();
    if (!q) return;

    const op = parseChatCommand(q, {
      selectedWords: this.chatWords || [],
      allWords: this.project.words || [],
      currentEdl: this.project.edl,
      playheadSrc: this.preview.editedTime(),
    });

    this.pendingChatOp = { ...op, query: q };
    this.pendingChatQuery = q;

    const card = $('chatDiffCard');
    const label = $('chatDiffLabel');
    const expl = $('chatDiffExpl');
    if (card && label && expl) {
      label.textContent = op.label;
      expl.textContent = op.explanation;
      card.style.display = 'block';
    }

    const transcript = $('transcript');
    if (transcript && op.wordIndices?.length) {
      for (const idx of op.wordIndices) {
        const span = transcript.querySelector(`.w[data-idx="${idx}"]`);
        if (span) span.classList.add('chat-diff-highlight');
      }
    }
  }

  applyChatOperation() {
    if (!this.pendingChatOp) return;
    this.pushUndo();
    const changed = applyChatOp(this.project, this.pendingChatOp);
    this.project.chatHistory.push({
      role: 'user',
      text: this.pendingChatQuery || this.pendingChatOp.label,
      op: this.pendingChatOp,
      applied: true,
      at: Date.now(),
    });
    this.clearChatDiff();
    if (changed) this.rebuild();
    this.renderChatHistory();
    this.toast(`Applied: ${this.pendingChatOp.label}`);
    $('inlineChatInput').value = '';
  }

  revertChatOperation() {
    if (this.pendingChatOp) {
      this.project.chatHistory.push({
        role: 'user',
        text: this.pendingChatQuery || this.pendingChatOp.label,
        op: this.pendingChatOp,
        applied: false,
        at: Date.now(),
      });
    }
    this.clearChatDiff();
    this.renderChatHistory();
    this.toast('Diff reverted');
    $('inlineChatInput').value = '';
  }
  toggleSentence(i) {
    const p = this.project;
    let from = i, to = i;
    while (from > 0 && !/[.!?…]$/.test(p.words[from].w)) from--;
    while (to < p.words.length - 1 && !/[.!?…]$/.test(p.words[to].w)) to++;
    this.toggleWord(i, Array.from({ length: to - from + 1 }, (_, k) => from + k));
  }
  toggleWord(i, idxs) {
    const p = this.project;
    if (!p.edl) return;
    this.pushUndo();
    const kept = this.wordKept(p.words[i]);
    const ov = p.activeOverrides;
    const cuts = new Set(ov.cuts.filter((c) => typeof c === 'number')), keeps = new Set(ov.keeps);
    for (const j of idxs) { if (kept) cuts.add(j); else keeps.add(j); keeps.has(j) && !kept && cuts.delete(j); }
    ov.cuts = [...cuts]; ov.keeps = [...keeps];
    this.rebuild();
    this.toast(kept ? 'Cut (⌘Z to undo)' : 'Restored');
  }
  editWord(span, i) {
    const w = this.project.words[i];
    const input = document.createElement('input');
    input.value = w.w;
    input.style.cssText = 'font:inherit;font-size:13px;width:80px;border:1px solid var(--accent);border-radius:4px;background:var(--bg)';
    span.textContent = '';
    span.appendChild(input);
    input.focus(); input.select();
    const commit = (save) => {
      const v = input.value.trim();
      if (save && v && v !== w.w) { w.w = v; this.project.edl = { ...this.project.edl }; this.rebuild(); this.toast(`Fixed: “${v}”`); }
      else this.renderTranscript();
    };
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') commit(true); if (e.key === 'Escape') commit(false); };
    input.onblur = () => commit(input.value.trim() !== w.w);
  }
  highlightWord() {
    if (!this.project.edl || !this.project.words.length) return;
    const tl = timelineOf(this.project.edl);
    const src = tl.editedToSource(this.preview.editedTime())?.src ?? -1;
    const idx = this.project.words.findIndex((w) => src >= w.start && src < w.end);
    if (idx === this._curWord) return;
    const el = $('transcript');
    el.querySelector('.w.cur')?.classList.remove('cur');
    this._curWord = idx;
    el.children[idx]?.classList.add('cur');
  }

  // ---------- timeline edits ----------
  /** media-bin drag-and-drop onto a timeline lane */
  onTimelineDrop({ id, kind }, t, lane) {
    const p = this.project;
    if (!p.edl || !id) return;
    if (kind === 'audio') {
      if (lane === 'a2') {
        p.edl = { ...p.edl, sfx: [...(p.edl.sfx || []), { at: Math.max(0, t - 0.08), kind: 'pop', gainDb: -14 }] };
        this.refreshDerived();
        this.toast('SFX placed');
      } else {
        p.bgm = { src: id, gainDb: -20, autoDuck: true };
        p.edl = { ...p.edl, bgm: p.bgm };
        this.refreshDerived();
        this.toast('BGM set');
      }
      return;
    }
    insertBrollAt(this, id, t);
  }

  /** magnetic V-track reorder: swap keep order when a segment is dragged past a neighbor */
  reorderSegment(from, to) {
    const p = this.project;
    if (!p.edl || to < 0 || to >= p.edl.keep.length || from === to) return;
    this.pushUndo();
    const keep = [...p.edl.keep];
    const [moved] = keep.splice(from, 1);
    keep.splice(to, 0, moved);
    p.edl = { ...p.edl, keep };
    this.refreshDerived();
    this.toast(to === 0 ? 'New opening — cold open swapped' : 'Reordered');
  }

  trimSegment(i, edge, tEdited) {
    const p = this.project;
    const tl = timelineOf(p.edl);
    const seg = tl.segments[i];
    const srcKeep = p.edl.keep[i];
    if (!seg || !srcKeep) return;
    if (!this.trimAnchor || this.trimAnchor.i !== i) this.trimAnchor = { i, in0: srcKeep.in, out0: srcKeep.out, segT0: tl.starts[i] };
    const a = this.trimAnchor;
    const srcAt = a.in0 + (tEdited - a.segT0);
    const keep = p.edl.keep.map((k, j) => (j === i ? { ...k } : k));
    const k = keep[i];
    const chrono = keep.filter((x, j) => j !== i).sort((x, y) => x.in - y.in);
    const prev = chrono.filter((x) => x.out <= a.out0).pop();
    const next = chrono.find((x) => x.in >= a.in0);
    const MIN = 0.12;
    if (edge === 'in') k.in = Math.max(prev ? prev.out + MIN : 0, Math.min(srcAt, a.out0 - MIN));
    else k.out = Math.max(a.in0 + MIN, Math.min(srcAt, next ? next.in - MIN : p.analysis.duration));
    p.edl = { ...p.edl, keep };
    this.preview.setEdl(p.edl, { keepTime: true });
    this.drawAll();
  }
  trimAtPlayhead(edge) {
    const p = this.project;
    const tl = timelineOf(p.edl);
    this.trimSegment(tl.segmentAt(this.preview.editedTime()), edge, this.preview.editedTime());
    this.refreshDerived();
  }
  // Ripple trim (owner 1 Nov, ala CapCut "delete to playhead"): Q = buang semua sebelum
  // playhead, W = buang semua sesudah. Klip yang tertimpa playhead di-trim tepat di situ.
  rippleToPlayhead(side) {
    const p = this.project;
    if (!p.edl || p.edl.keep.length < 2) return this.toast('Need 2+ clips to ripple');
    const tl = timelineOf(p.edl);
    const t = this.preview.editedTime();
    const m = tl.editedToSource(t);
    const i = m ? m.seg : null;
    if (i == null) return this.toast('Nothing to ripple');
    const keep = p.edl.keep;
    let next, toastMsg;
    if (side === 'left') {
      if (i === 0 && keep[0].in + 0.2 >= m.src) return this.toast('Already at start');
      this.pushUndo();
      next = keep.slice(i);
      if (m.src > next[0].in + 0.05) next[0] = { ...next[0], in: m.src };
      toastMsg = 'Ripple: cut left (⌘Z)';
    } else {
      if (i === keep.length - 1 && keep[keep.length - 1].out - 0.2 <= m.src) return this.toast('Already at end');
      this.pushUndo();
      next = keep.slice(0, i + 1);
      const last = next[next.length - 1];
      if (m.src < last.out - 0.05) next[next.length - 1] = { ...last, out: m.src };
      toastMsg = 'Ripple: cut right (⌘Z)';
    }
    if (next.some((k) => k.out - k.in < 0.05)) { this.undoStack.pop(); return this.toast('Too close to an edge'); }
    p.edl = { ...p.edl, keep: next, punches: (p.edl.punches || []).filter((x) => x.at <= tl.duration), transitions: transitionsFor(next) };
    this.preview.setEdl(p.edl, { keepTime: side === 'right' });
    this.renderTranscript();
    this.drawAll();
    this.scheduleSave();
    this.toast(toastMsg);
  }
  splitAt(t) {
    const p = this.project;
    const tl = timelineOf(p.edl);
    const m = tl.editedToSource(t);
    if (!m) return;
    const i = m.seg, k = p.edl.keep[i];
    if (!k || m.src <= k.in + 0.2 || m.src >= k.out - 0.2) return this.toast('Too close to an edge');
    this.pushUndo();
    const keep = p.edl.keep.map((x, j) => (j === i ? [{ ...x, out: m.src }, { ...x, in: m.src }] : x)).flat();
    p.edl = { ...p.edl, keep, transitions: transitionsFor(keep) };
    this.preview.setEdl(p.edl, { keepTime: true });
    this.renderTranscript();
    this.drawAll();
    this.toast('Split');
  }
  deleteClipAt(i) {
    const p = this.project;
    if (i == null || !p.edl || p.edl.keep.length <= 1) return this.toast('Nothing to delete');
    this.pushUndo();
    const keep = p.edl.keep.filter((_, j) => j !== i);
    p.edl = { ...p.edl, keep, transitions: transitionsFor(keep) };
    this.preview.setEdl(p.edl, { keepTime: true });
    this.renderTranscript();
    this.drawAll();
    this.toast(`Deleted clip ${i + 1}`);
    this.selectedClipIndex = null;
    this.renderInspector();
  }

  // ---------- selection + clip property mutations (inspector) ----------
  selectClip(i) {
    this.selectedClipIndex = i;
    this.renderInspector();
    this.drawAll();
  }

  /** generic replace-object clip mutation — undo → new clip → new edl → refresh */
  mutateClip(i, patch) {
    const p = this.project;
    if (!p.edl || i == null || !p.edl.keep[i]) return;
    this.pushUndo();
    const keep = p.edl.keep.map((k, j) => (j === i ? { ...k, ...patch } : k));
    p.edl = { ...p.edl, keep, transitions: transitionsFor(keep) };
    this.refreshDerived();
    this.renderScriptTabs();
    this.renderInspector();
  }

  duplicateClip(i) {
    const p = this.project;
    if (!p.edl || i == null || !p.edl.keep[i]) return;
    this.pushUndo();
    const keep = [...p.edl.keep];
    keep.splice(i + 1, 0, { ...p.edl.keep[i] });
    p.edl = { ...p.edl, keep, transitions: transitionsFor(keep) };
    this.refreshDerived();
    this.selectClip(i + 1);
    this.toast('Duplicated (D)');
  }

  renderInspector() { renderInspector(this); }

  openTransitionMenu(seg, at, trans) {
    this._transContext = { seg, at, trans };
    const menu = $('transitionMenu');
    if (!menu) return;
    $('transTypeSel').value = trans?.type || 'dissolve';
    $('transDurRng').value = String(trans?.ms || 150);
    if ($('transDurVal')) $('transDurVal').textContent = `${$('transDurRng').value}ms`;
    menu.style.display = 'block';
    menu.style.left = `${Math.min(window.innerWidth - 200, Math.max(20, window.innerWidth / 2 - 80))}px`;
    menu.style.bottom = '110px';
  }

  applySelectedTransition() {
    if (!this._transContext || !this.project.edl) return;
    const { at } = this._transContext;
    const type = $('transTypeSel').value;
    const ms = Number($('transDurRng').value) || 150;

    this.pushUndo();
    this.project.edl.transitions = (this.project.edl.transitions || []).filter((q) => Math.abs(q.at - at) >= 0.05);
    if (type !== 'none') {
      this.project.edl.transitions.push({ at, ms, type });
      this.project.edl.transitions.sort((a, b) => a.at - b.at);
    }
    this.refreshDerived();
    this.scheduleSave();
    this.toast(type === 'none' ? 'Transition removed (hard cut)' : `Transition set: ${type} (${ms}ms)`);
  }

  renderStickerSuggestions() {
    const box = $('stickerSuggestionBox');
    const el = $('stickerSuggestions');
    if (!box || !el) return;
    el.textContent = '';
    const suggestions = suggestStickers(this.project.words || []);
    if (!suggestions.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    for (const s of suggestions) {
      const chip = document.createElement('button');
      chip.className = 'tbtn';
      chip.style.cssText = 'width:auto;padding:2px 8px;font-size:11px;display:flex;align-items:center;gap:4px';
      chip.textContent = `${s.char} "${s.word}"`;
      chip.title = `Add ${s.char} sticker at "${s.word}"`;
      chip.onclick = () => {
        if (!this.project.edl) return;
        const tl = timelineOf(this.project.edl);
        const at = tl.sourceToEdited(s.at) ?? this.preview.editedTime();
        this.addOverlay({
          type: 'sticker',
          char: s.char,
          t0: Math.max(0, at - 0.2),
          t1: Math.min(tl.duration, at + 2.0),
        });
        this.toast(`Added ${s.char} at "${s.word}"`);
      };
      el.appendChild(chip);
    }
  }

  /** one-shot WebAudio audition of a procedural SFX preset */
  auditionSfx(kind) {
    const RATE = 48000;
    const ac = new AudioContext({ sampleRate: RATE });
    const pcm = renderSfx(kind, RATE, -6);
    const buf = ac.createBuffer(1, pcm.length, RATE);
    buf.copyToChannel(pcm, 0);
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(ac.destination);
    src.start();
    src.onended = () => ac.close();
  }

  // ---------- overlays: manual text + stickers ----------
  addOverlay(o) {
    const p = this.project;
    if (!p.edl) return this.toast('Analyze a video first');
    this.pushUndo();
    const t = this.preview.editedTime();
    const dur = timelineOf(p.edl).duration;
    const y = o.type === 'text' ? (o.preset === 'subtitle' ? 0.84 : 0.16 + 0.07 * p.overlays.length) : 0.3;
    // a playhead near the end backs the window up — never a degenerate t1 <= t0
    const t0 = Math.max(0, Math.min(t, dur - 3.01));
    p.overlays.push({ t0, t1: Math.min(dur - 0.01, t0 + 3), x: 0.5, y, size: 1, rot: 0, ...o });
    p.edl = { ...p.edl, overlays: p.overlays };
    this.preview.redraw();
    this.renderOverlayList();
    this.toast('Added at playhead — drag it on the player');
  }
  updateOverlay(i, patch, { quiet = false } = {}) {
    const p = this.project;
    if (!p.overlays[i]) return;
    p.overlays[i] = { ...p.overlays[i], ...patch };
    p.edl = { ...p.edl, overlays: p.overlays };
    this.preview.redraw();
    if (!quiet) this.renderOverlayList();
  }
  removeOverlay(i) {
    const p = this.project;
    if (!p.overlays[i]) return;
    this.pushUndo();
    p.overlays.splice(i, 1);
    p.edl = { ...p.edl, overlays: p.overlays };
    this.preview.redraw();
    this.renderOverlayList();
  }
  renderOverlayList() {
    const el = $('overlayList');
    if (!el) return;
    el.textContent = '';
    if (!this.project.overlays.length) {
      const d = document.createElement('div');
      d.className = 'empty-hint';
      d.style.fontSize = '12px';
      d.textContent = 'No overlays yet.';
      el.appendChild(d);
      return;
    }
    this.project.overlays.forEach((o, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:4px;align-items:center';
      const icon = document.createElement('span');
      icon.textContent = o.type === 'text' ? '✍️' : (o.char || '◆');
      icon.style.cssText = 'font-size:14px;flex:none';
      const input = document.createElement('input');
      input.type = 'text';
      input.style.fontSize = '12px';
      input.value = o.type === 'text' ? (o.text || '') : `${(o.char || o.shape || '')} ${o.t0.toFixed(1)}–${o.t1.toFixed(1)}s`;
      input.readOnly = o.type !== 'text';
      input.onchange = () => this.updateOverlay(i, { text: input.value });
      const del = document.createElement('button');
      del.className = 'tbtn';
      del.style.cssText = 'width:auto;padding:2px 7px;font-size:11px;flex:none';
      del.textContent = '✕';
      del.onclick = () => this.removeOverlay(i);
      row.append(icon, input, del);
      el.appendChild(row);
    });
  }

  // ---------- undo/redo ----------
  pushUndo() {
    const p = this.project;
    this.undoStack.push({
      keep: p.edl?.keep?.map((k) => ({ ...k })),
      overrides: JSON.parse(JSON.stringify(p.activeOverrides)),
      variant: p.activeVariant,
      overlays: (p.overlays || []).map((o) => ({ ...o })),
    });
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
  }
  undo() { this.applySnap(this.undoStack.pop(), 'Undone', this.redoStack); }
  redo() { this.applySnap(this.redoStack.pop(), 'Redone', this.undoStack); }
  applySnap(snap, msg, pushTo) {
    const p = this.project;
    if (!snap) return this.toast(`Nothing to ${msg.toLowerCase()}`);
    pushTo.push({ keep: p.edl?.keep?.map((k) => ({ ...k })), overrides: JSON.parse(JSON.stringify(p.activeOverrides)), variant: p.activeVariant, overlays: (p.overlays || []).map((o) => ({ ...o })) });
    if (p.variants?.[snap.variant] && snap.variant !== p.activeVariant) p.switchVariant(snap.variant);
    const v = p.variant;
    if (v) v.overrides = snap.overrides; else p.overrides = snap.overrides;
    if (snap.overlays) p.overlays = snap.overlays.map((o) => ({ ...o }));
    if (snap.keep?.length) {
      p.edl = { ...p.edl, keep: snap.keep, overlays: p.overlays, transitions: transitionsFor(snap.keep) };
      this.preview.setEdl(p.edl, { keepTime: true });
      this.renderTranscript();
      this.renderVariants();
      this.drawAll();
      this.renderInspector();
      this.renderOverlayList();
    } else this.rebuild();
    this.toast(msg);
    this.scheduleSave();
  }

  // ---------- transport / export ----------
  togglePlay() {
    if (!this.project.edl) return;
    if (this.preview.playing) { this.preview.pause(); $('playBtn').textContent = 'Play'; }
    else { this.preview.play(); $('playBtn').textContent = 'Pause'; }
  }
  async playNow() {
    if (!this.project.edl) return;
    $('playBtn').textContent = 'Pause';
    await this.preview.play();
    if (!this.preview.playing) { $('playBtn').textContent = 'Play'; this.toast('Press Play (autoplay blocked)'); }
  }
  async export() {
    const p = this.project;
    if (this.busy || !p.edl) return;
    const { blockers, warnings } = checkEdl(p.edl, { w: p.edl.style.w, h: p.edl.style.h });
    if (blockers.length) {
      $('errMsg').textContent = `Pre-render QA blocked:\n· ${blockers.join('\n· ')}`;
      $('errPop').style.display = 'block';
      this.status('Export blocked — fix issues first');
      return;
    }
    if (warnings.length) this.toast(`${warnings.length} QA warning(s): ${warnings[0]}`, 3600);
    this.setBusy(true);
    this.preview.pause();
    $('playBtn').textContent = 'Play';
    this.status('Exporting…');
    try {
      await exportVideo({
        edl: p.edl,
        getFile: (id) => p.reg?.items.find((r) => r.id === id)?.file,
        canvas: $('player'),
        compositor: this.compositor,
        qualityFactor: Number(LS.get('quality', '0.1')),
        gainDb: Number(LS.get('vol', '0')),
        sfx: $('sfxOn')?.checked ?? false,
        onProgress: ({ stage, pct }) => this.status(`Exporting ${stage}… ${Math.round((pct ?? 0) * 100)}%`),
      });
      this.status('Exported ✓');
      this.toast('Export finished');
    } catch (e) {
      console.error(e);
      if (e.name !== 'AbortError') {
        $('errMsg').textContent = `${e.message}\n\n${(e.stack || '').split('\n').slice(1, 4).join('\n')}`;
        $('errPop').style.display = 'block';
        this.status('Export failed — click for details');
      }
    } finally { this.setBusy(false); }
  }

  switchScriptTab(tab) {
    this.scriptTab = tab;
    $('scriptView').style.display = tab === 'script' ? '' : 'none';
    $('transcript').style.display = tab === 'raw' ? '' : 'none';
    $('tabScript').style.background = tab === 'script' ? 'var(--bg-raise)' : '';
    $('tabRaw').style.background = tab === 'raw' ? 'var(--bg-raise)' : '';
    if (tab === 'script') renderStoryScript($('scriptView'), this);
    this.renderTakeStacks($('transcript'));
  }
  renderScriptTabs() { this.switchScriptTab(this.scriptTab ?? 'script'); }
  renderMediaBin() { renderMediaBin(this); }

  renderDebate() {
    const d = this.project.lastDebate;
    const pop = $('debatePop');
    if (!d) { this.toast('Run a Council debate first'); return; }
    pop.style.display = pop.style.display === 'block' ? 'none' : 'block';
    const body = $('debateBody');
    body.textContent = '';
    const head = document.createElement('div');
    head.style.cssText = 'font-size:11px;color:var(--ink-2);margin-bottom:8px';
    head.textContent = `🧠 EDITORIAL ROOM · stance ${d.stance} · ${d.secs}s · score ${d.scoreBefore ?? '–'} → ${d.scoreAfter ?? '–'}`;
    body.appendChild(head);
    for (const e of d.log || []) {
      const item = document.createElement('div');
      item.style.cssText = 'border:1px solid var(--border-soft);border-radius:8px;padding:8px 10px;margin-bottom:6px;font-size:12.5px';
      const add = (label, text, color) => {
        if (!text) return;
        const row = document.createElement('div');
        row.style.marginBottom = '3px';
        row.innerHTML = '';
        const b = document.createElement('b'); b.textContent = label + ' '; b.style.color = color || 'var(--ink-2)';
        row.append(b, document.createTextNode(text));
        item.appendChild(row);
      };
      add('🔪', e.rhythmArgument, 'var(--danger)');
      add('✍️', e.scriptwriterCounter, 'var(--ok)');
      add('👉', e.managerialVerdict, 'var(--accent)');
      if (e.scoreImpact) { const s = document.createElement('span'); s.textContent = e.scoreImpact; s.style.cssText = 'font-size:11px;color:var(--accent);font-weight:600'; item.appendChild(s); }
      body.appendChild(item);
    }
    if (!(d.log || []).length) { const e2 = document.createElement('div'); e2.textContent = '(no contested moments — the council agreed immediately)'; e2.style.color = 'var(--ink-2)'; body.appendChild(e2); }
  }

  storyMenu(e, i) {
    const old = document.getElementById('storyMenu');
    if (old) old.remove();
    const p = this.project;
    const menu = document.createElement('div');
    menu.id = 'storyMenu';
    menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:60;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:6px 4px;box-shadow:0 8px 28px rgba(41,38,27,.18);min-width:220px`;
    const item = (label, fn) => {
      const b = document.createElement('div');
      b.textContent = label;
      b.style.cssText = 'padding:5px 10px;font-size:12.5px;cursor:pointer;border-radius:6px';
      b.onmouseenter = () => (b.style.background = 'var(--bg-raise)');
      b.onmouseleave = () => (b.style.background = '');
      b.onclick = () => { menu.remove(); fn(); };
      menu.appendChild(b);
    };
    const k = p.edl.keep[i];
    item(k?.locked ? '🔓 Unlock card (AI may edit)' : '🔒 Lock card (exempt from AI)', () => {
      this.pushUndo();
      p.edl.keep[i].locked = !k.locked;
      if (k.locked) { k.locked = false; } else {
        const ov = p.activeOverrides;
        const a = p.words.findIndex((w) => w.end > k.in);
        let b = -1; for (let j = p.words.length - 1; j >= 0; j--) if (p.words[j].start < k.out) { b = j; break; }
        if (b > a) ov.keeps = [...new Set([...(ov.keeps || []), ...Array.from({ length: b - a + 1 }, (_, n) => a + n)])];
      }
      this.refreshDerived();
      this.renderScriptTabs();
    });
    item('✂️ Remove fillers in this card', () => {
      this.pushUndo();
      const ov = p.activeOverrides;
      const idxs = p.words.map((w, wi) => (w.start >= k.in && w.start < k.out && /^(ya+|u+m+|u+h+|eh+|anu|gitu)$/i.test(w.w) ? wi : -1)).filter((x) => x >= 0);
      ov.cuts = [...(ov.cuts || []), ...idxs];
      this.refreshDerived();
      this.toast(`Cut ${idxs.length} fillers`);
    });
    item('🪄 Fix typos in this card', () => {
      import('../engine/edit-engine.js').then(({ fixPhonetics }) => {
        fixPhonetics(p.words.filter((w) => w.start >= k.in && w.start < k.out));
        p.edl = { ...p.edl };
        this.renderScriptTabs();
        this.toast('Brand names fixed');
      });
    });
    item('🔥 Move to opening (cold open)', () => this.reorderSegment(i, 0));
    item('🎬 Cover this join with B-roll', () => autoFillBroll(this));
    item('🔍 Add zoom punch at card start', () => {
      const tl = timelineOf(p.edl);
      p.edl = { ...p.edl, punches: [...(p.edl.punches || []), { at: tl.starts[i] + 0.05, scale: 1.14, ms: 400, kind: 'cut' }] };
      this.refreshDerived();
      this.toast('Punch added');
    });
    item('🔗 Merge with next card', () => {
      this.pushUndo();
      p.edl = { ...p.edl, keep: mergeKeeps(p.edl.keep, i) };
      this.refreshDerived();
      this.renderScriptTabs();
    });
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  }

  renderScore() {
    const p = this.project;
    const panel = $('scorePanel');
    if (!p.edl) { panel.hidden = true; return; }
    panel.hidden = false;
    const s = evaluate(p.edl, timelineOf(p.edl), p.words, { platform: p.settings.platform });
    const meters = [['Hook', s.hook], ['Pacing', s.pacing], ['Visual', s.visual], ['Story', s.story]];
    $('scoreMeters').textContent = '';
    for (const [label, v] of meters) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;color:var(--ink-2)';
      const name = document.createElement('span');
      name.style.width = '48px';
      name.textContent = label;
      const bar = document.createElement('div');
      bar.style.cssText = 'flex:1;height:4px;border-radius:2px;background:var(--border-soft);overflow:hidden';
      const fill = document.createElement('div');
      fill.style.cssText = `height:100%;width:${v}%;background:var(--accent);transition:width .3s cubic-bezier(.16,1,.3,1)`;
      bar.appendChild(fill);
      const num = document.createElement('span');
      num.style.width = '24px';
      num.textContent = v;
      row.append(name, bar, num);
      $('scoreMeters').appendChild(row);
    }
    $('scoreTotal').textContent = s.total;
    $('scoreWpm').textContent = `${s.wpm} wpm`;
    const dur = timelineOf(p.edl).duration;
    $('durSlider').min = Math.max(5, Math.round(dur * 0.4));
    $('durSlider').max = Math.max(10, Math.round(dur * 1.3));
    $('durVal').textContent = `${Math.round(dur)}s`;
  }

  renderTakeStacks(el) {
    const p = this.project;
    if (!p.words) return;
    const groups = groupTakes(p.words);
    for (const g of groups) {
      const pill = document.createElement('span');
      pill.className = 'takepill';
      pill.textContent = `🔁 ${g.takes.length} takes · #${g.selected + 1}`;
      const body = document.createElement('div');
      body.className = 'takebody';
      g.takes.forEach((t, i) => {
        const opt = document.createElement('span');
        opt.className = 'takeopt' + (i === g.selected ? ' sel' : '');
        opt.textContent = `${i === g.selected ? '✅' : '○'} ${t.text.slice(0, 60)}`;
        opt.onclick = () => {
          this.pushUndo();
          const ov = p.activeOverrides;
          // remove old cuts for this group, add cuts for the newly unselected takes
          const inGroup = (c) => typeof c === 'object' && c.from >= g.from && c.to <= g.to;
          ov.cuts = ov.cuts.filter((c) => !inGroup(c));
          ov.cuts.push(...cutsForSelection(g, i));
          g.selected = i;
          pill.textContent = `🔁 ${g.takes.length} takes · #${i + 1}`;
          this.rebuild();
          this.toast(`Take #${i + 1} selected`);
        };
        body.appendChild(opt);
      });
      pill.onclick = () => { pill.classList.toggle('open'); body.classList.toggle('open'); };
      el.appendChild(pill);
      el.appendChild(body);
    }
  }

  syncButtons() {
    const p = this.project;
    const ready = !!p.edl;
    $('analyzeBtn').disabled = this.busy || !p.reg?.arollId;
    $('refineBtn').disabled = this.busy || !p.words;
    $('askBtn').disabled = this.busy || !p.words;
    $('exportBtn').disabled = this.busy || !ready;
    $('playBtn').disabled = !ready;
    $('pickBtn').disabled = this.busy;
    $('step1').toggleAttribute('data-done', !!p.reg?.arollId);
    $('step2').toggleAttribute('data-done', ready);
    $('modeChip').textContent = p.useGlm ? 'glm' : 'local';
    $('modeChip').classList.toggle('on', p.useGlm);
    $('faceChip').classList.toggle('on', p.settings.autoframe);
  }
}
