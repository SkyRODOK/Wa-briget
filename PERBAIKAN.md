# Catatan Perbaikan

## Update v2 (perbaikan tampilan)

### Header/tampilan ke-"potong" di bagian atas
File: `public/index.html`

Body halaman tidak punya `overscroll-behavior`, jadi saat scroll pesan sampai
mentok atas/bawah di HP (terutama Chrome Android), gesture scroll bisa
"bocor" ke seluruh halaman dan menggeser seluruh layout ke atas — inilah yang
membuat header/avatar terlihat terpotong seperti di screenshot.

**Perbaikan:** `body` diubah jadi `position: fixed; inset: 0;` +
`overscroll-behavior: none` di html/body, dan area chat (`.chat-area`) diberi
`overscroll-behavior-y: contain`. Hasilnya seluruh layout terkunci pas di
layar, tidak bisa lagi tergeser walau di-scroll sekencang apa pun.

### Kirim pesan tanpa setup apa pun
Fungsi `sendMessage()` sekarang dibungkus try/catch penuh — kalau ada error
apa pun (termasuk yang belum ketahuan), pesan tetap dicoba tampil dan user
diberi notifikasi jelas, bukan gagal diam-diam. `pushMessage()` juga sudah
otomatis fallback ke penyimpanan lokal kalau Firebase/WhatsApp belum
disetup, jadi chat tetap bisa dipakai dari awal tanpa konfigurasi apa pun.


## 1. Tombol "Kirim" tidak berfungsi (PENYEBAB PASTI)
File: `public/index.html`

Fungsi `filterBadWords()` memanggil `BAD_WORDS.forEach(...)`, tapi variabel
`BAD_WORDS` tidak pernah didefinisikan di mana pun. Setiap kali tombol kirim
dipencet, JavaScript crash diam-diam (`ReferenceError: BAD_WORDS is not
defined`) sehingga pesan tidak pernah benar-benar terkirim — tidak ada error
yang terlihat oleh pengguna.

**Perbaikan:** menambahkan deklarasi `const BAD_WORDS = [...]` (daftar kata
kasar dasar, bisa ditambah/kurangi sesuai kebutuhan) dan membungkus fungsi
filter dengan try/catch sebagai pengaman tambahan agar error serupa di masa
depan tidak lagi mematikan seluruh proses kirim pesan.

Sudah diverifikasi dengan menjalankan halaman di browser: pesan sekarang
benar-benar muncul di chat dan kolom input ter-reset setelah kirim.

## 2. Tampilan halaman aneh/tidak sesuai
File yang diupload: `index.html` di folder utama.

`server.js` menyajikan file web dari folder `public/`
(`express.static(path.join(__dirname, 'public'))`), sesuai juga dengan
struktur folder yang didokumentasikan di `README.md` project ini. Karena
`index.html` sebelumnya diletakkan di luar folder `public/`, kemungkinan besar
yang tampil di Railway adalah versi lama/basi dari deploy sebelumnya, bukan
file yang dimaksud.

**Perbaikan:** `index.html` dipindah ke `public/index.html` sesuai struktur
yang benar. Setelah redeploy dengan struktur ini, halaman yang tampil akan
konsisten dengan file yang ada di project.

## 3. Kode pairing WhatsApp sering gagal/error
File: `server.js`, `package.json`

Setelah ditelusuri, ini sebagian besar bukan murni bug di kode project ini,
tapi ada laporan resmi (GitHub issue Baileys) soal gangguan protokol pairing
code dari sisi WhatsApp sendiri yang membuat banyak pengguna Baileys di
seluruh dunia mengalami kode pairing gagal/ditolak. Beberapa langkah sudah
diterapkan untuk memperbesar peluang berhasil:

- Versi library `@whiskeysockets/baileys` dinaikkan dari `^6.7.9` ke
  `^6.17.16` (rilis terbaru di jalur yang kompatibel, berisi banyak
  perbaikan bug sejak versi lama).
- Identitas browser saat pairing diganti dari `Safari` ke `Google Chrome`,
  sesuai rekomendasi resmi dokumentasi Baileys untuk metode pairing code.
- Pesan error saat pairing gagal diperjelas dan mengarahkan pengguna untuk
  mencoba **Scan QR** sebagai alternatif, karena metode QR jauh lebih stabil
  dan tidak terdampak isu protokol pairing code di atas.

**Saran:** kalau pairing code masih sering gagal setelah update ini, gunakan
**Scan QR** (Menu ⋮ → Sambungkan WhatsApp Asli → tab Scan QR) sebagai cara
utama — cara ini tidak terpengaruh isu yang sedang terjadi di sisi WhatsApp.

## Langkah setelah unzip
1. `npm install` (untuk ambil dependency versi baru)
2. Push ke GitHub → redeploy di Railway seperti biasa (ikuti `DEPLOY-RAILWAY.md`)
3. Kalau sebelumnya sempat gagal pairing berkali-kali, disarankan hapus session
   lama dulu (tombol reset sesi di web, atau kosongkan folder `auth_info` /
   Volume Railway) sebelum mencoba lagi.
