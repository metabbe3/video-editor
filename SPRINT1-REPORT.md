# Nila Sprint 1 Implementation Report

**Sprint Goal:** CapCut basic features + P0 red-team debate persistence.  
**Architecture:** Vanilla ESM zero-dependency, no build step, round-7 pattern (`engine/` pure tested decision layer + `src/core/` state model & scene graph + `src/elements/` polymorphic renderables + `src/ui/` views).

---

## 1. Features Implemented & UI Paths

### A. P0 Red-Team Debat (EDL Persistence)

| Feature | Files Changed / Created | UI Path / Cara Pakai | Test Status |
|---|---|---|---|
| **1. EDL Persistence** | `engine/project-store.js`<br>`src/main.js`<br>`index.html` | Auto-save ke IndexedDB (`nila-projects`) tiap kali project berubah (debounce 1s). Saat me-reload atau memilih file A-roll yang sama (key: `nama:size`), banner top muncul: *"Saved edit found for [file] ([time]). Restore last edit? [Restore last edit] [Dismiss]"*. Klik tombol untuk restore trims, splits, overlays, settings, variants, dsb. secara instan. | ✅ Pass (`test/sprint1.test.mjs` mock IDB roundtrip) |

---

### B. Fitur Dasar CapCut yang Hilang

| Feature | Files Changed / Created | UI Path / Cara Pakai | Test Status |
|---|---|---|---|
| **2. Rotate / Flip** | `engine/clip-ops.js`<br>`src/ui/Inspector.js`<br>`src/elements/VideoLayer.js` | Pilih klip di Timeline → Inspector: klik tombol `↻ Rotate 90°` (siklus 0° → 90° → 180° → 270°) dan `⇄ Mirror H` (toggle flip horizontal). Dirender akurat di canvas preview dan WebCodecs MP4 export (`keep[i].rotate`, `keep[i].flipH`). | ✅ Pass (`nextRotate` unit test + `VideoLayer` parity) |
| **3. Color Adjust Sliders** | `engine/clip-ops.js`<br>`src/core/Compositor.js`<br>`src/core/Project.js`<br>`src/main.js`<br>`index.html` | Buka panel Effects / Looks (✨) → bagian **Color adjust**: slider Brightness (-100..100), Contrast (-100..100), Saturation (-100..100), Temperature (-100..100). Diterapkan global via `ctx.filter` + overlay pass warm/cool tint amber/blue, text/captions di-redraw di atasnya agar tetap tajam. | ✅ Pass (`buildAdjustFilter`, `applyTemperatureOverlay` unit test) |
| **4. Blur-Pad Background** | `src/elements/VideoLayer.js`<br>`src/core/Project.js`<br>`index.html` | Buka panel Settings (⚙️) → **Video fit**: pilih `Fit: blur-pad (blurred background)`. Video contained di depan, background full-frame diblur (`blur(36px) saturate(1.25)`). Mendukung juga opsi `Cover` dan `Contain`. | ✅ Pass (`VideoLayer` layout render test) |
| **5. Voiceover Record** | `src/main.js`<br>`src/ui/TimelineView.js`<br>`src/core/Playback.js`<br>`src/exporters/Mp4Exporter.js`<br>`index.html` | Di Timeline bar (bawah player) → klik `🎙️ Voiceover` → izinkan mic → rekam audio → klik `⏹ Stop VO`. Rekaman otomatis masuk ke timeline sebagai audio overlay di lane A2 (`🎙️ Voiceover`). Blok dapat di-drag horizontal untuk memposisikan waktu mulai. Audio diputar saat preview dan di-mix ke output program pada export MP4. | ✅ Pass (Timeline layout + timeline drag + audio mix) |
| **6. Audio Fade Handles** | `engine/clip-ops.js`<br>`src/ui/Inspector.js`<br>`src/core/Playback.js`<br>`src/exporters/Mp4Exporter.js` | Pilih klip di Timeline → Inspector: slider `Fade in (0-2000ms)` dan `Fade out (0-2000ms)`. Gain envelope linier diterapkan pada playback preview (per-frame dynamic volume) dan export (`assembleProgram` sample-exact gain multiplication). | ✅ Pass (`clipFadeGain` unit test) |
| **7. Speed Curves / Ramp** | `engine/clip-ops.js`<br>`engine/timeline.js`<br>`src/ui/Inspector.js`<br>`src/core/Playback.js`<br>`src/exporters/Mp4Exporter.js` | Pilih klip di Timeline → Inspector: baris **Curve** → pilih chip preset: `Off`, `Hero` (slow-mo di tengah), `Ramp In` (lambat ke cepat), `Ramp Out` (cepat ke lambat), `Montage` (flash cepat ke normal). Integrasi durasi eksak di `timeline.js`, resample dinamis per sampel di exporter, dan estimasi dinamis `playbackRate` di preview. | ✅ Pass (`evalSpeedCurve`, `speedCurveDuration` unit test) |
| **8. Free Crop (Arbitrary Rect)** | `engine/clip-ops.js`<br>`src/ui/Inspector.js`<br>`src/elements/VideoLayer.js`<br>`src/main.js` | Pilih klip di Timeline → Inspector: klik `📐 Crop` → drag mouse di canvas player untuk membentuk kotak crop arbitrer → klik `📐 Done crop` atau `✕ Reset crop`. Disimpan ke `keep[i].cropRect` (normalized `{x, y, w, h}`), dirender akurat di preview dan export. | ✅ Pass (`normalizeCropRect` unit test) |

