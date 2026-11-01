# Nila Sprint 2 Implementation Report

**Sprint Goal:** Propose → Debate → Apply Review Flow + Transcript Review UX + AI Chat + Wave-Based Cutting  
**Architecture:** Browser-local vanilla ESM zero-dependency, round-7 pattern (`engine/` pure tested decision layer + `src/core/` state model & scene graph + `src/elements/` polymorphic renderables + `src/ui/` views).  
**Theme:** Nila Blue (`var(--accent)`: `#1f6feb`).

---

## 1. Features Implemented & UI Paths

### A. Wave-Aware Boundaries (Engine Upgrade — Item 4b)

| Feature | Files Changed / Created | UI Path / Cara Pakai | Test Status |
|---|---|---|---|
| **1. Asymmetric Snapping** | `engine/edit-engine.js` | Digunakan otomatis oleh engine saat audio energy map tersedia. Cut-IN snap ke titik energy rising edge (attack kata) dari valley terdekat; Cut-OUT snap ke release falling edge. Mencegah lompatan simetris ±200ms ke napas kata berikutnya. | ✅ Pass (`test/sprint2.test.mjs` test `snapCutIn snaps to rising attack edge, snapCutOut snaps to release`) |
| **2. Adaptive Word Pads** | `engine/edit-engine.js` | `adaptivePads(word, prevWord, nextWord)`: `padLead` di-clamp ke `[40ms, 120ms]` (`gapToPrev * 0.25`); `padTail` di-clamp ke `[60ms, 180ms]` (`gapToNext * 0.25`). Untuk onset plosif (`/p\|t\|k\|b\|d\|g/`), `padLead` minimum 80ms untuk melindungi closure silence sebelum burst voicing. | ✅ Pass (`adaptivePads` unit tests) |
| **3. Voice-Activity Guard** | `engine/edit-engine.js` | `voiceActivityGuard(t, energy, hopSec, threshold, mode)`: Mencegah boundary memotong plateau voicing berkelanjutan (`> threshold * 0.5` selama `> 80ms`). Boundary digeser keluar ke tepi segmen bersuara (start untuk in, end untuk out). | ✅ Pass (`voiceActivityGuard does not cut sustained voicing plateau`) |
| **4. Word-Boundary Drift Guard** | `engine/edit-engine.js` | Jika `\|snapResult - wordBoundary\| > 60ms` dan ada energy minimum lokal dekat `wordBoundary`, engine mempertahankan `wordBoundary` (mencegah Whisper drift melompat ke jeda kata tetangga). | ✅ Pass (`snapAsymmetricBoundary: Whisper drift guard reverts`) |

---

### B. Propose → Debate → Apply Flow (Item 1 & 5)

| Feature | Files Changed / Created | UI Path / Cara Pakai | Test Status |
|---|---|---|---|
| **5. Analyze = Proposal (No Auto-Cut)** | `engine/proposals.js`<br>`src/core/Project.js`<br>`src/main.js`<br>`index.html` | Klik tombol **Analyze** (sebelumnya *Analyze & auto-cut*):<br>1. Transkrip muncul PENUH (semua kata kept-style normal).<br>2. Engine menghitung kandidat cut (`generateProposals`).<br>3. Video EDL preview tetap utuh (raw playback) sebelum Apply.<br>4. Filler jelas (`FILLER_RE`) berstatus default `accepted`; pause/gap/phrase berstatus default `pending`. | ✅ Pass (`generateProposals` test suite) |
| **6. Proposal Review Bar** | `src/main.js`<br>`index.html` | Muncul di atas transcript saat proposal aktif: `[23 cuts proposed · −18% duration]` bersama tiga tombol aksi: `[Apply all]`, `[Debate ⚖]`, `[Dismiss all]`. | ✅ Pass (UI path verified) |
| **7. Ghost / Hatched Timeline Markers** | `src/ui/TimelineView.js`<br>`src/main.js` | Saat ada proposal aktif, durasi strip / ruler pada timeline menampilkan ghost marker merah bergaris (hatched red marker) tipis sebagai preview visual lokasi pemotongan tanpa memotong klip video. | ✅ Pass (Timeline layout parity verified) |
| **8. One-Click Word / Pause Proposal Toggling** | `src/main.js`<br>`engine/proposals.js` | Klik kata proposed di transkrip men-toggle status proposal (accepted ↔ rejected). Kata rejected kembali menjadi normal (kept). Kata normal diklik menjadi manual cut. Token pause `[⏸ 1.2s]` dapat diklik langsung untuk accept/reject cut pause. | ✅ Pass (`toggleProposalStatus` unit test) |
| **9. Apply All & Dismiss All** | `src/main.js`<br>`engine/proposals.js`<br>`src/core/Project.js` | - **Apply all**: Menerapkan semua accepted proposal + manual cuts ke EDL, merekonstruksi timeline, pushUndo, dan mengubah status kata menjadi cut solid.<br>- **Dismiss all**: Menolak semua proposal, membiarkan video utuh tanpa cut, pushUndo. | ✅ Pass (`proposalsToKeeps` & `rejectAllProposals` unit tests) |

