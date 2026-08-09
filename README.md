# NeoChat v2 — WhatsApp Bridge

Menghubungkan web chat NeoChat kamu ke WhatsApp **asli** pakai [Baileys](https://github.com/WhiskeySockets/Baileys).

Mendukung **dua cara sambung**:
1. **Scan QR** (klasik)
2. **Pairing Code** (masukkan nomor HP + kode 8 digit di WhatsApp)

⚠️ **Penting sebelum pakai:**
- Ini **bukan** WhatsApp Business API resmi — cara multi-device tidak resmi ini melanggar ToS WhatsApp. Aman untuk pemakaian personal/testing wajar, tapi **jangan** dipakai untuk kirim pesan massal/spam — risikonya nomor kamu bisa di-banned WhatsApp.
- Folder `auth_info` yang muncul setelah login menyimpan sesi WhatsApp kamu — **jangan** dibagikan ke siapa pun (sama sensitifnya dengan password).

## Deploy ke cloud (Railway)

Project ini **tidak** cocok untuk Vercel/Netlify (butuh proses Node yang jalan terus + WebSocket).

**Railway** didukung penuh. Ikuti panduan lengkap:

👉 **[DEPLOY-RAILWAY.md](./DEPLOY-RAILWAY.md)**

Ringkas: push ke GitHub → Deploy from repo → buat **Volume** di `/data/auth_info` → set `AUTH_DIR=/data/auth_info` → Generate Domain → sambungkan WA.

## Yang dibutuhkan
- [Node.js](https://nodejs.org) versi 18 ke atas (lokal) **atau** akun Railway (cloud).
- Nomor WhatsApp aktif di HP.

## Cara menjalankan (lokal)

1. Buka terminal di folder `wa-bridge` ini.
2. Install dependency:
   ```
   npm install
   ```
3. (Opsional) Salin `.env.example` → `.env` lalu sesuaikan PORT / kode negara.
4. Jalankan server:
   ```
   npm start
   ```
   Kalau berhasil akan muncul:
   ```
   🚀 NeoChat WhatsApp Bridge jalan di http://localhost:3000
   ```
5. Buka `http://localhost:3000` di browser (di HP juga bisa, asal satu jaringan WiFi — ganti `localhost` dengan IP komputer).

## Menyambungkan WhatsApp

### Cara A — Scan QR
1. Menu ⋮ → **Sambungkan WhatsApp Asli**
2. Pilih tab **Scan QR**
3. Di HP: WhatsApp → **Pengaturan → Perangkat Tertaut → Tautkan Perangkat** → scan QR

### Cara B — Pairing Code (baru)
1. Menu ⋮ → **Sambungkan WhatsApp Asli**
2. Pilih tab **Pairing Code**
3. Isi nomor WhatsApp **kamu sendiri** (yang mau di-link), format: `628123456789`
4. Klik **Minta Kode**
5. Kode 8 digit (mis. `ABCD-1234`) akan muncul
6. Di HP: WhatsApp → **Pengaturan → Perangkat Tertaut → Tautkan Perangkat → Tautkan dengan nomor telepon** → masukkan kode tersebut

Setelah status **WhatsApp terhubung!**:
- Tutup modal
- Menu ⋮ → **Nomor Tujuan WA** → isi nomor lawan chat (format `628...`)
- Menu ⋮ → **Mode WhatsApp Asli** → ON
- Sekarang pesan/foto/video/dokumen/voice note dari NeoChat benar-benar terkirim ke WhatsApp, dan balasan (termasuk media) dari WhatsApp akan muncul di web.

## Perbaikan v1.1
- **Media masuk dari WhatsApp** lebih andal: unwrap pesan `ephemeral` / `viewOnce` / `documentWithCaption`, download dengan `reuploadRequest`, batas ukuran, caption ditampilkan di bubble.
- **Pairing Code** sebagai alternatif QR.
- Stiker dari WA ditampilkan sebagai gambar.
- Placeholder teks jika media gagal diunduh / terlalu besar.
- Error handling & reconnect lebih rapi.

## Cara mematikan mode WhatsApp
Menu ⋮ → **Mode WhatsApp Asli** lagi → OFF. NeoChat kembali ke mode chat biasa (Firebase / lokal). Koneksi WA tetap hidup sampai kamu logout dari HP atau hapus `auth_info`.

## Catatan teknis
- Sesi login tersimpan di `auth_info/` — tidak perlu scan/pairing ulang selama folder ini ada dan kamu tidak logout dari HP.
- Logout & mulai ulang: hapus folder `auth_info/`, lalu `npm start` lagi.
- Pesan grup belum didukung (hanya 1-on-1).
- Ukuran media yang diterima dari WA dibatasi ~25 MB (ubah di `.env` → `MAX_MEDIA_BYTES`).
- Socket.IO mengizinkan payload hingga 50 MB.

## Struktur folder
```
wa-bridge/
├── server.js
├── package.json
├── .env.example
├── public/
│   └── index.html
└── auth_info/          ← dibuat otomatis, JANGAN dibagikan
```
