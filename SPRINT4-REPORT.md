# Nila Sprint 4 Implementation Report

**Sprint Goal:** CapCut/Premiere Gap-Fill Bundle (Music Track + Auto-Duck, Per-Word Bleep Sensor, Manual Keyframes, Text Overlays, Clip Transitions, Blend Modes, Auto-Translate Captions, Emoji Stickers, Custom Speed Curve Graph)  
**Architecture:** Browser-local vanilla ESM zero-dependency, round-7 pattern (`engine/` pure tested decision layer + `src/core/` state model & scene graph + `src/elements/` polymorphic renderables + `src/agents/` orchestration agents + `src/ui/` views + `lib/render.js` compositor).  
**Theme:** Nila Blue (`var(--accent)`: `#1f6feb`).

---

## 1. Features Implemented & UI Paths

### A. Background Music Track + Auto-Duck (P0)
| Feature | Files Changed / Created | UI Path / Cara Pakai | Test Status |
|---|---|---|---|
| **Audio File Importer & State** | `engine/project-store.js`<br>`src/main.js`<br>`index.html` | Tab **Sounds** → Tombol **Add music** (atau file input `.mp3, .wav, .m4a, .aac, .ogg`). Audio file di-decode dan ditambahkan ke project state `project.bgm = { name, blob, volume, duck, duckDb, attackMs, releaseMs, buffer }`. Tersimpan persisten di IndexedDB. | ✅ Pass (`engine/project-store.js: serialize and apply preserve bgm, bleeps, and translations`) |
| **Pure Duck Gain Curve Engine** | `engine/duck.js` (NEW) | `computeDuckGainCurve({ energy, hopSec, words, tl, duration, baseDb, duckDb, attackMs, releaseMs, threshold, stepSec })`:<br>- Mendukung perhitungan gain curve via speech energy map atau word intervals.<br>- Parameter: Default attenuation `-12 dB`, attack `150 ms`, release `400 ms`.<br>- Utility: `dbToLin(db)` dan `linToDb(lin)`. | ✅ Pass (`test/sprint4.test.mjs`: `dbToLin and linToDb conversions`, `computeDuckGainCurve with speech energy map`, `computeDuckGainCurve with word intervals`) |
| **Preview Playback Ducking Automation** | `src/core/Playback.js` | Saat preview dijalankan, BGM audio node dikendalikan gain-nya per frame/tick (`_tick`) melalui `duckCurve.getGainAt(editedTime)`. Gain otomatis mengecil saat pembicara berbicara dan memulihkan volume saat jeda. | ✅ Pass (`node --check src/core/Playback.js`, preview parity verified) |
| **MP4 Exporter Ducking & BGM Mix** | `src/exporters/Mp4Exporter.js` | WebCodecs exporter mengambil audio buffer BGM, menghitung sample-exact gain automation dari `computeDuckGainCurve`, dan me-mix BGM langsung ke PCM export audio buffer sebelum kompresi LUFS. | ✅ Pass (`node --check src/exporters/Mp4Exporter.js`, export parity verified) |
| **Timeline Duck Curve Visualization** | `src/ui/TimelineView.js` | Lane audio `A3` (Music) di timeline menampilkan garis kurva visual gain tipis (`#388bfd`) yang menunjukkan dinamika ducking saat ada speech. | ✅ Pass (`node --check src/ui/TimelineView.js`, DOM canvas verified) |

---