---

### C. Polish

| Feature | Files Changed / Created | UI Path / Cara Pakai | Test Status |
|---|---|---|---|
| **9. Platform Export Presets** | `engine/clip-ops.js`<br>`src/main.js`<br>`index.html` | Buka panel Settings (⚙️) → dropdown **Platform export preset**: pilih salah satu dari `TikTok — 1080×1920@30`, `Shorts — 1080×1920@60`, `Reels — 1080×1920@30`, `Square 1:1 — 1080×1080@30`, `YouTube 16:9 — 1920×1080@30`. Satu klik otomatis mengonfigurasi orientasi, resolusi, fps, dan quality ladder factor. | ✅ Pass (`PLATFORM_EXPORT_PRESETS` unit test) |
| **10. Named Quality Labels** | `index.html` | Buka panel Settings (⚙️) → dropdown **Export quality**: opsi kini memiliki label informatif: `High (0.10 bpp)`, `Balanced (0.075 bpp)`, `Light (0.05 bpp)`. | ✅ Pass (DOM verified) |

---

## 2. Test & Syntax Verification

### A. Unit Tests (`node --test`)
- File test baru: `test/sprint1.test.mjs` (9 suite tes baru).
- Total test suite: **109 passing tests** (100 pass bawaan + 9 pass baru).
- Durasi: **~186ms**.
- Hasil: **100% PASS, 0 FAIL, 0 SKIPPED**.

### B. Syntax Check (`node --check`)
Semua file yang disentuh/dibuat diverifikasi bebas syntax error:
```sh
node --check engine/project-store.js
node --check engine/clip-ops.js
node --check engine/timeline.js
node --check src/core/Project.js
node --check src/core/Compositor.js
node --check src/core/Playback.js
node --check src/core/QaGate.js
node --check src/elements/VideoLayer.js
node --check src/ui/Inspector.js
node --check src/ui/TimelineView.js
node --check src/exporters/Mp4Exporter.js
node --check src/main.js
node --check test/sprint1.test.mjs
```
Status: **Semua lolos (exit code 0)**.

### C. Dependency Check
- Total npm dependency baru: **0** (tetap murni vanilla ESM zero-dependency).
- Tidak ada bundler atau build step yang ditambahkan.
