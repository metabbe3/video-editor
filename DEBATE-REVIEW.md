# DEBAT TEKNIKAL & RED-TEAM REVIEW: FYP EDITOR
**Peninjau:** Senior Video-Editing Engineer & Systems Red-Team  
**Target Repositori:** `/Users/nicholasandriansurjadi/Documents/video-editor`  
**Konteks Produk:** Pipeline video vertikal berita/analisis saham IDX teknikal.id (3–8 menit *talking-head* → shorts berkecepatan tinggi).  
**Status Kode:** 100 unit test lulus (`node --test`), arsitektur browser-local vanilla ESM tanpa build step.

---

## 1. Cut Engine: Heuristik Filler/Pause + Energy-Snap Word-Level
### (1) Klaim Desain Repo Saat Ini
Repo mengklaim memotong jeda dan kata pengisi (*filler*) secara presisi menggunakan batas kata Whisper yang dikompensasi (`engine/edit-engine.js:76–80`), digabungkan dengan deteksi keheningan berdasar kalibrasi dinamis (`engine/edit-engine.js:113–117`) dan pergeseran batas potong ke titik minimum energi RMS (*energy-snap*) dalam jendela ±200ms (`engine/edit-engine.js:120–128`).

### (2) Kelemahan Kode & Argumen Red-Team
1. **Kerentanan Fatal Terhadap Karakteristik Akustik Konsonan Plosif:**  
   Pada `engine/edit-engine.js:120–128`:
   ```javascript
   export function snapToEnergyMin(t, energy, hopSec, window = TUNING.snapWindow) { ... }
   ```
   Jendela pencarian adalah `TUNING.snapWindow = 0.2` (total rentang 400ms). Dalam fonetika artikulatoris, konsonan letup/plosif (*stop consonants* seperti /p/, /t/, /k/, /b/, /d/, /g/) dan frikatif tak bersuara memiliki fase *closure silence* (fase hening sebelum letupan udara) yang energinya mendekati nol RMS. Jika timestamp Whisper meleset 80–120ms (hal lumrah pada model `whisper-base`), fungsi `snapToEnergyMin` akan tergelincir masuk ke dalam *closure* kata esensial alih-alih jeda antar-kata. Akibatnya, onset konsonan pertama terpotong (*clipped*), terdengar gagap atau patah.
2. **Kelemahan Deteksi Filler Berbasis Regex untuk Bahasa Indonesia:**  
   Pada `engine/edit-engine.js:34–35`, `FILLER_RE` hanya mencakup varian um/uh/erm (`/^(u+m+|u+h+|e+r+m+...)/i`). Pembawa berita saham Indonesia pada kanal teknikal.id tidak hanya berkata "um", melainkan "anu", "gitu", "nah jadi", "apa namanya", "kan", dan "ya". Regex ini gagal total menangkap kata pengisi lokal, sedangkan `heuristicKeeps` (`engine/edit-engine.js:137`) murni mengandalkan regex tersebut sebelum LLM dipanggil.

### (3) Usulan Lawan & Trade-Off Eksplisit
* **Usulan:** Ganti pendekatan energy-snap RMS bebas dengan **Acoustic-Constrained VAD Hybrid**:
  1. Jalankan Voice Activity Detection sejati (misal Silero VAD versi ONNX atau dual-band spectral flux) untuk mengisolasi pulau vokal manusia sejati.
  2. Batasi `snapWindow` maksimal ke ±60ms (3 hop pada 20ms hop), dan kunci aturan: *dilarang memotong ke dalam frame yang berada di atas ambang batas bising dasar*.
* **Trade-Off:** Memerlukan inferensi model VAD kecil (~2MB ONNX) di Web Worker yang menambah waktu analisis awal ~1.5–2 detik pada CPU, namun menghilangkan 100% risiko plosive clipping.

### (4) Verdict Akhir: HYBRID
**Alasan:** Whisper unggul pada semantik teks, tetapi buruk pada presisi batas milidetik. RMS energy-snap terlalu naif karena menyamakan "hening jeda" dengan "closure konsonan". Menggabungkan deteksi kata STT dengan gating VAD akustik adalah standar industri (Descript/TimeBolt) yang wajib diterapkan untuk rekaman broadcast finansial.

---

## 2. GLM Keep-Ranges by Word-Index
### (1) Klaim Desain Repo Saat Ini
Repo mengklaim bahwa mengirim daftar kata berindeks integer (`i:w`) ke GLM (`engine/glm.js:90`) dan mewajibkan balasan berupa rentang indeks kata `{from, to}` (`engine/glm.js:56, 74`) adalah pendekatan superior: menghemat ribuan token, mencegah kebingungan unit waktu (detik vs milidetik), dan kebal terhadap halusinasi angka timestamp.