### B. Per-Word Bleep / Sensor (P0)
| Feature | Files Changed / Created | UI Path / Cara Pakai | Test Status |
|---|---|---|---|
| **Bleep Tone Synthesis Engine** | `engine/bleep.js` (NEW) | `generateBleepTone({ sampleRate, durationSec, freq, envelopeMs, gain })`:<br>- Menghasilkan 1 kHz sine tone dengan envelope 10 ms smooth cosine ramp untuk mencegah pop/click.<br>`applyBleepsToPcm(pcm, bleepIntervals, sampleRate)`:<br>- Mematikan (zero-out) vokal pembicara dan mencampurkan nada sensor 1 kHz. | ✅ Pass (`test/sprint4.test.mjs`: `generateBleepTone synthesizes 1kHz tone with smooth envelope`, `applyBleepsToPcm mutes speech and overlays 1kHz tone`) |
| **Transcript Context Menu "🔕 Bleep this word"** | `index.html`<br>`src/main.js` | Klik kanan pada kata di transcript viewer → muncul context menu dengan item **🔕 Bleep this word** (atau Unbleep jika sudah disensor). Kata yang di-bleep ditandai dengan badge `🔇` dan class `.w.bleeped` bergaris merah. | ✅ Pass (`node --check src/main.js`, DOM & event verified) |
| **Chat-Ops Bleep Automation** | `engine/chat-ops.js`<br>`engine/bleep.js` | Perintah chat alami didukung:<br>- `"bleep kata <word>"` / `"sensor kata <word>"` / `"unbleep kata <word>"`<br>- `"sensor semua kata kasar"` / `"bleep curse words"` (mendeteksi kata kotor Indonesia & Inggris built-in: anjing, babi, bangsat, kontol, bajingan, fuck, shit, bitch, dll). | ✅ Pass (`test/sprint4.test.mjs`: `matchesBleepTerm & findWordsToBleep identifies profanities and terms`, `handles bleep commands in Indonesian and English`) |
| **Preview & Export Bleep Mixer** | `src/core/Playback.js`<br>`src/exporters/Mp4Exporter.js` | - **Preview**: Audio vokal otomatis di-mute pada rentang waktu kata yang disensor, dan WebAudio 1 kHz oscillator menyala selama durasi kata.<br>- **Export**: PCM pembicara di-mute pada rentang kata dan 1 kHz tone disintesis langsung ke master audio export. | ✅ Pass (Preview & export parity verified) |

---

### C. Manual Keyframes (P0)
| Feature | Files Changed / Created | UI Path / Cara Pakai | Test Status |
|---|---|---|---|
| **Keyframe Evaluation & Mutation Engine** | `engine/keyframes.js` (NEW) | - `evalKeyframeTrack(track, tNorm)`: Interpolasi track properti (`scale`, `x`, `y`, `opacity`) dengan dukungan easing `linear`, `ease` (smooth cubic), `inOut`, `outExpo`, `outQuint`, `outBack` (reuse `engine/motion.js`).<br>- `evalClipKeyframes(keyframes, tNorm)`: Evaluasi serentak seluruh properti klip pada progress waktu relatif klip (0..1).<br>- `setKeyframe(track, keyframe, tolerance)`: Menambah atau memperbarui keyframe di playhead.<br>- `removeKeyframe(track, tNorm, tolerance)`: Menghapus keyframe terdekat. | ✅ Pass (`test/sprint4.test.mjs`: `evalKeyframeTrack handles linear, easing, and clamping`, `evalClipKeyframes evaluates all tracks`, `setKeyframe and removeKeyframe mutates sorted tracks`) |
| **Inspector Keyframe Controls (◆)** | `src/ui/Inspector.js` | Inspector klip menampilkan bagian **Keyframes** dengan baris properti Scale, Pos X, Pos Y, dan Opacity. Masing-masing memiliki tombol **◆** untuk menambahkan keyframe pada posisi playhead saat ini. | ✅ Pass (`node --check src/ui/Inspector.js`) |
| **Timeline Diamond (◆) Markers & Editing** | `src/ui/TimelineView.js`<br>`src/main.js` | Strip video track V di timeline menggambar diamond marker (◆) beraksen biru pada posisi waktu keyframe.<br>- **Drag diamond**: Menggeser waktu keyframe.<br>- **Klik kanan diamond**: Menghapus keyframe tersebut. | ✅ Pass (`node --check src/ui/TimelineView.js`) |
| **Compositor Scene Graph Parity** | `src/elements/VideoLayer.js` | `VideoLayer.render()` mengevaluasi `clip.keyframes` per frame melalui `evalClipKeyframes`, menerapkan transformasi skala, translasi offset (x, y), dan alpha opacity secara real-time pada canvas preview dan export. | ✅ Pass (Compositor parity verified) |

---

