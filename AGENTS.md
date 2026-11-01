<!-- Nila agent rules — diadaptasi dari teknikal.id AGENTS.md/CLAUDE.md (owner directive 1 Nov 2026: "biar efficient dan terstruktur") -->

# Nila — Agent Rules

**Nila** — browser-local AI video editor (vanilla ESM, zero-dependency, no build step). Talking-head → vertical shorts. Owner: Nicholas (solo dev). Repo ini hasil eksperimen pribadi, BUKAN produk org teknikal.id/hivePOS.

## Build & test commands

- `python3 -m http.server 8765` lalu buka `http://localhost:8765` (localhost = secure context; `file://` tidak dapat folder picker)
- `node --test` — unit test (engine/timeline/motion/loudness/sprint1). SEMUA test WAJIB hijau sebelum commit.
- `node --check <file>` — syntax gate tiap file .js yang disentuh.
- Tanpa bundler/CI — verifikasi fisik manual: buka UI di browser, jalankan flow, lihat hasilnya.

## Architecture (round-7 rewrite — jangan dilanggar)

```
engine/   = pure decision layer (tanpa DOM; unit-testable; STT, cut logic, motion, loudness, srt)
src/core/ = Project model + Compositor scene graph + Playback + undo/redo
src/elements/ = polymorphic renderables (video layers, captions, MOGRTs, overlays)
src/agents/   = GLM EditorAgent (persona + variants + self-critique + council)
src/exporters/ = WebCodecs MP4 (mediabunny) — loudness −14 LUFS
src/ui/   = timeline view + inspector + panels
lib/render.js = drawFrame() — SATU compositor untuk preview DAN export (parity invariant)
```

### Boundary rules

1. **Logic keputusan (cut/filler/motion/score) hidup di `engine/`** — pure function, tanpa DOM. Kalau butuh test, ia harus bisa dites tanpa browser.
2. **`lib/render.js` = satu-satunya compositor.** DILARANG menggambar frame langsung di tempat lain — preview dan export harus identik. Fitur visual baru = renderable baru di `src/elements/` (atau extend compositor), bukan canvas hack di UI.
3. **`engine/timeline.js` = satu-satunya timebase** (edited ↔ source mapping). Jangan pernah menghitung mapping waktu sendiri di UI/exporter.
4. **UI (src/main.js, src/ui/) = tipis**: DOM events in → project methods out. Tidak ada business logic di event handler.
5. **Model EDL (`src/core/Project.js`) satu pintu mutasi** + pushUndo untuk setiap perubahan yang user-facing (undoable).

## API Reuse Rule (adaptasi owner directive 17 Okt)

Media processing = SATU PINTU per concern:

1. **REUSE DULU** — sebelum bikin fungsi baru: audio decode → `engine/analyze.js`; STT → `engine/transcribe.js` + worker; cut → `engine/edit-engine.js`; face → `engine/face-track.js`; motion → `engine/motion.js`; export encode → `src/exporters/Mp4Exporter.js`. Kalau kemampuan sudah ada → pakai/improve.
2. **IMPROVE, BUKAN DUPLIKAT** — kalau fungsi lama kurang (parameter/output), extend backward-compatible; konsumen lama tidak boleh putus.
3. **GLM call = hanya lewat `engine/glm.js`** (keep-ranges by word-index, never timestamps). Agent/persona baru reuse client ini.
4. Persistence IndexedDB = hanya lewat store layer (`engine/idb-cache.js` / `engine/project-store.js`) — tidak ada `indexedDB.open` liar di UI.

## New Feature Protocol (sebelum nulis kode)

1. **Decision logic atau presentation?** Decision → `engine/` (pure + test). Presentation → `src/elements/` renderable. Input UI → `src/ui/` tipis.
2. **Preview = export?** Kalau fitur visual, WAJIB lewat compositor yang sama; tulis di laporan bahwa parity sudah dicek.
3. **Ada state user-facing?** → mutasi via Project + pushUndo + (sejak sprint 1) auto-persist ke project-store.
4. **Zero-dependency?** Fitur yang menuntut npm package = STOP, diskusikan owner dulu.

## Conventions

- Vanilla ESM murni, no build step, no TypeScript — jangan introduces bundler/transpiler tanpa keputusan owner.
- Gaya kode: 2-space indent, komentar menjelaskan *why* (bukan what), nama pendek, arrow functions konsisten dengan file sekitar.
- UI copy: English. Komentar: English (laporan/dokumen boleh Indonesia).
- Git: branch per goal (`feat/<slug>`), merge ke `main` hanya setelah `node --test` hijau + verified fisik di browser. Satu branch = satu fokus.
- Test: logic murni baru WAJIB punya unit test di `test/*.test.mjs` (node --test). DOM/WebCodecs tidak di-unit-test — diverifikasi manual di laporan.
- **GateGuard pre-flight** sebelum perubahan besar (rebrand, refactor arsitektur, sentuh export path): tulis dulu `targets / blast / rollback` di deliverable, baru eksekusi.
- Diagram alur (adaptasi): tulis sebagai Mermaid code di `.md`, bukan gambar manual.
- Besar perubahan >½ hari kerja atau menyentuh >5 file → laporan tertulis (`SPRINT*-REPORT.md` / `docs/`).

## Forbidden (hard rules)

- ❌ npm dependency apa pun (tetap zero-dependency — keputusan owner).
- ❌ Menggambar frame di luar `lib/render.js` (parity rusak).
- ❌ Menghitung timebase di luar `engine/timeline.js`.
- ❌ Mengubah DEBATE-REVIEW.md / test fixtures tanpa instruksi owner.
- ❌ Upload frame/audio ke server mana pun selain word-list ke GLM endpoint user's own key (privacy contract README).
- ❌ Refactor besar-besaran "sekalian" — selalu surgical.

## Lessons (append-only)

- 1 Nov 2026: browser crash saat Whisper transcribe 60s → seluruh state hilang karena EDL tidak persisten (debat temuan P0#1) → sprint 1 memasang project-store. Verified dengan reproduksi reload.
- 1 Nov 2026: klaim AI (agy/LLM) = kandidat temuan, bukan fakta — spot-check file:baris sebelum dieksekusi; beberapa klaim debat benar, diverifikasi fisik sebelum dipercaya.
- 1 Nov 2026: rename CSS var (--clay→--accent) harus disertai grep rgba-hardcode (217,119,87) di canvas code — getComputedStyle tidak menangkap warna literal di ctx.fillStyle.