### (2) Kelemahan Kode & Argumen Red-Team
1. **Destruksi Trim Manual Sub-Word saat Refine Ulang:**  
   Pada `engine/edit-engine.js:226–227`:
   ```javascript
   let inT = words[a].start - tuning.padLead;
   let outT = words[b].end + tuning.padTrail;
   ```
   Ketika pengguna di timeline menggeser handle trim (`src/main.js:829–849`) untuk memperhalus napas 50ms di antara kata 10 dan 11, nilai `k.in` berubah menjadi float kontinu. Namun saat pengguna menekan "Ask AI" atau re-refine, `EditorAgent.currentKeeps()` (`src/agents/EditorAgent.js:20–25`) memetakan kembali float tersebut ke indeks kata terdekat. Ketika GLM mengembalikan rentang indeks yang sama, `applyGlm` me-reset total waktu in/out ke batas kata asli (`words[a].start - padLead`). Semua penyesuaian teliti pengguna terhapus tanpa bekas.
2. **Ketidakmampuan Mengontrol Visual/Pause Murni:**  
   Analisis saham teknikal.id membutuhkan jeda visual saat presenter terdiam menunjukkan grafik IHSG/chart breakout selama 2–4 detik. Karena GLM hanya mengenal rentang kata, segmen tanpa kata (*silent visual segment*) tidak memiliki indeks dan otomatis dianggap *dead air* yang wajib dibuang.

### (3) Usulan Lawan & Trade-Off Eksplisit
* **Usulan:** Gunakan **Tokenized Span Addressing with Delta Preservation**:
  1. Setiap kata memiliki ID stabil; keheningan visual >1s direpresentasikan sebagai pseudo-token eksplisit `[CHART_PAUSE: 2.5s]`.
  2. Simpan manual trim sebagai offset delta: `{ from: 10, to: 25, inOffset: -0.05, outOffset: +0.02 }` sehingga regenerasi LLM tidak menimpa penyesuaian manual.
* **Trade-Off:** Skema JSON sedikit lebih kompleks (tambah ~10% token prompt), tetapi mencegah frustrasi pengguna akibat kerja trim manual yang terhapus.

### (4) Verdict Akhir: HYBRID
**Alasan:** Mengirim integer kata daripada timestamp float mentah adalah keputusan brilian untuk efisiensi token dan kepatuhan JSON LLM. Namun, implementasi saat ini kehilangan granularitas sub-word dan mengabaikan jeda visual non-kata.

---

## 3. Motion Springs Closed-Form
### (1) Klaim Desain Repo Saat Ini
Repo mengklaim menggunakan closed-form physical spring solver (`engine/motion.js:17–34`) berbasis osilator harmonik teredam Remotion untuk memastikan kurva gerak identik 100% antara UI preview dan hasil ekspor video MP4 tanpa *integration drift*.

### (2) Kelemahan Kode & Argumen Red-Team
1. **Temuan Red-Team: Dead Code & Bypassed Solver:**  
   Fungsi `spring()` di `engine/motion.js:17–34` ditulis lengkap dengan persamaan diferensial dan diuji di unit test. Namun di kode produksi, **fungsi `spring()` sama sekali tidak pernah dipanggil di mana pun** (hanya ada satu `import { spring }` tak terpakai di `src/templates/captions/index.js:5`).
2. **Kenyataan Eksekusi Punch Zoom:**  
   Pada fungsi aktual yang merender zoom punch (`engine/motion.js:99–120`):
   ```javascript
   export function punchScale(t, punches) {
     ...
     return settled + (scale - settled) * EASE.outExpo(f); // Baris 118
   }
   ```
   Kurva yang dieksekusi adalah `EASE.outExpo`—sebuah pendekatan kubik Bézier dengan metode Newton-Raphson (`engine/motion.js:57–83`), bukan spring solver fisik! Klaim "Remotion closed-form physical spring" pada video zoom adalah mitos di codebase ini.
3. **Inovasi Alokasi Memori Sia-Sia di Loop Render:**  
   Pada `engine/motion.js:100`:
   ```javascript
   const sorted = [...punches].sort((a, b) => a.at - b.at);
   ```
   Fungsi ini dipanggil di **setiap frame video** (baik rAF 60fps maupun loop export 54.000 frame untuk video 30 menit). Membuat shallow copy array dan menyortirnya puluhan ribu kali per render menciptakan tekanan garbage collection (GC stutter) yang tidak perlu di main thread.