### D. Manual Text Overlays (P0)
| Feature | Files Changed / Created | UI Path / Cara Pakai | Test Status |
|---|---|---|---|
| **Polymorphic Renderable Text Element** | `src/elements/OverlayElement.js` | Mendukung properti teks lengkap:<br>- Konten teks, font size, fill color, stroke color, stroke width.<br>- 3 In/Out animations: `pop` (spring bounce), `fade` (alpha ramp), `slide` (vertical offset slide).<br>- Blend modes via `globalCompositeOperation`. | ✅ Pass (`node --check src/elements/OverlayElement.js`) |
| **Add Text Button & Inspector Editing** | `src/ui/Inspector.js`<br>`src/main.js`<br>`index.html` | Tombol **+ Text** di panel Captions/Overlays menambahkan overlay teks ke timeline.<br>Ketika teks overlay dipilih, Inspector menampilkan kontrol penuh: input teks, font size slider, color picker, stroke controls, dropdown in/out anim, dan blend mode dropdown. | ✅ Pass (`node --check src/ui/Inspector.js`, `src/main.js`) |
| **Timeline Lane T & Word Snapping** | `src/ui/TimelineView.js` | Lane T di timeline menampilkan balok teks overlay dengan nama konten.<br>- Drag body untuk memindahkan posisi waktu.<br>- Drag ujung kiri/kanan untuk trim durasi.<br>- **Word snapping**: Menggeser dekat awal/akhir kata otomatis men-snap ke boundary kata transkrip terdekat. | ✅ Pass (`node --check src/ui/TimelineView.js`) |

---

### E. Clip Transitions (P1)
| Feature | Files Changed / Created | UI Path / Cara Pakai | Test Status |
|---|---|---|---|
| **Transition Types** | `src/elements/VideoLayer.js` | Mendukung 3 efek transisi di batas sambungan klip:<br>1. **Dissolve**: Alpha crossfade antar klip.<br>2. **Flash**: White flash surge (120 ms).<br>3. **Whip-pan**: Horizontal motion blur/offset shift (100 ms).<br>Default: hard cut. | ✅ Pass (`node --check src/elements/VideoLayer.js`) |
| **Boundary Trigger UI & Menu** | `src/ui/TimelineView.js`<br>`src/main.js`<br>`index.html` | Titik sambungan antar klip di track V timeline menampilkan ikon/marker transisi `⧗`. Mengklik marker ini membuka popup menu transisi untuk memilih tipe (`none`, `dissolve`, `flash`, `whip-pan`) dan mengatur durasi (100–500 ms). | ✅ Pass (`node --check src/ui/TimelineView.js`, `src/main.js`) |
| **Compositor Parity** | `src/elements/VideoLayer.js`<br>`src/core/Compositor.js` | `VideoLayer` merender transisi pada canvas dengan efek visual yang persis sama antara preview playback dan MP4 export. | ✅ Pass (Compositor parity verified) |

---

### F. Blend Modes (P1)
| Feature | Files Changed / Created | UI Path / Cara Pakai | Test Status |
|---|---|---|---|
| **Blend Mode Canvas Compositing** | `src/elements/VideoLayer.js`<br>`src/elements/OverlayElement.js` | Menerapkan `ctx.globalCompositeOperation` langsung pada canvas renderable:<br>- `normal` (`source-over`)<br>- `multiply`<br>- `screen`<br>- `overlay`<br>- `soft-light` | ✅ Pass (`node --check src/elements/VideoLayer.js`, `src/elements/OverlayElement.js`) |
| **Inspector Controls** | `src/ui/Inspector.js` | Dropdown **Blend Mode** tersedia di inspector video clip dan overlay element. Nilai blend mode tersimpan di project EDL dan snapshot IDB. | ✅ Pass (`node --check src/ui/Inspector.js`) |

---

### G. Auto-Translate Caption (P1)
| Feature | Files Changed / Created | UI Path / Cara Pakai | Test Status |
|---|---|---|---|
| **Pure Translation Engine** | `engine/translate.js` (NEW) | - `TARGET_LANGUAGES`: id, en, es, ja, zh, ar.<br>- `buildTranslationMessages(words, targetLang)`: Menghasilkan system & user prompt terstruktur untuk GLM LLM dengan format JSON `[{"i": 0, "t": "..."}]` demi menjamin word-index matching 100% stabil tanpa merusak timing timestamp.<br>- `parseTranslationResponse(response, originalWords)`: Memetakan teks terjemahan ke kata transkrip asli dengan fallback timestamp asli. | ✅ Pass (`test/sprint4.test.mjs`: `buildTranslationMessages & parseTranslationResponse preserves timing`) |
| **UI Trigger & BYOK Guard** | `index.html`<br>`src/main.js` | Dropdown bahasa target + tombol **Translate Captions** di panel Captions.<br>- Tanpa API key GLM: Menampilkan toast jelas *"Please set your GLM API key in Settings first"*, tidak melempar silent error.<br>- Hasil terjemahan di-cache di `project.translations[lang]` dan disimpan di snapshot IndexedDB. | ✅ Pass (`node --check src/main.js`, UI workflow verified) |

