# Nila — flash-model AI video cuts

Browser-local video editor that cuts talking-head footage into a high-retention
vertical short. Drop one folder with your A-roll and B-roll; it transcribes on
your machine, removes filler words and dead air with precise (word-level,
energy-snapped) timestamps, adds FYP-pattern zoom punches and word-pop captions
in Claude's visual language, and exports MP4 — no server, no build step.

## Run

```sh
cd video-editor
python3 -m http.server 8765
open http://localhost:8765
```

(localhost is a secure context; `file://` won't get the directory picker.)

**Feature status vs CapCut/Premiere:** see [`FEATURES.md`](FEATURES.md) — the full gap
analysis with a value/effort roadmap.

## Use

1. **Folder** — pick the folder containing your A-roll (longest video is
   auto-selected) and any B-roll (videos/images). Click any video in the list
   to switch which file you're editing. Nothing is uploaded (words only; frames
   only with Vision context on).
2. **Analyze** — decodes audio locally, transcribes in a Worker with
   **language auto-detect** (detected once, pinned; explicit language
   selectable), windowed + cached in IndexedDB so a reload resumes. Then cuts:
   filler words, pauses, FYP punches, captions. **If a GLM key is set, the AI
   editor refines automatically before you see the result.**
   - **Short-form presets (Shorts / TikTok)**: the senior-editor persona returns
     **3-6 standalone clip variants** (chip row above the timeline — switching
     preserves your manual edits per variant), each with its own hook title and
     virality scores; Ask-AI can turn any of them into a cold-open edit
     (teaser from later in the video plays first).
   - **YouTube long-form preset**: assembly SOP — teaser cold open, chapters,
     suggested tangent cuts (yellow — approve/dismiss, never auto-applied), a
     Chapters panel with **Copy YouTube description** (`00:00 Title` lines).
   - Self-critique refinement loop (up to 3 passes), vision context (optional,
     consent-gated).
3. **Transcript (right)** — every word with millisecond timings. **Click a
   word to cut/restore it; double-click to cut its whole sentence;
   right-click to fix its text** (subtitle accuracy — timing and indices stay
   intact, so AI passes keep working). ⌘Z undoes. **Subtitles** can be turned
   off entirely in Settings (preview and export both honor it).
4. **Ask AI (top bar)** — type a command ("make it 15 seconds, cut the intro,
   open on the demo") and the editor revises the CURRENT cut with your
   feedback history — an iterate-with-the-AI loop, not a restart.
5. **Timeline (below)** — ruler / V (clips, B-roll, punches) / W (captions) /
   A (waveform). Drag clip edges to trim, `I`/`O` at the playhead, wheel
   scroll, ⌘-wheel zoom, JKL shuttle.
6. **Reframe** — face-aware 9:16 auto-crop (MediaPipe, smoothed camera path);
   drag the player to pan, wheel/slider to zoom, double-click to reset.
7. **Transitions** — joins that removed > 1s get a 120ms crossfade with a
   scale settle; short removals stay hard cuts.
8. **Video & export settings** — orientation (9:16 / 16:9 / 1:1), resolution
   (1080/720/480 short side), frame rate (24/30/60), export quality
   (bits/pixel/frame ladder), master volume. Everything (crop, captions,
   punches, canvas, encoder) follows the chosen frame.
9. **Export** — H.264 + AAC MP4, loudness-normalized to −14 LUFS.
   Audio sample-exact; crossfades included.

**Folder tab:** click any video in the file list to edit that file.

Space = play/pause · J/K/L shuttle · ←→ frame step · `S` split · `Del` delete
clip · `I`/`O` trim · ⌘Z/⌘⇧Z undo/redo.

### GLM settings

Settings (top-right): platform preset, API key, model (`glm-5.3-flash`
default), endpoint — z.ai standard, **z.ai coding plan**, or bigmodel.cn —
plus persistent edit instructions. Keys live only in this browser's
localStorage. **Privacy:** the word list always leaves your machine when you
refine; ~6 sampled video frames also leave it **only if** you turn on
"Vision context" (off by default). Everything else — audio, video, faces —
stays local.

Note on audio parity: the preview plays the source audio as-is; the export
adds a mastering chain (80 Hz high-pass → RMS-anchored compression → −14 LUFS
normalize), so exports sound slightly tighter than the preview.

## How it works

`ANALYSIS.md` is the full, source-backed write-up (how Claude's motion works,
cut-engine numbers, FYP grammar, pipeline choices). Architecture in one line
per module:

**Architecture (round 7 rewrite):** `engine/` = pure, tested decision layer
(moved verbatim from lib/) · `src/core/` = Project model + Compositor scene
graph + Playback + undo/redo · `src/elements/` = polymorphic renderables
(video layers, captions, MOGRTs, progress bar, safe zones) ·
`src/templates/captions/` = 5 subtitle strategies (Hormozi, Sliding Pill,
Frosted Glass, Kinetic Pop & Tilt, YouTube Clean) · `src/agents/` = GLM
EditorAgent (persona + variants + self-critique) · `src/exporters/` =
WebCodecs MP4 (+ optional procedural whoosh SFX on punches) · `src/ui/` =
timeline view + labels. Old flat ui.js/render.js/preview.js deleted.
- `engine/analyze.js` ranged audio decode → 16 kHz mono → RMS energy map
- `engine/stt-worker.js` + `engine/transcribe.js` + `engine/idb-cache.js` windowed
  Whisper word timestamps (worker, resumable per 60s window)
- `engine/edit-engine.js` pure cut logic: heuristics, GLM validation, FYP rules,
  transitions, BS.1770 loudness — all unit-tested (`node --test`)
- `engine/timeline.js` the one shared edited↔source timebase
- `engine/motion.js` closed-form springs — same curves in UI and baked video
- `lib/render.js` `drawFrame()` — the single compositor (crossfade layers) for
  preview AND export
- `src/ui/TimelineView.js` the multi-track NLE timeline (trim/scrub/zoom/waveform)
- `engine/reframe.js` + `engine/face-track.js` face-aware 9:16 auto-crop + manual
  zoom/pan (MediaPipe, sampled on kept clips)
- `src/core/Playback.js` parity double-buffered `<video>` player — edited audio free,
  crossfade pre-roll muted
- `engine/glm.js` BYOK GLM client (keep-ranges by word index, never timestamps)
- `src/exporters/Mp4Exporter.js` WebCodecs encode via mediabunny → MP4

## Tests

```sh
node --test          # engine, timeline, motion, loudness (26 tests)
```