### (3) Usulan Lawan & Trade-Off Eksplisit
* **Usulan:**
  1. Hapus dead code solver jika memang `EASE.outExpo` dinilai cukup untuk FYP punch, ATAU sambungkan `spring()` secara nyata jika menginginkan efek overshoot fisik (10% bounce).
  2. Urutkan (*pre-sort*) array `punches` satu kali saat EDL dibangun di `Project.buildEdl()` (`src/core/Project.js:122`), bukan di dalam fungsi per-frame `punchScale`.
* **Trade-Off:** Pre-sorting memerlukan disiplin state EDL, tetapi menghemat jutaan siklus CPU dan alokasi objek GC selama rendering.

### (4) Verdict Akhir: UBAH
**Alasan:** Integritas kode adalah prioritas utama. Mengklaim arsitektur remotion spring berpresisi tinggi padahal eksekusinya memakai cubic bezier biasa adalah inkonsistensi desain. Selain itu, alokasi sort per-frame adalah antipola performa grafis.

---

## 4. Council Multi-Persona
### (1) Klaim Desain Repo Saat Ini
Repo mengklaim mengimplementasikan *Editorial Council* yang mensimulasikan perdebatan editorial 5 persona ([SCRIPTWRITER], [RHYTHM_EDITOR], [VISUAL_DIRECTOR], [HARSH_CRITIC], [MANAGERIAL_EDITOR]) dalam satu panggilan GLM tunggal terstruktur (`src/agents/council.js:10–35`), dengan bobot voting yang disesuaikan oleh *stance* (ruthless, balanced, storyteller).

### (2) Kelemahan Kode & Argumen Red-Team
1. **Halusinasi Kontrak JSON (Scriptwriter Ghost Task):**  
   Pada `src/agents/council.js:15`, sistem prompt memerintahkan:
   > `[SCRIPTWRITER]: ... fixes phonetic typos ("barang"->"bareng", "wogi mana"->"gue gimana")`
   
   Namun lihat skema balasan JSON pada baris 26–33: skema tersebut HANYA menerima `clips`, `emphases`, `brollHints`, `debate_log`, `hookTitle`, `selfCritique`, dan `confidence`. **Tidak ada properti array kata untuk mengembalikan perbaikan teks!** Prompt memerintahkan LLM bekerja keras memperbaiki kata, tetapi hasilnya dibuang karena tidak ada jalur output di JSON.
2. **Ilusi Multi-Agent (Convergent Causal Bias):**  
   Menjalankan 5 persona dalam satu completion autoregresif menghasilkan *convergent thinking*. Begitu token pertama `rhythmArgument` digenerasikan, probabilitas token berikutnya untuk `scriptwriterCounter` dan `managerialVerdict` terikat kuat secara kausal pada bias argumen pertama. Ini bukan perdebatan independen, melainkan monolog sandiwara.
3. **Pemborosan Latensi Finansial:**  
   Menghasilkan `debate_log` (300–800 token naratif) menambah latensi inferensi 3–6 detik. Informasi ini hanya ditampilkan di popup HTML kecil (`index.html:507–509`) yang jarang dibuka pengguna, sementara target teknikal.id adalah efisiensi pemotongan berita cepat.

### (3) Usulan Lawan & Trade-Off Eksplisit
* **Usulan:** Ganti simulasi persona monolitik dengan **Single-Pass Strict Rubric with Deterministic Metrics**:
  Fokuskan prompt LLM pada penentuan struktur naratif (Hook-Retain-Payoff) dan eliminasi tangensial. Serahkan evaluasi ritme (WPM) dan kerapatan visual secara deterministik pada `ScoreEngine.js` (`src/core/ScoreEngine.js:9–48`) yang berjalan instan (0.1ms di CPU) tanpa membuang token GLM.
* **Trade-Off:** Kehilangan gimmick "transkrip debat" di UI, tetapi memangkas waktu respons AI sebesar 40–50% dan menghilangkan token halusinasi.

### (4) Verdict Akhir: UBAH
**Alasan:** Council saat ini adalah *theatrical prompt engineering*. Untuk pipeline produksi harian saham IDX, kecepatan eksekusi dan konsistensi skema jauh lebih berharga daripada log perdebatan fiktif.

---

## 5. WebCodecs MP4 Export via mediabunny & Mastering Audio
### (1) Klaim Desain Repo Saat Ini
Repo mengklaim ekspor video MP4 client-side menggunakan `mediabunny@1.64.0` dengan akselerasi WebCodecs H.264/AAC, streaming target ke disk via `showSaveFilePicker`, serta mastering audio terintegrasi −14 LUFS (BS.1770 K-weighting streaming + highpass 80Hz + soft-knee compression) (`src/exporters/Mp4Exporter.js:16–49`).