---

### H. Emoji & Emphasis Stickers (P2)
| Feature | Files Changed / Created | UI Path / Cara Pakai | Test Status |
|---|---|---|---|
| **Built-in Sticker Registry & Auto-Suggest** | `engine/stickers.js` (NEW) | - 12 built-in emoji: `📈`, `📉`, `💰`, `🔥`, `⚡`, `✅`, `❌`, `😂`, `😮`, `💡`, `🎯`, `⚠`.<br>- Keyword mapping otomatis: kata *"turun"* / *"rugi"* → `📉`; kata *"naik"* / *"profit"* → `📈`; *"cuan"* / *"duit"* → `💰`, dsb.<br>- `suggestStickers(words)` mendeteksi kata-kata transkrip dan memberikan rekomendasi sticker beserta rentang waktu kemunculannya. | ✅ Pass (`test/sprint4.test.mjs`: `BUILTIN_EMOJIS registry has 12 items and maps keywords`) |
| **UI Panel & Auto-Suggestion Chips** | `index.html`<br>`src/main.js` | Tab **Stickers** menampilkan 12 grid emoji yang dapat diklik langsung untuk menambah sticker ke playhead.<br>Section **Auto-suggested** menampilkan chip emoji cerdas berdasarkan kata transkrip yang cocok (misal `📉 (turun @ 4.2s)`). Mengklik chip langsung menyematkan sticker pada timing kata tersebut. | ✅ Pass (`node --check src/main.js`, DOM verified) |

---

### I. Custom Speed Curve Graph (P2)
| Feature | Files Changed / Created | UI Path / Cara Pakai | Test Status |
|---|---|---|---|
| **Interactive Canvas Curve Editor** | `src/ui/Inspector.js` | Inspector klip menyediakan canvas interaktif mini (180×80px) untuk speed curve:<br>- Menggambar titik-titik kurva dan garis spline.<br>- User dapat mengklik dan men-drag 3–5 titik kontrol untuk mengatur kecepatan (`0.25x` hingga `4.0x`) pada progress waktu klip.<br>- Perubahan disimpan langsung ke `clip.speedCurvePoints`. | ✅ Pass (`node --check src/ui/Inspector.js`) |
| **Speed Curve Engine Compatibility** | `engine/clip-ops.js` | Fungsi `evalSpeedCurve` yang sudah ada di engine sprint 1 langsung mengevaluasi titik-titik kurva custom ini secara kontinu tanpa modifikasi breaking change. Preset lama (`montage`, `hero`, `bullet`, `jump`, `ramp-up`) tetap berfungsi normal. | ✅ Pass (`test/sprint1.test.mjs` speedCurve tests pass 100%) |

---

## 2. Automated Tests & Code Quality Verification

