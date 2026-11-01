// Preview — plays the EDITED timeline with audio. Two hidden <video> elements
// on the A-roll blob URL, in strict parity with segments: element seg%2 plays
// segment seg (audio), the other is pre-seeked to segment seg+1 and, during a
// crossfade window, starts early MUTED so the renderer can blend both layers.
// The visible canvas is fed through the SAME drawFrame as the exporter.

import { timelineOf } from './Compositor.js';

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
      els.forEach((v) => v.remove()); brollEl.remove();
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
      const rate = s ? s.rate : 1;
      el.playbackRate = rate;
      el.preservesPitch = rate === 1;
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

      // b-roll slot (muted overlay source)
      const t = this.editedTime();
      const slot = (this.edl.broll || []).find((b) => t >= b.at && t < b.at + b.dur);
      if (slot && slot.src) {
        if (brollEl.src !== url(slot.src)) { brollEl.src = url(slot.src); brollEl.load(); }
        const want = (t - slot.at) + (slot.srcIn || 0);
        if (Math.abs(brollEl.currentTime - want) > 0.15) brollEl.currentTime = want;
        if (this.playing && brollEl.paused) brollEl.play().catch(() => {});
      } else if (!brollEl.paused) brollEl.pause();

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