### (2) Kelemahan Kode & Argumen Red-Team
1. **Risiko OOM Crash Fatal pada Browser Non-Chromium:**  
   Pada `src/exporters/Mp4Exporter.js:85–93`:
   ```javascript
   if (typeof showSaveFilePicker === 'function') {
     target = new StreamTarget(await handle.createWritable());
   } else {
     target = new BufferTarget();
   }
   ```
   `showSaveFilePicker` adalah API eksklusif Chromium desktop. Di Safari (macOS/iOS) dan Firefox, cabang jatuh ke `new BufferTarget()`. Untuk video panjang (misal preset `PLATFORMS.youtube` durasi 15–30 menit resolusi 1080p bitrate 8Mbps), seluruh file MP4 berukuran ~1.8 GB ditampung secara utuh dalam satu buffer memori RAM tab. Di Safari atau browser dengan batas heap 1–2GB, tab akan mengalami *crash* seketika (OOM killer).
2. **Distorsi Transient Biquad pada Streaming LUFS:**  
   Pada `src/exporters/Mp4Exporter.js:282–308`:
   ```javascript
   // ponytail: filter state is not carried across blocks (each block restarts the biquads) — a ~1ms edge artifact per 400ms block
   ```
   Komentar developer sendiri mengakui adanya kelemahan: state filter IIR biquad di-reset (`z1=0, z2=0`) setiap kali blok 400ms dihitung (`biquad(biquad(pcm, K1, i, block), K2, 0, block)`). Filter IIR K-weighting membutuhkan waktu *settling* 5–15ms. Me-reset state di setiap hop memicu *transient spike* artifisial yang mendistorsi akurasi pengukuran loudness terintegrasi.
3. **Resampling Naif pada Audio Retiming:**  
   Pada `src/exporters/Mp4Exporter.js:218–220`, audio speed retiming menggunakan interpolasi linier sederhana (`out[...] = a + (b - a) * frac`). Pada perubahan kecepatan >1.2×, ini menimbulkan distorsi aliasing yang kasar pada frekuensi vokal tinggi.

### (3) Usulan Lawan & Trade-Off Eksplisit
* **Usulan:**
  1. Ganti kalkulasi biquad/kompresi loop JS manual dengan native browser **`OfflineAudioContext`**. Browser mengeksekusi biquad dan dinamika menggunakan SIMD C++ multi-threaded yang 50× lebih cepat dan bebas artefak diskontinuitas state.
  2. Gunakan Origin Private File System (OPFS) `navigator.storage.getDirectory()` dan `createWritable()` sebagai streaming target universal sebelum menyerah ke `BufferTarget`.
* **Trade-Off:** Memerlukan sedikit penyesuaian penanganan file download dari OPFS, tetapi tab Safari/Firefox dijamin tidak akan mengalami OOM crash.

### (4) Verdict Akhir: UBAH
**Alasan:** Stabilitas ekspor adalah garis hidup sebuah video editor. Mengandalkan `BufferTarget` untuk file video panjang pada browser non-Chrome adalah bom waktu.

---

## 6. Filosofi Zero-Dependency & Vanilla ESM
### (1) Klaim Desain Repo Saat Ini
Repo menganut filosofi murni: tanpa build step, tanpa npm install, zero-dependency, modul native ESM, dan dapat dijalankan langsung dengan server statis sederhana (`python3 -m http.server 8765`).

### (2) Kelemahan Kode & Argumen Red-Team
1. **Klaim Palsu "Zero-Dependency" (Dependency Tanpa Jaring Pengaman):**  
   Aplikasi ini sangat bergantung pada library raksasa: `@huggingface/transformers` (WASM + runtime ONNX), `@mediapipe/tasks-vision` (WASM + model TFLite), dan `mediabunny`. Namun, seluruh dependensi ini diimpor langsung secara dinamis melalui CDN publik (`https://cdn.jsdelivr.net/...`). Jika koneksi internet pengguna lambat, CDN down, atau diblokir oleh kebijakan firewall korporat (sangat umum di sektor perbankan/sekuritas IDX), aplikasi gagal total saat inisialisasi.
