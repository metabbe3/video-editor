# Nila UI Critique — minimalist redesign plan
Owner verdict 1 Nov: "terlalu tidak minimalist untuk layout dan component". Analisis agent utama (grounded ke index.html + screenshot), Claude quota habis jadi dikerjakan langsung.

## Diagnosis (dari kode nyata)

### 1. Typography terlalu kecil & terfragmentasi
- Font size terpakai: 10/10.5/11/11.5/12/13/14px — **7 ukuran berbeda di bawah 14px**. Tidak ada scale, cuma angka ad-hoc.
- 12px = ukuran terbanyak (17 deklarasi). Untuk app yang dibaca lama (review cut!), ini melelahkan.
- **Fix**: type scale 3 tingkat: `--fs-ui: 13px` (body/kontrol), `--fs-small: 11.5px` (meta/label sekunder), `--fs-mono: 12px` (timecode). Hapus 10/10.5/11 → naik ke 11.5. 14 tetap untuk header section.

### 2. Border di mana-mana (74 deklarasi) → visual noise
- Hampir tiap panel/card/klip/thumbnail dibungkus 1px border, PLUS surface color beda tipis (#faf9f5 vs #f4f2ea — delta luminance ~2%).
- Border + surface + divider = triple line noise.
- **Fix (aturan konsisten)**:
  - Panel besar: TANPA border → pisahkan pakai **surface step** (bg vs bg-raise, naikkan kontras ke ~5%: bg-raise → #efecdf).
  - Komponen interaktif (button/input/klip terpilih): border hanya saat **hover/focus**; default = surface.
  - Divider antar section: hairline `--border-soft` cukup, jangan double.

### 3. Warna kompeting — 5+ aksen serentak
- Biru accent + hijau --ok + merah --danger + playhead + warna klip + tooltip kuning (chat diff) + merah strikethrough cut.
- Semua "sama penting" = tidak ada yang penting.
- **Fix — peran tegas**:
  - `--accent` biru: SATU warna aksi (selected, primary button, playhead bisa ikut biru).
  - `--danger`: hanya status destruktif/aktif (cut final + delete), bukan dekorasi.
  - `--ok`: hanya toast sukses.
  - Klip timeline: monokrom (surface + accent saat selected). Proposed cut: outline dotted accent, bukan merah.
  - Emoji di chat panel: maksimal 1 per pesan (aturan sudah ada, enforce).

### 4. Hirarki terbalik — transcript bukan hero
- Transcript adalah tempat KEPUTUSAN (review cut ala Claude Code), tapi styling-nya setara panel lain. Preview player juga tidak jelas primernya.
- **Fix**: transcript area = kontras teks paling tinggi + font paling besar di app (14px words), panel lain dim (label kecil, warna redup). Word hover/selected = satu-satunya elemen biru di layar saat itu.

### 5. Padding mikro (2px 8px dominan)
- Semua mepet: tombol padding 2-3px vertical, panel padding 10px, rail 8px 4px.
- **Fix**: spacing scale 4/8/12/16/24: button `6px 12px`, panel `14px`, gap antar section `16px`, section header margin `12px 0 8px`.

### 6. Navigasi redundan (4 sistem)
- Top tabs + left rail 44px + timeline toolbar + player transport buttons.
- **Fix bertahap** (jangan break muscle memory sekaligus): rapikan left rail (ikon 36px → 32px + tooltip saja tanpa label), konsolidasikan tombol transport yang dobel dgn shortcut. Structural: inspector jadi contextual popover dari klip terpilih (progressive disclosure), bukan panel permanen.

## Quick wins (CSS-only, half-day)
| # | Elemen | Sekarang | Usulan |
|---|--------|----------|--------|
| 1 | type scale | 7 ukuran 10-14px | 3 tingkat: 13/11.5/12mono (+transcript 14) |
| 2 | panel border | 74× 1px border | surface step only (bg-raise kontras naik) |
| 3 | button padding | 2-3px vert | 6px 12px |
| 4 | klip warna | multi-hue | monokrom + accent selected |
| 5 | playhead | warna sendiri | accent biru |
| 6 | spacing | ad-hoc 1-12px | scale 4/8/12/16/24 via CSS vars |
| 7 | chat bubble | border+bg+shadow | surface saja, bubble user accent-soft |

## Structural (sprint 5, 1 job agy)
- Inspector → contextual popover (muncul saat klip dipilih).
- Timeline: single-track talking-head default — track labels hidden, height besar utk waveform.
- Chat sidebar: width 300px → 320px, flat, tanpa border kiri (pakai shadow tipis).
- Left rail: 44px → 36px, ikon-only.
- Proposal bar: sticky di atas transcript, satu baris, tombol teks (bukan button box).

## North star (referensi, bukan target wajib)
Linear/Raycast-style pro-minimal: hampir tanpa border, hirarki via 3 surface, satu accent, whitespace generous, fokus "dokumen" (transcript) di tengah seperti canvas.
