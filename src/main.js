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
    this.busy = false;
    this.undoStack = [];
    this.redoStack = [];
    this.trimAnchor = null;
    this.selectedClipIndex = null;
    this.faceTimer = 0;
    this.tlv = createTimelineView($('timeline'), this.timelineHost());
    this.shell = initShell();
    this.wire();
    this.restoreSettings();
  }

  timelineHost() {
    const app = this;
    return {
      getEdl: () => this.project.edl,
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
    $('platform').value = p.platform;
    $('orient').value = p.orientation;
    $('resSel').value = String(p.resolution);
    $('fpsSel').value = String(p.fps);
    $('capMode').value = p.captionsMode === 'off' ? 'off' : 'word-pop';
    $('capStyle').value = p.captionStyle;
    $('fitMode').value = p.fit;
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
    $('musicChip').addEventListener('click', refreshMusicSel);
    on('bgmSel', 'change', () => {
      const p = this.project;
      p.bgm = $('bgmSel').value ? { src: $('bgmSel').value, gainDb: Number($('bgmVol').value), autoDuck: $('bgmDuck').checked } : null;
      LS.set('bgm', JSON.stringify(p.bgm ?? ''));
    });
    on('bgmVol', 'input', () => { if (this.project.bgm) { this.project.bgm.gainDb = Number($('bgmVol').value); LS.set('bgm', JSON.stringify(this.project.bgm)); } });
    on('bgmDuck', 'change', () => { if (this.project.bgm) { this.project.bgm.autoDuck = $('bgmDuck').checked; LS.set('bgm', JSON.stringify(this.project.bgm)); } });
    on('autoSfx', 'change', () => { this.project.settings.autoSfx = $('autoSfx').checked; LS.set('autosfx', $('autoSfx').checked ? '1' : '0'); if (this.project.edl) this.rebuild(); });
    // ✍️ text + 😀 sticker panels
    for (const b of document.querySelectorAll('[data-addtext]')) {
      b.onclick = () => this.addOverlay({ type: 'text', preset: b.dataset.addtext, text: b.dataset.addtext === 'subtitle' ? 'new subtitle' : 'NEW TEXT' });
    }
    const EMOJI = [...'🔥💯😂😍😮🤯👀👇✅❌⚡🎉💀🙌👏🥶😎🤔🚀💰📈❤️🧠👉🏆🎬💡🔔⭐🎯🤝😭'];
    for (const ch of EMOJI) {
      const b = document.createElement('button');
      b.className = 'big';
      b.textContent = ch;
      b.onclick = () => this.addOverlay({ type: 'sticker', char: ch });
      $('emojiGrid').appendChild(b);
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
    this.preview.overlay = (ctx, w, h) => drawGuides(ctx, w, h, this.guideMode);
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
      const nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height;
      const hi = overlayHit(this.project.overlays, nx, ny, this.preview.editedTime());
      if (hi != null) { this.pushUndo(); pan = { ov: hi }; return; }
      pan = { x: e.clientX, y: e.clientY };
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!pan || !this.project.edl) return;
      const r = wrap.getBoundingClientRect();
      if (pan.ov != null) {
        this.updateOverlay(pan.ov, { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }, { quiet: true });
        return;
      }
      if (!this.project.edl?.style.reframe) return;
      const m = this.project.edl.style.reframe;
      this.setReframe({ px: m.px - (e.clientX - pan.x) / r.width / m.zoom, py: m.py - (e.clientY - pan.y) / r.height / m.zoom });
      pan = { x: e.clientX, y: e.clientY };
    });
    wrap.addEventListener('pointerup', () => (pan = null));
    wrap.addEventListener('wheel', (e) => {
      if (!this.project.edl) return;
      e.preventDefault();
      this.setReframe({ zoom: Math.min(4, Math.max(0.6, this.project.edl.style.reframe.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))) });
    }, { passive: false });
    wrap.addEventListener('dblclick', () => this.setReframe({ zoom: 1, px: 0, py: 0 }));

    this.preview.onTime = (t) => { this.drawAll(t); this.highlightWord(); };
    this.preview.onEnded = () => { $('playBtn').textContent = 'Play'; };

    document.addEventListener('keydown', (e) => {
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
      if (e.code === 'KeyK' && this.preview.playing) this.togglePlay();
      if (e.code === 'KeyS' && !e.metaKey && !e.ctrlKey) this.splitAt(t);
      if (e.code === 'KeyD' && !e.metaKey && !e.ctrlKey) this.duplicateClip(this.selectedClipIndex ?? tl.segmentAt(t));
      if (e.code === 'Escape') {
        if (this.razor) { this.razor = false; $('razorChip').classList.remove('on'); $('timeline').style.cursor = ''; }
        this.selectClip(null);
      }
      if ((e.code === 'Delete' || e.code === 'Backspace') && /BODY/.test(e.target.tagName)) this.deleteClipAt(this.selectedClipIndex ?? tl.segmentAt(t));
      if (e.code === 'KeyI') this.trimAtPlayhead('in');
      if (e.code === 'KeyO') this.trimAtPlayhead('out');
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
      if (language) this.status(`Language: ${langName(language)} — building edit…`);
      p.computeBaseKeeps();
      p.useGlm = false; p.glmResult = null; p.variants = null; p.activeVariant = 0;
      this.rebuild();
      if ($('glmKey').value.trim() && !opts.skipAutoRefine) {
        try { await this.agent.refine({ onStatus: (s) => this.status(s), getPrompt: () => $('glmPrompt').value }); this.rebuild(); }
        catch (e) { this.toast(`GLM refine skipped: ${e.message}`, 3600); }
      } else this.toast('Add a GLM key in Settings for AI-chosen cuts.');
      this.status(`Ready · ${p.words.length} words · ${this.keptSec().toFixed(1)}s · ${p.useGlm ? 'GLM' : 'local'}`);
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
  renderTranscript() {
    const p = this.project;
    const el = $('transcript');
    el.textContent = '';
    $('wordDetail').textContent = p.words ? 'click: cut/keep · dblclick: sentence · right-click: fix' : 'word-level timings appear after Analyze';
    if (!p.words) return;
    const fmt = (t) => { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(3).padStart(6, '0')}`; };
    const frag = document.createDocumentFragment();
    let clickTimer = 0;
    for (const w of p.words) {
      const sp = document.createElement('span');
      sp.className = 'w';
      sp.textContent = w.w;
      if (!this.wordKept(w)) sp.classList.add('cut');
      sp.onmouseenter = () => { $('wordDetail').textContent = `“${w.w}” · ${fmt(w.start)} → ${fmt(w.end)} · ${Math.round((w.end - w.start) * 1000)} ms · ${this.wordKept(w) ? 'kept' : 'cut'}`; };
      sp.onclick = () => { clearTimeout(clickTimer); clickTimer = setTimeout(() => this.toggleWord(w.i, [w.i]), 220); };
      sp.ondblclick = () => { clearTimeout(clickTimer); this.toggleSentence(w.i); };
      sp.oncontextmenu = (e) => { e.preventDefault(); this.editWord(sp, w.i); };
      frag.append(sp, document.createTextNode(' '));
    }
    el.appendChild(frag);
    this.renderTakeStacks(el);
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
    input.style.cssText = 'font:inherit;font-size:13px;width:80px;border:1px solid var(--clay);border-radius:4px;background:var(--bg)';
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
      add('👉', e.managerialVerdict, 'var(--clay)');
      if (e.scoreImpact) { const s = document.createElement('span'); s.textContent = e.scoreImpact; s.style.cssText = 'font-size:11px;color:var(--clay);font-weight:600'; item.appendChild(s); }
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
      fill.style.cssText = `height:100%;width:${v}%;background:var(--clay);transition:width .3s cubic-bezier(.16,1,.3,1)`;
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