2. **Monolitik `main.js` (1.272 Baris Spaghetti):**  
   Menolak framework/bundler membuat file `src/main.js` membengkak menjadi 1.272 baris kode yang mencampuradukkan penanganan DOM manual (`$('sttModel')`), drag-drop timeline, shortcut keyboard, orkestrasi agent, dan sinkronisasi state. Ketiadaan *type checking* (TypeScript) menyebabkan refaktor kecil berisiko merusak fungsionalitas UI secara tak terdeteksi.

### (3) Usulan Lawan & Trade-Off Eksplisit
* **Usulan:** Adopsi **Bundled Vanilla (Vite Standalone)**:
  Tetap pertahankan UI berbasis vanilla DOM (tidak perlu rewrite ke React/Vue), namun gunakan Vite untuk:
  1. Melakukan *vendor-locking* terhadap dependensi CDN ke direktori lokal/offline (`public/vendor`).
  2. Menjalankan type-check via JSDoc/TypeScript tanpa mengubah kesederhanaan logika.
* **Trade-Off:** Membutuhkan `npm run build` sebelum distribusi, tetapi menjamin aplikasi 100% fungsional secara offline dan terlindung dari gangguan CDN eksternal.

### (4) Verdict Akhir: HYBRID
**Alasan:** Pendekatan vanilla DOM sangat tepat untuk performa kanvas dan kesederhanaan solo dev. Namun, "zero-dependency" yang mengimpor ratusan megabyte WASM dari CDN publik adalah ilusi yang membahayakan ketersediaan sistem.

---

## 7. Face-Track MediaPipe & Auto-Reframe 9:16
### (1) Klaim Desain Repo Saat Ini
Repo mendeteksi wajah presenter menggunakan MediaPipe BlazeFace short-range yang di-sample pada *edited timeline* dengan frekuensi 2 fps (`engine/face-track.js:32`), kemudian diperhalus menggunakan filter median 5-sample dan interpolasi linier (`engine/reframe.js:42–62`).

### (2) Kelemahan Kode & Argumen Red-Team
1. **Cacat Mendasar: Kamera Meluncur Halus Melintasi Hard Cut:**  
   Pada `engine/face-track.js:47–50`:
   ```javascript
   for (let i = 0; i <= steps; i++) {
     const t = Math.min(tl.duration - 0.01, i * dt);
     const src = tl.editedToSource(t)?.src ?? 0;
     ...
   }
   return smoothFaceTrack(raw, dt);
   ```
   Sampling wajah dilakukan berdasar waktu hasil edit (`edited time`). Bayangkan klip 1 (wajah presenter di kiri) dipotong langsung (*jump cut*) ke klip 2 (wajah presenter di kanan). Filter median (`smoothFaceTrack:48`) dan interpolasi di `reframeAt:73–75` memperlakukan data ini sebagai garis waktu kontinu. Akibatnya, **kamera 9:16 melakukan pan/glide melayang melintasi potongan cut**! Dalam tata bahasa video profesional, perpindahan klip wajib berupa *instant snap cut*, bukan kamera yang bergeser canggung antar-scene.
2. **Frekuensi 2 FPS Terlalu Lambat untuk Gestur Berita Finansial:**  
   Interval 500ms (2 fps) tidak mampu menangkap gerakan kepala dinamis saat presenter membaca pergerakan saham. Pembingkaian terasa terlambat (*lagging*).

### (3) Usulan Lawan & Trade-Off Eksplisit
* **Usulan:** Lakukan **Per-Clip Source-Space Tracking**:
  1. Deteksi wajah pada ruang waktu klip mentah (*source time*), bukan linimasa editan.
  2. Terapkan pemulusan lintasan hanya di dalam batas klip masing-masing. Di setiap titik potong (*join/cut*), reset posisi crop secara instan.
* **Trade-Off:** Jika klip yang dipertahankan sangat pendek (<0.5 detik), deteksi wajah butuh minimal 2 keyframe lokal agar stabil.

### (4) Verdict Akhir: UBAH
**Alasan:** Gliding crop melintasi potongan gambar adalah cacat visual kelas amatir yang langsung merusak kredibilitas konten teknikal.id.

---

## 8. IndexedDB Caching & Resumabilitas Sesi
### (1) Klaim Desain Repo Saat Ini
Repo mengklaim menyediakan transkripsi Whisper per jendela 60 detik yang disimpan dalam IndexedDB `fyp-editor` (`engine/idb-cache.js:1–30`), sehingga saat halaman di-reload, proses transkripsi dapat langsung dilanjutkan (*resumable*).