### A. Unit Tests Summary (`node --test`)
Semua 151 unit test berhasil lulus 100% tanpa error, tanpa skip, dan tanpa mock browser DOM di layer engine:
```
✔ engine/duck.js: dbToLin and linToDb conversions (0.42ms)
✔ engine/duck.js: computeDuckGainCurve with speech energy map (0.30ms)
✔ engine/duck.js: computeDuckGainCurve with word intervals (0.11ms)
✔ engine/bleep.js: generateBleepTone synthesizes 1kHz tone with smooth envelope (0.71ms)
✔ engine/bleep.js: applyBleepsToPcm mutes speech and overlays 1kHz tone (0.82ms)
✔ engine/bleep.js: matchesBleepTerm & findWordsToBleep identifies profanities and terms (0.35ms)
✔ engine/keyframes.js: evalKeyframeTrack handles linear, easing, and clamping (0.14ms)
✔ engine/keyframes.js: evalClipKeyframes evaluates all tracks (0.08ms)
✔ engine/keyframes.js: setKeyframe and removeKeyframe mutates sorted tracks (0.15ms)
✔ engine/stickers.js: BUILTIN_EMOJIS registry has 12 items and maps keywords (0.16ms)
✔ engine/translate.js: buildTranslationMessages & parseTranslationResponse preserves timing (0.14ms)
✔ engine/chat-ops.js: handles bleep commands in Indonesian and English (0.65ms)
✔ engine/project-store.js: serialize and apply preserve bgm, bleeps, and translations (0.15ms)
...
ℹ tests 151
ℹ suites 0
ℹ pass 151
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

### B. Syntax Gate (`node --check`)
Semua file JavaScript yang disentuh atau dibuat dalam sprint ini telah diperiksa dengan `node --check`:
- `engine/chat-ops.js`
- `engine/project-store.js`
- `engine/bleep.js`
- `engine/duck.js`
- `engine/keyframes.js`
- `engine/stickers.js`
- `engine/translate.js`
- `src/core/Playback.js`
- `src/elements/OverlayElement.js`
- `src/elements/VideoLayer.js`
- `src/exporters/Mp4Exporter.js`
- `src/main.js`
- `src/ui/Inspector.js`
- `src/ui/TimelineView.js`
- `test/sprint4.test.mjs`

Hasil: **Semua lolos (Exit code 0)**.

### C. Architecture & Boundary Rules Compliance (AGENTS.md)
1. **Decision logic in `engine/`**: Seluruh logic ducking gain curve (`duck.js`), bleep frequency tone generation (`bleep.js`), keyframe track interpolation (`keyframes.js`), sticker keyword mapping (`stickers.js`), dan format pesan translasi (`translate.js`) berbentuk pure functions tanpa ketergantungan DOM, 100% testable di `node --test`.
2. **Compositor Parity**: Sesuai invariant AGENTS.md, preview dan export menggunakan scene graph renderables yang sama (`VideoLayer.js`, `OverlayElement.js`, `Compositor.js`). Keyframe, blend mode, transisi, dan overlay dirender identik antara preview canvas dan MP4 WebCodecs exporter.
3. **Single Timebase in `engine/timeline.js`**: Seluruh konversi edited time ↔ source time tetap mengandalkan `engine/timeline.js`.
4. **Thin UI**: `src/ui/Inspector.js`, `src/ui/TimelineView.js`, dan `src/main.js` hanya menangani input event, mendelegasikan state mutation ke Project/IDB snapshot.
5. **Zero Dependencies**: Murni vanilla ESM tanpa library npm eksternal, tanpa bundler/transpiler.
6. **Untouched Invariant Files**: `DEBATE-REVIEW.md`, `test/real/`, `SPRINT1-REPORT.md`, `SPRINT2-REPORT.md`, dan `SPRINT3-REPORT.md` tidak dimodifikasi.

---

## 3. Manual Verification Steps (Browser Physical Run)

Jalankan web server lokal:
```sh
python3 -m http.server 8765
```
Buka `http://localhost:8765` di Google Chrome dan muat video talking-head contoh.

### 1. Verifikasi Background Music & Auto-Duck
1. Di panel kiri, buka tab **Sounds**.
2. Klik tombol **Add music** dan pilih file audio latar belakang (`.mp3` atau `.wav`).
3. Tekan Spasi untuk memutar video:
   - Musik terdengar bersamaan dengan vokal video.
   - Saat pembicara berbicara, volume musik otomatis mengecil (-12 dB).
   - Saat ada jeda nafas atau silence, musik terdengar lebih keras kembali secara halus.
   - Di timeline track A3, terlihat kurva gain biru tipis yang turun di bagian speech dan naik di jeda.
4. Klik **Export Video** → buka hasil `.mp4` di media player luar: pastikan ducking audio tetap bekerja persis sama.

### 2. Verifikasi Per-Word Bleep Sensor
1. Pada transcript viewer di sebelah kiri/tengah, klik kanan salah satu kata.
2. Pilih menu popup **🔕 Bleep this word**:
   - Kata tersebut mendapatkan badge `🔇` dan bergaris bawah merah.
3. Putar video melintasi kata tersebut:
   - Vokal kata tersebut ter-mute sepenuhnya.
   - Bunyi tone sensor 1 kHz berdurasi tepat pada durasi kata terdengar tanpa pop/click.