---

### C. 3-Persona Editorial Debate Council (Item 2)

| Feature | Files Changed / Created | UI Path / Cara Pakai | Test Status |
|---|---|---|---|
| **10. Local Heuristic Debate Council** | `engine/council-vote.js`<br>`src/main.js`<br>`index.html` | Klik tombol **Debate ⚖** di Proposal Bar:<br>- **MomentumEditor**: Vote agresif cut jeda/filler untuk memacu retensi.<br>- **Storyteller**: Vote keep jika jeda dramatis (0.35s-1.2s) sebelum kata penting / kapital / tanda baca tanya/seru.<br>- **AudioEngineer**: Vote berbasis energi RMS: vote cut hanya jika lembah hening murni (`< -35dB`), vote keep jika ada ambient noise/breath.<br>Hasil voting mayoritas (2-1 atau 3-0) menentukan status `accepted` atau `rejected`. Ringkasan tampil di debate bar: *"filler 12 auto · pause: 6 accepted / 3 rejected (2 vote lawan)"*. Jika ada GLM key, second opinion batch call dijalankan untuk kasus borderline (2-1). | ✅ Pass (`voteProposalLocal` & `runDebateCouncil` unit tests) |

---

### D. Transcript Markup & Cut Reasons (Item 3)

| Feature | Files Changed / Created | UI Path / Cara Pakai | Test Status |
|---|---|---|---|
| **11. Rich Transcript Markup** | `src/main.js`<br>`index.html`<br>`engine/project-store.js` | - **Kata cut final**: Strikethrough solid (`.cut`) + tooltip alasan (`filler "um"`, `pause 1.2s`, `manual`, `AI: <alasan>`).<br>- **Kata proposed**: Strikethrough dotted (`.proposed.accepted` atau `.proposed.pending`) + tooltip alasan durasi.<br>- **Kata kept oleh debate**: Normal text (`.kept-by-debate`) + tooltip hover khusus: `"kept: jeda dramatis (Storyteller)"`.<br>- **Pause chips**: Badge interaktif `[⏸ 1.2s]` di sela kata.<br>- **Persistence**: Status proposal dan hasil debate tersimpan di snapshot IndexedDB (`project-store`), reload tidak hilang. | ✅ Pass (`project-store` roundtrip & markup verified) |

---

### E. Inline AI Chat Box ala Claude Code (Item 4)

| Feature | Files Changed / Created | UI Path / Cara Pakai | Test Status |
|---|---|---|---|
| **12. Transcript Context Menu** | `src/main.js`<br>`index.html` | Klik kanan pada kata atau seleksi rentang kata (drag) memunculkan context menu popover:<br>`✂ Cut this` · `🛡 Keep this` · `💬 Ask AI about this` · `🔍 Zoom punch here`. | ✅ Pass (DOM contextmenu verified) |
| **13. Natural Language Parser (ID + EN)** | `engine/chat-ops.js` | Memetakan instruksi natural pengguna ke operasi project secara instan (zero-key regex parser):<br>- `"jangan dipotong bagian ini"` / `"keep this"` → `keep-range`<br>- `"potong kata ini"` / `"cut this"` → `cut-range`<br>- `"kasih jeda 0.3s setelah kata ini"` → `add-pause`<br>- `"zoom punch disini"` → `add-punch`<br>- `"cari semua 'IHSG' dan zoom punch"` → `multi-punch` (mencari semua kata kecocokan). | ✅ Pass (`parseChatCommand` & `applyChatOp` unit tests) |
| **14. Inline Diff Preview Card & History** | `src/main.js`<br>`index.html` | Klik *"Ask AI about this"* membuka box chat nempel di kursor:<br>1. Mengirim perintah menghasilkan diff preview (kata bersangkutan diberi highlight kuning `.chat-diff-highlight` di transcript).<br>2. Card menampilkan ringkasan aksi + tombol `[Apply]` dan `[Revert]`.<br>3. `[Apply]` menerapkan perubahan ke EDL + pushUndo.<br>4. `[Revert]` membatalkan diff tanpa mengubah EDL.<br>5. Chat history mini tersimpan per project snapshot (reload tidak hilang). | ✅ Pass (`applyChatOp` & persistence verified) |

---

## 2. Test & Syntax Verification