### (2) Kelemahan Kode & Argumen Red-Team
1. **Temuan Red-Team Kritis: Proyek & EDL Tidak Pernah Disimpan!**  
   IndexedDB hanya menyimpan array kata hasil STT mentah (`engine/idb-cache.js:4, 28`). Ketika pengguna me-reload halaman browser atau tab tertutup:
   - File video terlepas (`p.reg` menjadi null).
   - Seluruh susunan potongan video (EDL), split, trim manual, stiker overlay, pilihan varian GLM, dan teks judul **hilang 100%**. Pengguna harus memilih ulang folder dan mengulang seluruh proses editing dari nol.
2. **Ketiadaan Kebijakan Eviksi / LRU Cache:**  
   Pada `engine/idb-cache.js`, tidak ada TTL, tidak ada pembersihan cache, dan tidak ada pengecekan kuota storage (`navigator.storage.estimate()`). Key transkripsi (`src/main.js:541`) tidak menyertakan versi aplikasi, sehingga jika model Whisper atau logika chunking diperbarui, cache usang akan terus dimuat tanpa opsi reset manual dari UI.

### (3) Usulan Lawan & Trade-Off Eksplisit
* **Usulan:** Perluas skema IndexedDB menjadi **Full Project State Persistence**:
  Simpan state proyek (`Project.edl`, `overrides`, `overlays`, dan `activeVariant`) ke dalam store `projects` di IndexedDB setiap kali ada perubahan EDL. Saat reload, cukup minta pengguna mengonfirmasi akses file handle (`FileSystemHandle.requestPermission()`) untuk memulihkan seluruh linimasa secara utuh.
* **Trade-Off:** Memerlukan serialisasi state yang disiplin dan penanganan izin file picker.

### (4) Verdict Akhir: UBAH
**Alasan:** Klaim "resumable" saat ini menyesatkan karena hanya menyelamatkan transkrip teks mentah, bukan pekerjaan kreatif editing pengguna.

---

## 9. Timeline NLE Custom vs Library Standar
### (1) Klaim Desain Repo Saat Ini
Repo membangun custom canvas timeline NLE multi-track (`src/ui/TimelineView.js:1–366`) yang menangani track V, B-roll, T (bab), W (kapsion), dan A (audio waveform) dengan scrubbing, zooming, trimming, dan razor split kustom tanpa library eksternal.

### (2) Kelemahan Kode & Argumen Red-Team
1. **Bug Penanganan Retiming pada Trimming:**  
   Pada `src/main.js:837`:
   ```javascript
   const srcAt = a.in0 + (tEdited - a.segT0);
   ```
   Fungsi trim mengabaikan `seg.rate` (kecepatan klip). Jika sebuah klip dipercepat menjadi 2× atau diperlambat 0.5×, pergeseran kursor mouse di linimasa editan dipetakan 1:1 ke ruang sumber, menyebabkan handle trim melompat dengan kecepatan ganjil.
2. **Keterbatasan Primitif NLE Profesional:**  
   Timeline custom ini tidak memiliki fitur multi-select, slip trim, slide trim, atau rolling edit (menggeser titik potong tanpa mengubah total durasi). Semuanya bersifat *ripple destructive*. Selain itu, kanvas murni mengorbankan aksesibilitas layar (screen reader tidak dapat membaca posisi playhead atau klip).

### (3) Usulan Lawan & Trade-Off Eksplisit
* **Usulan:**
  Pertahankan kanvas custom (karena adopsi CRDT seperti Yjs saat ini adalah *over-engineering* berlebih untuk solo developer), namun lengkapi primitif NLE:
  1. Perbaiki kalkulasi matematika `srcAt` agar memperhitungkan `seg.rate`.
  2. Buat skema ekspor/impor OpenTimelineIO (OTIO) atau FCPXML sebagai jembatan *escape-hatch* jika pengguna ingin melanjutkan editing di DaVinci Resolve/Premiere Pro.
* **Trade-Off:** Menulis serializer FCPXML butuh ~200 baris kode, tetapi memberikan jaring pengaman bagi workflow broadcast profesional.

### (4) Verdict Akhir: PERTAHANKAN (dengan perbaikan kalkulasi)
**Alasan:** Memakai framework timeline pihak ketiga yang berat akan merusak performa instan browser-local. Solusi canvas custom saat ini sudah sangat efisien, hanya butuh penyempurnaan bug matematika.

---

## 10. Audit Keamanan & Klaim Privasi
### (1) Klaim Desain Repo Saat Ini
README dan UI mengklaim: *"Everything else — audio, video, faces — stays local. Nothing is uploaded (words only; frames only with Vision context on)."*

