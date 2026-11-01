# Feature Gap Analysis — vs CapCut (basic) & Premiere/Descript (advanced)

From the 2026-10-31 research sweep (CapCut/InShot/VN/Canva inventories + Premiere/DaVinci/
Descript/Vizard/Runway + platform export specs), checked against what this app ships today.

Legend: ✅ shipped · 🟡 partial · ❌ missing · feasibility in-browser (easy/moderate/hard)

## Timeline & clips

| Feature | Status | Notes |
|---|---|---|
| Split at playhead (`S`) | ✅ | |
| Delete + magnetic ripple (`Del`) | ✅ | keep[] is gapless by construction |
| Trim head/tail (drag edges, `I`/`O`) | ✅ | anchored drags, min-length guards |
| Undo / redo (⌘Z / ⌘⇧Z) | ✅ | 50-deep snapshots |
| Duplicate clip (`D`) | ✅ | Round 14 |
| Drag-reorder clips | ✅ | Round 14 (repaired the dead vdrag branch) |
| Freeze frame | ✅ | end-freeze per clip (`keep[i].freeze`, ❄ in Inspector) |
| Speed change | ✅ | uniform per-clip 0.25–4× (`keep[i].speed`); preview `playbackRate` + `preservesPitch=false` matches export's linear resample |
| Speed curves / ramp | ❌ moderate | the signature "CapCut look" — future `keep[i].speedCurve` |
| Reverse clip | ❌ hard | cheap UI, expensive render |
| Nesting / compound clips | ❌ easy | data-model `group` |

## Frame, ratio, reframe

| Feature | Status | Notes |
|---|---|---|
| Aspect/orientation (9:16 / 16:9 / 1:1) | ✅ | Settings → Orientation; canvas, crop, captions all follow |
| Resolution (1080 / 720 / 480 short side) | ✅ | |
| Face-aware auto-reframe | ✅ | beyond CapCut (MediaPipe track, smoothed) |
| Manual zoom/pan reframe | ✅ | drag player, wheel/slider, dblclick reset |
| Zoom punches (auto keyframe-lite) | ✅ | FYP grammar |
| Crop (free) | 🟡 | cover-crop + pan/zoom covers most; no arbitrary rect |
| Rotate / flip (mirror) | ❌ easy | sideways-phone fix + face-cam mirror |
| Blur-pad canvas background | ❌ easy | portrait-in-landscape alternative to cover-crop |

## Text & captions

| Feature | Status | Notes |
|---|---|---|
| Auto-captions (word-pop, safe-zone) | ✅ | retention feature #1 |
| Caption editing via transcript | ✅ | click word = cut/keep; dblclick = sentence |
| AI hook title overlay | ✅ | GLM-written, spring entrance |
| Manual text tool (styles) | ✅ | Round 14: title/subtitle/pop presets, Text panel, drag on player, editable list |
| Text animations (in/out/loop) | 🟡 | pop-in exists; full animation sets missing |
| Stickers / emoji / GIF | ✅ | Round 14: emoji grid + shapes (rect/ellipse/star), drag on player |

## Audio

| Feature | Status | Notes |
|---|---|---|
| Loudness normalize (−14 LUFS, peak-safe) | ✅ | |
| Master volume (preview + export) | ✅ | −12…+6 dB |
| Join micro-fades (anti-click) | ✅ | automatic |
| Silence/filler removal | ✅ | the core |
| Audio fade handles | 🟡 | auto at joins; no manual curves |
| Volume keyframes (ducking) | ❌ moderate | auto-duck vs voice is the real ask |
| Extract/detach audio | ❌ moderate | keep sound while replacing visuals |
| Sound library | 🟡 | procedural SFX presets (whoosh/pop/riser/impact/click/ting) with audition + pin at playhead; no external library yet |
| Voiceover record | ❌ easy | MediaRecorder — narration is core to tutorials |

## Looks

| Feature | Status | Notes |
|---|---|---|
| Transitions (crossfade + scale settle) | ✅ | auto-scheduled at >1s removals, speed/freeze-aware joins |
| Filters / LUT presets | ✅ | crisp/warm/punch + external .cube (global polish) |
| Adjust sliders (brightness/contrast/sat) | ❌ easy | `ctx.filter` |
| Per-clip effect stack | ✅ | Round 14: blur + vignette via registry (`src/effects/clipfx.js`); glitch deferred |
| Chroma key | ❌ moderate | WebGL shader |
| Mask / split-screen | ✅ | Round 14: rect/ellipse/cinematic-bars/split masks with feather + invert (Inspector) |
| Preview guides (safe/grid/platform UI) | ✅ | Round 14: preview-only via `preview.overlay` (never exported) |

## AI (2026 table stakes per research — our differentiator)

| Feature | Status |
|---|---|
| Transcript-first editing | ✅ (the Descript pattern) |
| Filler/silence removal | ✅ |
| AI keep/hook selection + platform presets | ✅ |
| Self-critique refinement loop | ✅ |
| Ask-AI command bar w/ feedback memory | ✅ |
| Language auto-detect transcription | ✅ |
| Multicam | ❌ hard |
| Generative edits | ❌ impossible (server GPU) |

## Export

| Feature | Status |
|---|---|
| Resolution / fps / quality ladder (bits/pixel/frame 0.10/0.075/0.05) | ✅ |
| Orientation-aware MP4 (avc + aac, faststart) | ✅ verified 1280×720 + 1080×1920 |
| LUFS-normalized sample-exact audio | ✅ |
| Codec choice (HEVC/AV1 opt-in) | 🟡 avc only (99.6% support; AV1 = opt-in later) |
| Platform presets (exact TikTok/Shorts ladders) | 🟡 quality factor matches the verified envelope; named presets TBD |
| One-way FCPXML/EDL export (round-trip to pro NLEs) | ❌ moderate — escape hatch, not a feature |
| SRT caption export | ✅ | Round 14: `engine/srt.js`, Captions panel (import deferred) |

## Roadmap order (value ÷ effort for a browser-local AI editor)

1. **Next (easy, high value):** ~~duplicate `D`, drag-reorder, filter presets, manual text tool,
   stickers~~ (✅ Round 14) → remaining: color adjust sliders, blur-pad background, rotate/flip, voiceover record
2. **Then (moderate):** speed change, freeze frame, volume keyframes/auto-duck, stickers,
   audio fade handles, extract audio, named platform export presets
3. **Later (hard/low ROI here):** PiP layers, effects, chroma, mask, nesting, multicam,
   AV1/HEVC opt-in, FCPXML export