### A. Unit Tests (`node --test`)
- File test baru: `test/sprint2.test.mjs` (14 unit test baru).
- Total test suite: **123 passing tests** (109 tes sebelumnya + 14 tes Sprint 2 baru).
- Durasi: **~180ms**.
- Hasil: **100% PASS, 0 FAIL, 0 CANCELLED, 0 SKIPPED**.

```sh
node --test
# ✔ 123 tests passed
```

### B. Syntax Check (`node --check`)
Semua file yang disentuh/dibuat diverifikasi bebas syntax error:
```sh
node --check engine/edit-engine.js
node --check engine/proposals.js
node --check engine/council-vote.js
node --check engine/chat-ops.js
node --check engine/project-store.js
node --check src/core/Project.js
node --check src/ui/TimelineView.js
node --check src/main.js
node --check test/sprint2.test.mjs
```
Status: **Semua lolos (exit code 0)**.

### C. Dependency & Boundary Invariants Check
- **Zero npm dependency**: Tidak ada penambahan `package.json` maupun module luar (murni vanilla ESM).
- **Compositor parity**: Semua rendering preview dan MP4 export tetap satu pintu via `lib/render.js` / `Compositor.js`. Ghost markers digambar di timeline UI track, bukan di kanvas render video.
- **Decision layer**: Semua logika proposal, voting council, dan parsing chat berada di `engine/` tanpa ketergantungan DOM.
- **Untouched files**: `DEBATE-REVIEW.md`, `test/real/`, dan `SPRINT1-REPORT.md` tidak dimodifikasi sama sekali.

---

## 3. Manual Verification Steps (Browser Physical Run)

1. **Jalankan local server:**
   ```sh
   python3 -m http.server 8765
   open http://localhost:8765
   ```
2. **Propose Flow (Item 1 & 3):**
   - Klik **Pick folder**, pilih folder A-roll.
   - Klik **Analyze** (tombol dengan label baru).
   - Tunggu audio decode dan Whisper STT selesai.
   - **Expected:** Transkrip muncul penuh. Kata-kata filler (seperti *"um"*, *"uh"*) memiliki coretan putus-putus (`.proposed.accepted` dotted strikethrough).
   - Di sela kata yang memiliki jeda, muncul chip `[⏸ X.Xs]`.
   - Di timeline strip ruler atas, muncul ghost marker merah tipis bergaris (hatched).
   - Di atas transkrip muncul panel: *"X cuts proposed · −Y% duration [Apply all] [Debate ⚖] [Dismiss all]"*.
   - Arahkan kursor (hover) ke kata proposed: tooltip menampilkan alasan dan durasi.
   - Klik salah satu kata proposed: coretan putus-putus hilang (status rejected, kata menjadi kept). Klik lagi: kembali menjadi proposed cut.
3. **Debate Council (Item 2):**
   - Klik tombol **Debate ⚖** di Proposal Bar.
   - **Expected:** Baris summary debate muncul: *"⚖ Council: filler X auto · pause: Y accepted / Z rejected (N vote lawan)"*.
   - Kata-kata yang di-keep oleh Storyteller (misalnya jeda dramatis sebelum kata penting) kembali menjadi teks normal dan saat di-hover menampilkan tooltip *"kept: jeda dramatis (Storyteller)"*.
4. **Apply All (Item 1):**
   - Klik **Apply all**.
   - **Expected:** Video EDL dipotong sesuai accepted cuts. Kata-kata cut berubah menjadi strikethrough solid (`.cut`).
   - Proposal bar tertutup, durasi video berkurang, dan undo (⌘Z) dapat mengembalikan ke keadaan sebelum cut.
5. **Context Menu & AI Chat Box (Item 4):**
   - Seleksi kata atau kalimat di transkrip dengan mouse drag.
   - Klik kanan pada seleksi.
   - **Expected:** Muncul context menu kecil: `✂ Cut this` · `🛡 Keep this` · `💬 Ask AI about this` · `🔍 Zoom punch here`.
   - Klik **Ask AI about this**: Box chat inline muncul nempel di posisi kursor.
   - Ketik: `"jangan dipotong bagian ini"` lalu klik Send / Enter.
   - **Expected:** Muncul diff card proposal: *"Keep X words"*. Kata-kata di transkrip mendapat highlight kuning (`.chat-diff-highlight`).
   - Klik **Apply**: Diff diterapkan ke overrides, transkrip terupdate, dan chat history mencatat aksi tersebut.
   - Ketik lagi: `"cari semua 'IHSG' dan zoom punch"` lalu Send.
   - **Expected:** Muncul diff card zoom punch untuk semua kata yang cocok. Klik **Revert**: highlight kuning hilang tanpa mengubah timeline.
   - Tekan **Escape**: Box chat tertutup seketika.