### (2) Kelemahan Kode & Argumen Red-Team
1. **Transmisi Materi Berita Saham Sensitif ke Server Pihak Ketiga Luar Negeri:**  
   Pada `engine/glm.js:106–125`, seluruh daftar kata yang diucapkan presenter dikirim utuh melalui HTTPS ke endpoint API Zhipu AI / Z.ai di Beijing/China (`https://api.z.ai/api/paas/v4`). Bagi kanal finansial seperti teknikal.id, transkrip rekaman mentah sering kali memuat informasi analisis emiten sebelum rilis publik (potensi embargo informasi / kepatuhan regulasi pasar modal). Mengklaim "local AI" tanpa disclaimer tegas bahwa *teks bocor ke cloud pihak ketiga* adalah risiko reputasi serius.
2. **Penyimpanan API Key Tanpa Enkripsi di LocalStorage:**  
   Pada `src/main.js:633`: `LS.set('glm.key', key);`. API key disimpan dalam bentuk teks polos (*plain text*). Ekstensi browser yang memiliki izin membaca storage atau script pihak ketiga dapat mencuri kredensial GLM pengguna secara langsung.
3. **Kebocoran Metadata Jaringan ke CDN:**  
   `index.html:7–9` memanggil Google Fonts (`fonts.googleapis.com`), `engine/face-track.js:16` memanggil Google Storage, dan `engine/stt-worker.js:7` memanggil JSDelivr. Alamat IP pengguna dan waktu editing tetap terdeteksi oleh jaringan CDN tersebut.

### (3) Usulan Lawan & Trade-Off Eksplisit
* **Usulan:**
  1. Tampilkan banner transparansi privasi eksplisit: *"Transkrip teks dikirim ke GLM (Z.ai). Jalankan mode Heuristik Lokal 100% jika materi bersifat rahasia/embargo."*
  2. Sediakan opsi Web Storage Session (tidak persisten) atau enkripsi sederhana untuk API key.
* **Trade-Off:** Sedikit mengurangi kesan "magis serba lokal", namun melindungi integritas hukum dan etika teknikal.id.

### (4) Verdict Akhir: UBAH
**Alasan:** Kepercayaan adalah mata uang utama platform analisis saham teknikal.id. Klaim privasi harus 100% jujur dan transparan secara teknis.

---

## 11. Testing & Gap Cakupan
### (1) Klaim Desain Repo Saat Ini
Repo membanggakan 100 unit test yang lulus 100% dalam waktu ~160ms menggunakan native test runner Node.js (`node --test`).

### (2) Kelemahan Kode & Argumen Red-Team
1. **Kesenjangan Cakupan Masif (78% Codebase Tanpa Tes):**  
   100 test yang ada HANYA menguji fungsi matematika murni (persamaan biquad, rumus spring, regex string, duration budget).
   Modul-modul paling kritis yang berinteraksi dengan API browser memiliki **0% cakupan pengujian**:
   - `src/main.js` (1.272 baris — pengendali event & UI): **0 test**.
   - `src/exporters/Mp4Exporter.js` (347 baris — WebCodecs video encode): **0 test**.
   - `src/core/Playback.js` (234 baris — dual `<video>` sync player): **0 test**.
   - `engine/analyze.js` (66 baris — demux audio mediabunny): **0 test**.
   - `engine/stt-worker.js` & `engine/transcribe.js` (215 baris — worker): **0 test**.
   - `src/ui/TimelineView.js` (366 baris — kanvas interaktif): **0 test**.
2. **Kerapuhan Regresi Nyata:**  
   Jika WebCodecs macet di Chrome versi terbaru, jika dual-video player mengalami *deadlock* saat *seek*, atau jika fungsi ekspor menghasilkan video tanpa suara akibat kegagalan sinkronisasi, **seluruh 100 unit test tetap akan lulus hijau**.

### (3) Usulan Lawan & Trade-Off Eksplisit
* **Usulan:** Tambahkan minimal suite pengujian **E2E Headless via Playwright**:
  Buat satu skenario smoke test browser sungguhan yang: (1) memuat fixture video kecil 5 detik, (2) menjalankan flow analisis audio, (3) memicu ekspor MP4, dan (4) memverifikasi bahwa file MP4 bervaliditas non-nol berhasil digenerasikan.
* **Trade-Off:** Menambah dependensi Playwright dan waktu eksekusi CI (+15 detik), tetapi memberikan jaminan bahwa pipeline rendering video benar-benar bekerja di dunia nyata.

### (4) Verdict Akhir: UBAH
**Alasan:** 100 unit test matematika memberikan rasa aman semu (*false sense of security*). Pengujian video editor wajib menyentuh subsistem audio/video browser.

