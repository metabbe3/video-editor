# How It Works — Analysis (2026-10-30)

Synthesis of a 12-agent research sweep (6 dimensions, adversarial verify pass) + a 14-finding
architecture red-team. Every number below is source-backed; confidence is labeled. These are the
rules this app encodes. Folklore that failed verification is called out.

---

## 1. How Claude's motion works

**There is no published Anthropic motion spec.** Verified: the only official guidance is
qualitative ("use non-user-triggered motion sparingly"; user-triggered motion should "show what
changed"; fade-and-slide-up entrances on every section "read as AI-generated"; respect
`prefers-reduced-motion") — from Anthropic's own frontend-design skill. Claude Desktop's base CSS
has `transition: all 0s` on `<html>`: animations are per-component, not global tokens.

**The look (extracted from shipped Claude Desktop CSS, high confidence):**

| Token | Light | Dark |
|---|---|---|
| bg | `#faf9f5` | `#262624` |
| text | `#29261b` | `#f5f4ef` |
| secondary text | `#737163` | `#a6a39a` |
| border (hairline, alpha olive) | `#706b5740` | `#6c6a6040` |
| accent clay | `#d97757` | `#d97757` |
| support tones | kraft `hsl(25 50% 66%)`, manilla `hsl(40 54% 83%)` | |

- Typography: Anthropic Sans / Serif / Mono are proprietary (BSPK). Free stand-ins per Anthropic's
  own brand skill: system sans + **Lora** serif accents. (Anthropic's brand skill itself warns the
  cream+serif+terracotta combo is now a cliché — we're the cliché, knowingly.)
- Flat surfaces separated by hairline borders, **not shadows**. Root 16px/24px, antialiased.

**Motion parameters (the best public reference sets, both high confidence):**
- Material 3 Expressive (2025): spatial springs ζ0.6/k800 = 420ms, ζ0.8/k380 = 475ms, ζ0.8/k200 =
  655ms settle; effects (opacity/color) **critically damped** ζ1: 149/230/326ms. Spatial may
  overshoot; effects never.
- Apple (WWDC23): bounce 0 = most versatile, 0.15 barely bouncy, 0.3 noticeable, >0.4 exaggerated.
  Perceptual duration < settle duration — don't wait for physics to finish.
- **Overshoot math (red-team corrected):** spring step overshoot % = 100·e^(−ζπ/√(1−ζ²)); pick
  ζ = −ln(PO)/√(π²+ln²(PO)). 10% overshoot (easeOutBack) = **ζ≈0.59** — not ζ0.7–0.8.
- Bezier equivalents (verified against easings.net data): easeOutExpo `cubic-bezier(0.16,1,0.3,1)`,
  easeOutBack `cubic-bezier(0.34,1.56,0.64,1)` (exactly 10% overshoot). A single cubic-bezier has
  ≤2 turning points = at most one overshoot/dip; multi-oscillation needs a sampled curve.
- **For baked video** (our case): rest-to-rest springs start with slope 0 (ease-in-out family), so
  easeOut beziers fit gesture handoffs, not rest-to-rest moves — sample a fixed-dt damped
  oscillator per frame instead (Remotion `spring({frame, fps, stiffness, damping, mass})` shape).

**What we encode:** UI = per-component springs (spatial ζ0.8/k380 ≈475ms, effects ζ1 ≈230ms),
Claude palette above, borders-not-shadows, `prefers-reduced-motion`. Video zoom punches = sampled
spring / easeOutExpo-family, 0.3–0.5s, overshoot on scale only.

---

## 2. How the cutting works

**Word timestamps (the "precise time and words" layer):**
- Only viable browser path: transformers.js v4 + `onnx-community/whisper-*_timestamped` ONNX models
  with `return_timestamps:'word'` (DTW over cross-attention, 20ms frame granularity).
  whisper.cpp/WASM word timestamps: broken, closed not-planned. Web Speech API: no timestamps,
  mic-only. GLM ASR (`glm-asr-2512`): 30s cap, wav/mp3 only, **no timestamps** — useless here.
- Error envelope: ±50–200ms (evals collar at 0.2s). Known bias: **word END timestamps run
  100–300ms early** (clips final consonants if trusted raw).
- Compensations (all source-backed): extend word ends ≤300ms but never into the next word; split
  inter-word pauses capped at 160ms (CrisperWhisper heuristic); drop sub-50ms spans (hallucination
  guard); snap boundaries to RMS-energy minima within ±200ms.
- Trick: Whisper `initial_prompt` stuffed with fillers ("Umm, so, uh, I was like, uhh...") so
  um/uh survive transcription at all (sprites.ai).
- Input must be **16kHz mono** — transformers.js assumes it; feeding 48k stereo corrupts the whole
  timebase. (Red-team #1.)
- **Language (verified in transformers.js source, 2026-10-31):** omitting `language` **silently
  forces English** — the docs' "auto-detected" claim is wrong (issue #302 open, PR #1541
  unreleased). Auto-detect is vendored (`lib/stt-worker.js`): one forward pass with only
  `<|startoftranscript|>` — the next predicted token IS the language token — mapped back via
  `generation_config.lang_to_id`; detect once on the first 30s, then pin (the chunked pipeline
  applies one generation_config to every chunk; mid-file switching is explicitly unhandled under
  word timestamps; CJK word segmentation depends on the pinned language). `language` accepts
  'french' | 'fr' | '<|fr|>' — and English-only models THROW if it's passed at all.

**Silence/dead-air detection (verified envelope, corrections from the verify pass):**
- Threshold: ~**−35 dBFS with per-file calibration** (midpoint room-tone↔speech). NOT −45 fixed —
  vendor docs converge on −42…−28 dBFS (TimeBolt recommends −30…−42; auto-editor default = −28).
- Hysteresis (separate enter/exit), min silence to cut **0.4–0.5s**, residual pause **~0.2s**,
  cut centered on the **energy minimum** of the pause.
- Pads: lead 0.01–0.09s, trail ≥0.15s (lead < trail — onsets are sharper than releases).
  Min keep segment 0.1s (aggressive, auto-editor) – 0.75s (conservative, TimeBolt).
- **Audio cuts stay sample-exact; only video snaps to the frame grid** (snapping audio "costs up
  to 20ms off a word" — sprites.ai).

**Joins:** 10–15ms linear **audio-only** fade at every join (kills clicks, inaudible). Video:
hard cut when removed span <1s (auto-editor rule); crossfade only for longer removals (we defer
video crossfades entirely — v1 is hard cuts, which is also the FYP look).

**Filler words:** um, uh, like, you know, basically, actually, sort of, kind of, right?, "I mean",
double-clutch repeats ("I-I"). Descript/Opus class tools detect as transcript words (~85–95%
claimed accuracy, unverified). Meaningful "like" ("tools like ffmpeg") must be kept — this is
exactly where LLM judgment beats keyword filters.

**LLM edit decisions (sprites.ai pattern + our inversion):**
- LLM emits **keep-ranges**, never timestamps, never raw cut-lists. A 20min→30s edit as cuts =
  150–400 ranges (truncation bait); as keep-ranges = ~10–20 ranges ≈ 1–2K tokens.
- Ours: GLM returns inclusive **word-index pairs** into a frozen words array (indices only — no
  timestamps in the prompt at all; removes a whole unit-confusion failure class). We map indices →
  times → snap → pad, then clamp/merge/validate. LLM JSON is never trusted: `json_object` mode has
  **no schema guarantee** in GLM (verified; no `json_schema` support), so schema lives in the
  system prompt and validation lives in code.

---

## 3. The FYP pattern (numbers, with honesty about which are real)

| Rule | Value | Confidence |
|---|---|---|
| Hook: content proposition | ≤3s (TikTok official) | **Official** |
| Hook prioritized | first 6s (TikTok official) | **Official** |
| Target length | 21–34s (highest completion ~62% vs ~48% for 60s+; WSJ-derived) | High-medium |
| Avg shot length | 2.59s (SHOT/CVPR23, 853 videos); TikTok ASL ≈ film 3–5s (SNAPlab) | High |
| Max pause | 3s (talking-head agency rule) | Medium |
| Framing change | every 20–30s talking-head; varied spacing, not a metronome | Medium |
| Zoom punch | 1.10× at thought-change cuts; 1.2–1.5× emphasis 1–3s; ≤1 per 3–4 cuts; **0.3–0.5s duration** | Medium |
| Slow push | 100→120% if static >20s | Medium |
| Captions | 1–3 word pops, 60–75px @1080×1920, ≤20% frame height, 2–4 words/line | Medium |
| Safe zone | Meta official: **14% top / 35% bottom / 6% sides** (~250/672/65px @1080×1920) | **Official** |
| B-roll | 3–7s, on noun mention, explains (not decorates) | Medium |
| Loudness | master **−14 LUFS** (BS.1770), voice peaks ≈−6dB | Medium-high |

**Refuted / unverifiable (do NOT hardcode):** "pattern interrupt every 3–5s" (marketing folklore —
no primary source; MrBeast's leaked doc prescribes minute-scale structure, no N-second metronome);
"3s retention >65% = strong", "4–7× impressions" (untraceable to any dataset); jump cuts "every
2–4 words" (conflation — that's a caption-chunking rule). All cadence knobs are **user-tunable
defaults** in this app, not constants.

---

## 4. Browser-local pipeline (all high confidence unless noted)

- **Ingest:** `<input webkitdirectory>` = baseline everywhere (Baseline 2025); `showDirectoryPicker`
  Chromium-only upgrade + IndexedDB handle persistence. Files are lazily-read disk-backed Blobs —
  `slice()`/stream, never whole-file reads. Serve from localhost (secure context), not file://.
- **Decode/mux: `mediabunny`** — the 2026 ecosystem standard (mp4-muxer deprecated; Remotion
  migrated to it and sponsors it). `VideoSampleSink.getSample(t)` = frame-accurate incl. VFR;
  `AudioBufferSink.buffers(start,end)` = ranged decode (whole-file `decodeAudioData` is a memory
  trap: 1h ≈ 1.38GB); `Output` + `Mp4OutputFormat` + `CanvasSource` + `AudioBufferSource` +
  `StreamTarget` = streaming export (BufferTarget would hold ~300MB in RAM for 5 min).
- **WebCodecs:** 95.5% of sessions. Codec of record H.264 `avc1.4d0034` (99.6% encode) + AAC
  `mp4a.40.2` (~92%; missing Firefox/Linux → `@mediabunny/aac-encoder` WASM polyfill or Opus
  fallback). 1080×1920@30: 5–8 Mbps, GOP 60 (2s), first frame keyframe, `latencyMode:'quality'`.
  Throughput 11fps (old netbook) → 200fps (M4). RGBA frame = 8.3MB — **throttle queue at >4**, not
  >20 (~166MB!). Fallback chain: MediaRecorder webm (realtime, no frame control) → ffmpeg.wasm
  (30MB, COOP/COEP — last resort).
- **Preview:** double-buffered hidden `<video>` pair on the A-roll blob URL — segment N plays
  natively (audio+video in sync for free; cuts land in silence so join error is inaudible) while
  element B pre-seeks to segment N+1's in-point. One seek per cut, hidden. Overlays (captions,
  punches) on canvas via rAF. `<video>` seeking is async/coarse — never build frame-accurate scrub
  on it (VideoSampleSink for that if needed).
- **Audio export math:** assemble PCM sample-exact → downmix mono → 12ms join fades → measure
  integrated LUFS (BS.1770 K-weighting = two biquads, coefficients published; no JS lib exists) →
  `gain = min(−14 − measured, −maxPeak − 0.1dBTP)` (peak-safe; mono-first so downmix can't shift
  the measurement).

---

## 5. GLM facts (verified 2026-10-30)

- **GLM-5.3 is real** (user's "GLM 5.3" ✓): 753B MoE flagship, 1M ctx, 128K max output, thinking
  **cannot be disabled** (use `reasoning_effort:"low"`), $1.40/$4.40 per Mtok.
- **`glm-5.3-flash`** = our default brain: multimodal (text/image/video in), 320B/18B-active,
  $0.15/$0.50 per Mtok — an EDL generation costs well under $0.01.
- **CORS verified live** (OPTIONS preflight on both `api.z.ai` and `open.bigmodel.cn`): browsers
  can call it directly, BYOK, no proxy. (Keys are still visible in client JS — fine for a local
  tool; proxy if this ever ships to other users.)
- Structured output = `json_object` **only** (no `json_schema` strict mode; `tool_choice` auto-only)
  → schema in system prompt + client validation, always.
- Rate limits are concurrency-based, not published — single-request EDL generation is unaffected.

---

## 6. Sources (primary)

Anthropic skills repo (frontend-design, brand-guidelines) · sander-muon/claude-desktop-bin (extracted CSS) ·
m3e.kyralabs.app + m3.material.io (motion tokens) · WWDC23-10158 · remotion.dev/docs/spring ·
easings.net (+ verified bezier data) · arXiv 2303.00747 (WhisperX), 2408.16589 (CrisperWhisper),
2304.06116 (SHOT dataset) · auto-editor.com/ref · help.timebolt.io · sprites.ai (Whisper+LLM pipeline) ·
descript/opus.pro help · MDN (webkitdirectory, WebCodecs codec selection, BS.1770) · caniuse/webcodecs ·
webcodecsfundamentals.org (2026 codec matrix, encoder practices) · github.com/Vanilagy/mediabunny ·
docs.z.ai (GLM-5.3, pricing, struct-output, chat API) · HF transformers.js docs + issue #820 ·
ads.tiktok.com creative best practices · Meta Ads Guide safe zone · simonwillison.net (MrBeast doc).

Full research JSON with per-claim confidence: session workflow `wf_5a05bcaf-273`.
