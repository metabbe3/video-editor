// Preview — plays the EDITED timeline with audio. Two hidden <video> elements
// on the A-roll blob URL, in strict parity with segments: element seg%2 plays
// segment seg (audio), the other is pre-seeked to segment seg+1 and, during a
// crossfade window, starts early MUTED so the renderer can blend both layers.
// The visible canvas is fed through the SAME drawFrame as the exporter.

import { timelineOf } from './Compositor.js';
import { evalSpeedCurve, clipFadeGain } from '../../engine/clip-ops.js';
import { computeDuckGainCurve } from '../../engine/duck.js';

/** resolve when the element has data and no pending seek (bounded wait). */
function settle(el) {
  if (el.readyState >= 1 && !el.seeking) return Promise.resolve();
  return new Promise((res) => {
    const done = () => { el.removeEventListener('loadeddata', done); el.removeEventListener('seeked', done); res(); };
    el.addEventListener('loadeddata', done, { once: true });
    el.addEventListener('seeked', done, { once: true });
    setTimeout(done, 1200);
  });
}

export function createPreview(canvas, getFile, compositor) {
  const ctx = canvas.getContext('2d');
  const urls = new Map();
  const url = (id) => {
    if (!urls.has(id)) urls.set(id, URL.createObjectURL(getFile(id)));
    return urls.get(id);
  };
  const mkVideo = () => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    return v;
  };
  const els = [mkVideo(), mkVideo()]; // els[seg % 2] owns segment seg
  const brollEl = mkVideo();
  const voEl = document.createElement('audio');
  const bgmEl = document.createElement('audio');

  let bleepAc = null;
  let bleepOsc = null;
  let bleepGain = null;

  function playBleepTone() {
    if (bleepOsc) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      bleepAc ??= new AC();
      if (bleepAc.state === 'suspended') bleepAc.resume();
      bleepOsc = bleepAc.createOscillator();
      bleepGain = bleepAc.createGain();
      bleepOsc.type = 'sine';
      bleepOsc.frequency.setValueAtTime(1000, bleepAc.currentTime);
      bleepGain.gain.setValueAtTime(0.3, bleepAc.currentTime);
      bleepOsc.connect(bleepGain);
      bleepGain.connect(bleepAc.destination);
      bleepOsc.start();
    } catch {}
  }

  function stopBleepTone() {
    if (bleepOsc) {
      try {
        bleepOsc.stop();
        bleepOsc.disconnect();
      } catch {}
      bleepOsc = null;
      bleepGain = null;
    }
  }

  const P = {
    edl: null, tl: null, seg: 0, playing: false, raf: 0, fadeIn: false,
    _freezeT0: null, _freezeLeft: 0,
    onTime: null, onEnded: null,

    get active() { return this.seg % 2; },
    el() { return els[this.active]; },

    setEdl(edl, { keepTime = true } = {}) {
      const prevT = keepTime && this.tl ? this.editedTime() : 0;
      const prevId = this.edl?.style?.arollId;
      this.edl = edl;
      this.tl = edl ? timelineOf(edl) : null;
      if (!edl) return;
      canvas.width = edl.style.w; canvas.height = edl.style.h;
      this._bind(els[0]); this._bind(els[1]);
      this.seg = 0; this.fadeIn = false; this._freezeT0 = null; this._freezeLeft = 0;
      els.forEach((v) => (v.muted = true));
      if (this.tl) {
        this.duckCurve = computeDuckGainCurve({
          words: edl.words || [],
          tl: this.tl,
          duration: this.tl.duration,
          baseDb: edl.bgm?.gainDb ?? 0,
          duckDb: edl.bgm?.duckDb ?? -12,
          attackMs: 150,
          releaseMs: 400,
        });
      }
      if (prevT > 0.02) this.seekTo(Math.min(prevT, this.tl.duration - 0.02));
      else this._park(0, els[this.active]), this._preload(1, els[1 - this.active]);
      this._draw();
    },
    editedTime() {
      if (!this.tl?.segments.length) return 0;
      const s = this.tl.segments[this.seg];
      if (!s) return this.tl.duration;
      const playLen = (s.out - s.in) / s.rate;
      if (this._freezeT0 != null) { // freeze tail: wall clock, pause-aware
        return this.tl.starts[this.seg] + playLen + Math.min((performance.now() - this._freezeT0) / 1000, s.freeze);
      }
      const cur = els[this.active].currentTime;
      // element currentTime is SOURCE time; element plays at playbackRate=rate,
      // so edited delta = source delta / rate (must mirror sourceToEdited)
      return this.tl.starts[this.seg] + Math.min(Math.max(cur - s.in, 0), s.out - s.in) / s.rate;
    },

    async play() {
      if (!this.tl?.segments.length) return;
      this.playing = true;
      const el = els[this.active];
      el.muted = false;
      await settle(el);
      if (!this.playing) return;
      const s = this.tl.segments[this.seg];
      if (s && el.currentTime < s.in - 0.02 && !el.seeking) el.currentTime = s.in;
      if (this._freezeLeft > 0 && s) this._freezeT0 = performance.now() - (s.freeze - this._freezeLeft) * 1000;
      else this._applyRate(el, s);
      try { await el.play(); } catch { this.playing = false; /* autoplay policy */ }
      const loop = () => {
        if (!this.playing) return;
        this._tick();
        this.raf = requestAnimationFrame(loop);
      };
      cancelAnimationFrame(this.raf);
      loop();
    },
    pause() {
      this.playing = false;
      cancelAnimationFrame(this.raf);
      els.forEach((v) => v.pause());
      brollEl.pause();
      voEl.pause();
      bgmEl.pause();
      stopBleepTone();
      if (this._freezeT0 != null) { // remember how much freeze is left
        const s = this.tl?.segments[this.seg];
        this._freezeLeft = Math.max(0, s.freeze - (performance.now() - this._freezeT0) / 1000);
        this._freezeT0 = null;
      }
    },
    seekTo(t) {
      if (!this.tl?.segments.length) return;
      t = Math.max(0, Math.min(t, this.tl.duration - 0.001));
      const m = this.tl.editedToSource(t);
      this.seg = m.seg;
      this.fadeIn = false;
      this._freezeT0 = null; this._freezeLeft = 0;
      els.forEach((v) => { v.pause(); v.muted = true; });
      const el = els[this.active];
      const s = this.tl.segments[this.seg];
      this._applyRate(el, s);
      this._park(this.seg, el);
      el.currentTime = m.src;
      if (m.frozen && s) { // seeked into a freeze tail: resume it from the right offset
        const into = t - (this.tl.starts[this.seg] + (s.out - s.in) / s.rate);
        this._freezeT0 = performance.now() - into * 1000;
      }
      this._preload(this.seg + 1, els[1 - this.active]);
      if (this.playing) this.play();
      else { el.muted = false; this._draw(); }
    },
    destroy() {
      this.pause();
      stopBleepTone();
      if (bleepAc) bleepAc.close().catch(() => {});
      els.forEach((v) => v.remove()); brollEl.remove(); voEl.remove(); bgmEl.remove();
      urls.forEach((u) => URL.revokeObjectURL(u));
    },
    redraw() { this._draw(); },
    setVolume(db) {
      const v = Math.min(1, Math.max(0, 10 ** (db / 20)));
      els.forEach((e) => (e.volume = v));
      this.volDb = db;
    },

    // -- internals --
    _bind(el) {
      const u = url(this.edl?.style?.arollId);
      if (el.src !== u) { el.src = u; el.load(); } // never reload an already-bound element
    },
    /** speed: video element rate; pitch NOT preserved so preview matches the
     *  export's naive linear resample (ponytail: windowed-sinc + preservesPitch
     *  together, if speech at 2x ever matters) */
    _applyRate(el, s) {
      if (!s) { el.playbackRate = 1; return; }
      if (s.speedCurve) {
        const prog = (s.out - s.in > 0) ? Math.max(0, Math.min(1, (el.currentTime - s.in) / (s.out - s.in))) : 0;
        const curRate = evalSpeedCurve(s.speedCurve, prog);
        el.playbackRate = Math.max(0.25, Math.min(4, curRate));
        el.preservesPitch = false;
      } else {
        const rate = s ? s.rate : 1;
        el.playbackRate = rate;
        el.preservesPitch = rate === 1;
      }
    },
    _park(i, el) { // position element at segment i's in-point (no play)
      const s = this.tl.segments[i];
      if (!s) return;
      if (!el.src) this._bind(el);
      this._applyRate(el, s);
      el.currentTime = s.in;
    },
    _preload(i, el) { this._park(i, el); },

    _tick() {
      if (!this.tl) return;
      const tl = this.tl;
      const s = tl.segments[this.seg];
      const el = els[this.active];
      if (!s) { this.pause(); this.onEnded?.(); return; }

      const trans = this._transBefore(s);
      const incoming = els[1 - this.active];
      // crossfade pre-start: incoming begins (muted) trans.ms before the join
      if (this._freezeT0 == null && trans && !this.fadeIn && (s.out - el.currentTime) / s.rate <= trans.ms / 1000 + 0.02) {
        this.fadeIn = true;
        const s2 = tl.segments[this.seg + 1];
        if (Math.abs(incoming.currentTime - s2.in) > 0.05) incoming.currentTime = s2.in;
        this._applyRate(incoming, s2);
        incoming.play().catch(() => {});
      }
      const swap = () => {
        this.seg++;
        this.fadeIn = false;
        this._freezeT0 = null; this._freezeLeft = 0;
        const s2 = tl.segments[this.seg];
        if (!s2) { this.pause(); this._draw(); this.onEnded?.(); return; }
        els.forEach((v, k) => (v.muted = k !== this.active));
        const now = els[this.active];
        this._applyRate(now, s2);
        if (Math.abs(now.currentTime - s2.in) > 0.08 && !this.fadeIn) now.currentTime = s2.in;
        if (this.playing) now.play().catch(() => {});
        els[1 - this.active].pause();
        this._preload(this.seg + 1, els[1 - this.active]);
      };
      if (this._freezeT0 != null) {
        // holding the OUT frame; advance on wall clock
        if ((performance.now() - this._freezeT0) / 1000 >= s.freeze) swap();
      } else if (el.currentTime >= s.out - 0.005 || el.ended) {
        if (s.freeze > 0) { // enter freeze tail: park on the out frame, muted
          el.pause(); el.muted = true; el.currentTime = s.out;
          this._freezeT0 = performance.now();
        } else swap(); // segment finished (incoming already rolling if crossfading)
      } else if (!el.seeking && el.currentTime < s.in - 0.02) {
        el.currentTime = s.in; // seek regression nudge
      }

      if (s.speedCurve) {
        this._applyRate(el, s);
      }

      // Apply fade envelope to playback volume:
      const k = this.edl?.keep?.[this.seg];
      const baseVol = Math.min(1, Math.max(0, 10 ** ((this.volDb || 0) / 20)));
      if (k && (k.fadeIn || k.fadeOut)) {
        const playLen = (s.out - s.in) / s.rate;
        const localT = Math.max(0, (el.currentTime - s.in) / s.rate);
        const fadeG = clipFadeGain(localT, playLen, (k.fadeIn || 0) / 1000, (k.fadeOut || 0) / 1000);
        el.volume = baseVol * fadeG;
      } else {
        el.volume = baseVol;
      }

      // b-roll slot (muted overlay source)
      const t = this.editedTime();

      // Per-word bleep censor check at edited time t:
      const isBleeped = (this.edl.words || []).some((w) => {
        if (!w.bleep) return false;
        const ws = tl.sourceToEdited(w.start);
        const we = tl.sourceToEdited(w.end);
        return ws != null && we != null && t >= ws && t <= we;
      });

      if (isBleeped) {
        el.volume = 0; // Mute speech during bleeped word
        if (this.playing) playBleepTone();
      } else {
        stopBleepTone();
      }

      const slot = (this.edl.broll || []).find((b) => t >= b.at && t < b.at + b.dur);
      if (slot && slot.src) {
        if (brollEl.src !== url(slot.src)) { brollEl.src = url(slot.src); brollEl.load(); }
        const want = (t - slot.at) + (slot.srcIn || 0);
        if (Math.abs(brollEl.currentTime - want) > 0.15) brollEl.currentTime = want;
        if (this.playing && brollEl.paused) brollEl.play().catch(() => {});
      } else if (!brollEl.paused) brollEl.pause();

      // audio overlay slot (voiceover)
      const ao = (this.edl.audioOverlays || []).find((a) => t >= a.at && t < a.at + a.dur && !a.isMusic);
      if (ao && ao.src) {
        if (voEl.src !== url(ao.src)) { voEl.src = url(ao.src); voEl.load(); }
        const want = t - ao.at;
        if (Math.abs(voEl.currentTime - want) > 0.15) voEl.currentTime = want;
        voEl.volume = Math.min(1, Math.max(0, (ao.volume ?? 1) * baseVol));
        if (this.playing && voEl.paused) voEl.play().catch(() => {});
      } else if (!voEl.paused) {
        voEl.pause();
      }

      // Background music track + auto-duck
      const bgm = this.edl.bgm || (this.edl.audioOverlays || []).find((a) => a.isMusic);
      if (bgm && bgm.src) {
        if (bgmEl.src !== url(bgm.src)) { bgmEl.src = url(bgm.src); bgmEl.loop = true; bgmEl.load(); }
        const want = (t - (bgm.at || 0)) % (bgmEl.duration || 3600);
        if (want >= 0 && Math.abs(bgmEl.currentTime - want) > 0.25) bgmEl.currentTime = want;
        const duckGain = (bgm.autoDuck !== false && this.duckCurve) ? this.duckCurve.getGainAt(t) : 1.0;
        const userVol = bgm.volume ?? (10 ** ((bgm.gainDb ?? -20) / 20));
        bgmEl.volume = Math.max(0, Math.min(1, userVol * duckGain * baseVol));
        if (this.playing && bgmEl.paused) bgmEl.play().catch(() => {});
      } else if (!bgmEl.paused) {
        bgmEl.pause();
      }

      this._draw();
      this.onTime?.(t);
    },
    /** the transition (if any) whose join ends this segment (speed/freeze aware — matches transitionsFor's cum) */
    _transBefore(s) {
      const at = this.tl.starts[this.seg] + s.dur;
      return (this.edl.transitions || []).find((q) => Math.abs(q.at - at) < 1e-6) || null;
    },

    _draw() {
      if (!this.edl) return;
      const assets = {
        arollId: this.edl.style.arollId,
        frame: (srcId, srcTime) => {
          if (srcId !== this.edl.style.arollId) return brollEl;
          const i = this.tl.segmentIndexAtSource(srcTime);
          return els[i == null ? this.active : i % 2];
        },
      };
      compositor.renderFrame(ctx, this.editedTime(), this.edl, assets);
      this.overlay?.(ctx, this.edl.style.w, this.edl.style.h); // preview-only guides
    },
  };
  return P;
}