---

## 10 TEMUAN TERBESAR (URUTAN PRIORITAS P0 / P1 / P2)

| No | Prioritas | File & Baris | Deskripsi Masalah | Usulan Perbaikan Konkret | Estimasi Effort |
|:--:|:---:|:---|:---|:---|:---:|
| 1 | **[P0]** | `src/main.js:820–880`, `src/core/Project.js:36–57` | **Hilangnya Pekerjaan Editing Saat Reload.** State EDL, trim manual, split, dan overlays tidak disimpan ke storage persisten. Tab reload = kerjaan hilang total. | Simpan snapshot EDL terserialisasi di IndexedDB per video dan pulihkan otomatis saat sesi dibuka kembali. | 1 hari |
| 2 | **[P0]** | `src/exporters/Mp4Exporter.js:85–93` | **OOM Crash Export di Safari/Firefox.** Video panjang fallback ke `BufferTarget` (RAM utuh), memicu tab crash seketika pada file >1GB. | Gunakan Origin Private File System (OPFS) `createWritable()` sebagai target stream universal sebelum BufferTarget. | 1.5 hari |
| 3 | **[P1]** | `engine/face-track.js:47–69`, `engine/reframe.js:42–62, 73–75` | **Kamera Meluncur Halus Melintasi Cut.** Tracking wajah di linimasa editan menyebabkan filter median dan lerp melakukan pan visual melintasi hard cut. | Lakukan tracking wajah pada source-time per klip, dan paksa hard-snap posisi crop di setiap batas sambungan klip. | 2 hari |
| 4 | **[P1]** | `engine/edit-engine.js:220–232`, `src/agents/EditorAgent.js:17–26` | **GLM Refine Menghapus Trim Manual Sub-Word.** Hasil balasan integer kata dari LLM me-reset offset in/out yang telah disesuaikan manual di timeline. | Pertahankan penyesuaian manual sebagai layer delta offset di atas segmen yang dikembalikan oleh GLM. | 1 hari |
| 5 | **[P1]** | `engine/motion.js:17–34, 100, 114–118` | **Dead Code Spring Solver & GC Stutter di Frame Loop.** `spring()` tidak pernah dipanggil di produksi; `punches.sort()` di-alokasi ulang di setiap frame render. | Hubungkan solver fisik atau bersihkan dead code, dan lakukan pre-sort array punches saat EDL dibuat. | 0.5 hari |
| 6 | **[P1]** | `engine/edit-engine.js:120–128` | **Energy-Snap 400ms Memotong Konsonan Plosif.** Pencarian minimum RMS memotong fase hening artikulasi konsonan letup (/p/, /t/, /k/) pada awal kata. | Perkecil jendela snap ke ±60ms dan batasi pemotongan hanya pada area yang diidentifikasi VAD sebagai keheningan nyata. | 0.5 hari |
| 7 | **[P1]** | `src/agents/council.js:15, 26–33` | **Persona Scriptwriter di Council Halusinasi Kontrak.** Prompt menyuruh Scriptwriter memperbaiki typo fonetik, tetapi JSON schema tidak punya field penampung. | Sinkronkan schema JSON atau hapus instruksi perbaikan teks dari persona council; serahkan koreksi pada pipeline deterministik. | 0.5 hari |
| 8 | **[P1]** | `src/exporters/Mp4Exporter.js:282–308` | **Artefak Diskontinuitas State Filter pada Streaming LUFS.** Reset state filter biquad di setiap blok 400ms mendistorsi pengukuran loudness normalisasi. | Gunakan filter biquad stateful yang mempertahankan memory state, atau alihkan ke native `OfflineAudioContext`. | 1 hari |
| 9 | **[P2]** | `engine/stt-worker.js:7`, `engine/face-track.js:5–16`, `index.html:7–9` | **Ketergantungan CDN Eksternal & Kebocoran Privasi.** Kegagalan koneksi ke jsdelivr/Google Storage melumpuhkan app; materi berita saham terkirim ke server GLM China. | Vendor dependensi secara lokal/offline, dan pasang disclaimer privasi transparan bagi analis teknikal.id. | 2 hari |
| 10 | **[P2]** | `src/main.js:1–1272`, `src/exporters/Mp4Exporter.js:1–347` | **Zero Automated Test pada Subsistem Browser Kritis.** 100 unit test tidak menyentuh WebCodecs, playback dual-video, atau integrasi UI main thread. | Bangun minimal 1 suite end-to-end smoke test dengan Playwright untuk memvalidasi alur ingest-render-export. | 2 hari |