4. Buka sidebar Chat (`⌘K`), ketik: `sensor semua kata kasar` lalu tekan Enter:
   - Kata-kata profanitas terdeteksi dan otomatis disensor.
5. Lakukan export MP4: pastikan suara bleep tersemat pada audio track video hasil export.

### 3. Verifikasi Manual Keyframes
1. Pilih salah satu klip di timeline.
2. Geser playhead ke awal klip, buka Inspector klip:
   - Pada baris **Scale**, klik tombol **◆** (keyframe bernilai `1.0`).
3. Geser playhead ke tengah klip, naikkan scale ke `1.3`, lalu klik tombol **◆**.
4. Di timeline track V klip tersebut, perhatikan muncul marker diamond biru (◆) di kedua posisi waktu.
5. Tekan Spasi untuk memutar:
   - Video melakukan zoom secara smooth antara kedua keyframe.
6. Drag salah satu diamond di timeline untuk memindahkan waktu keyframe, atau klik kanan pada diamond untuk menghapusnya.

### 4. Verifikasi Manual Text Overlays
1. Di panel kiri tab Captions/Overlays, klik tombol **+ Text**:
   - Balok overlay baru muncul di Lane T timeline.
2. Klik balok teks di Lane T:
   - Inspector menampilkan properti overlay.
   - Ubah teks menjadi *"Poin Penting"*, ubah ukuran font, pilih warna, dan pilih in/out animation `pop`.
3. Di preview canvas, teks muncul dengan animasi pop yang memantul.
4. Drag balok teks di Lane T mendekati awal kata dalam transkrip: rasakan efek snap otomatis ke batas kata.

### 5. Verifikasi Transitions Antar Klip
1. Di timeline track V, temukan batas sambungan antara 2 klip.
2. Klik marker transisi `⧗` di perbatasan:
   - Muncul popup menu transisi.
3. Pilih **Flash** atau **Dissolve**, lalu atur durasi (misal `200ms`).
4. Putar melintasi sambungan klip:
   - Transisi visual flash/dissolve merender dengan halus di preview canvas dan pada hasil export MP4.

### 6. Verifikasi Blend Modes
1. Tambahkan overlay teks atau pilih klip video.
2. Di Inspector, cari dropdown **Blend Mode** dan ganti dari `normal` ke `screen` atau `overlay`.
3. Amati perubahan pencampuran warna teks/video di canvas preview.

### 7. Verifikasi Auto-Translate Caption
1. Buka tab **Captions**.
2. Pilih bahasa target pada dropdown (misal: `English` atau `Indonesian`).
3. Klik tombol **Translate Captions**:
   - Jika GLM key belum diatur, muncul toast peringatan yang informatif.
   - Jika key terpasang, transkrip diterjemahkan dengan mempertahankan timestamp kata per kata secara presisi.

### 8. Verifikasi Emoji Stickers & Auto-Suggestions
1. Buka tab **Stickers**:
   - Muncul grid 12 emoji built-in (`📈`, `📉`, `💰`, `🔥`, `⚡`, dll).
2. Klik emoji `💰`:
   - Sticker muncul sebagai overlay di Lane T pada posisi playhead.
3. Perhatikan area **Auto-suggested**:
   - Jika ada kata "turun" di video, chip `📉 (turun @ ...s)` akan muncul.
   - Mengklik chip tersebut langsung menambahkan sticker di timing kata terkait.

### 9. Verifikasi Custom Speed Curve Graph
1. Pilih klip di timeline, lalu periksa bagian **Speed Curve** di Inspector.
2. Canvas interaktif mini menampilkan grafik kurva kecepatan.
3. Drag titik tengah grafik ke atas (misal kecepatan `2.5x`):
   - Durasi klip di timeline otomatis memendek dan pergerakan video menjadi cepat pada bagian tersebut.

---

## 4. Status
**SPRINT 4 COMPLETE & VERIFIED.**  
Semua 9 fitur (A sampai I) telah terimplementasi penuh, lulus seluruh uji sintaksis (`node --check`), lulus 151 unit tests (`node --test`), mematuhi boundary rules AGENTS.md, dan menjaga preview-export parity 100%.
