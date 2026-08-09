# Deploy NeoChat WhatsApp Bridge ke Railway (lengkap)

Panduan step-by-step supaya bridge bisa jalan 24 jam di cloud, sesi WhatsApp **tidak hilang** tiap redeploy, dan WebSocket/Socket.IO stabil.

---

## Prasyarat

1. Akun [Railway](https://railway.app) (bisa login dengan GitHub)
2. Repo GitHub yang berisi folder project ini (`server.js`, `package.json`, `public/`, dll.)
3. Nomor WhatsApp aktif di HP

> ⚠️ **Peringatan ToS**: Baileys = multi-device tidak resmi. Risiko ban nomor ada. Pakai untuk personal/testing saja, jangan spam.

> ⚠️ **IP cloud**: Beberapa nomor/WhatsApp kadang lebih sensitif terhadap IP data center. Kalau sering disconnect, coba VPS residential atau restart + pairing ulang.

---

## Langkah 1 — Push ke GitHub

Di komputer lokal:

```bash
cd wa-bridge
git init
git add .
git commit -m "NeoChat WhatsApp Bridge v1.1 — siap Railway"
# buat repo kosong di GitHub, lalu:
git branch -M main
git remote add origin https://github.com/USERNAME/REPO.git
git push -u origin main
```

Pastikan **`.gitignore`** sudah mengabaikan `node_modules/` dan `auth_info/` (sudah disediakan).

---

## Langkah 2 — Buat project di Railway

1. Buka [railway.app](https://railway.app) → **New Project**
2. Pilih **Deploy from GitHub repo**
3. Pilih repo yang berisi `wa-bridge`
4. Jika root repo = folder project, biarkan.  
   Jika project ada di subfolder, di Settings → **Root Directory** isi `wa-bridge` (atau path-nya).

Railway akan otomatis:
- Deteksi Node.js
- Jalankan `npm install`
- Jalankan `node server.js` (dari `package.json` → `start` / `railway.toml`)

---

## Langkah 3 — Volume untuk sesi WhatsApp (PENTING)

Tanpa Volume, folder `auth_info` hilang setiap redeploy → harus scan QR / pairing lagi.

1. Di service Railway → tab **Variables** atau **Settings**
2. Buka bagian **Volumes** (atau di service → **+ New** → **Volume**)
3. **Mount Path**: `/data/auth_info`
4. Nama volume bebas, mis. `wa-auth`

Lalu di **Variables** tambahkan:

| Variable | Value |
|----------|--------|
| `AUTH_DIR` | `/data/auth_info` |

Ini memberitahu `server.js` menyimpan sesi di Volume yang persistent.

---

## Langkah 4 — Environment Variables

Di **Variables** service, set minimal:

| Variable | Value | Wajib? |
|----------|--------|--------|
| `AUTH_DIR` | `/data/auth_info` | **Ya** (kalau pakai Volume) |
| `DEFAULT_COUNTRY_CODE` | `62` | Opsional (default 62) |
| `MAX_MEDIA_BYTES` | `26214400` | Opsional (25 MB) |
| `CORS_ORIGIN` | `*` | Opsional |
| `HOST` | `0.0.0.0` | Opsional (default sudah 0.0.0.0) |
| `PORT` | *(jangan diisi)* | Railway inject otomatis |

`PORT` **jangan** di-hardcode — Railway mengisi sendiri.

---

## Langkah 5 — Generate domain publik

1. Tab **Settings** → **Networking**
2. Klik **Generate Domain**  
   Contoh: `neochat-production-xxxx.up.railway.app`
3. Tunggu deploy selesai (status **Success**)

Cek health:

```
https://DOMAIN-KAMU.up.railway.app/health
```

Harus return JSON mirip:

```json
{ "ok": true, "wa": "disconnected", "uptime": 12 }
```

---

## Langkah 6 — Sambungkan WhatsApp

1. Buka URL Railway di browser (HP atau PC)
2. Menu **⋮** → **Sambungkan WhatsApp Asli**
3. Pilih:
   - **📷 Scan QR** → di HP: WhatsApp → Perangkat Tertaut → Tautkan Perangkat → scan
   - **🔑 Pairing Code** → isi nomor kamu (`62812...`) → Minta Kode → di HP pilih *Tautkan dengan nomor telepon*
4. Tunggu status **WhatsApp terhubung!**
5. Menu **⋮** → **Nomor Tujuan WA** → isi nomor lawan chat
6. Menu **⋮** → **Mode WhatsApp Asli** → **ON**

Selesai. Pesan + foto/video/file dari WhatsApp akan masuk ke web, dan sebaliknya.

---

## Langkah 7 — (Opsional) Custom domain

Settings → Networking → **Custom Domain** → ikuti instruksi DNS.

Kalau pakai custom domain, bisa set:

```
CORS_ORIGIN=https://chat.domainkamu.com
```

---

## Troubleshooting

### Deploy gagal / crash loop
- Lihat **Deployments** → **View Logs**
- Pastikan Node ≥ 18 (sudah di-set di `nixpacks.toml` → Node 20)
- Pastikan Root Directory benar

### QR / pairing tidak muncul
- Pastikan buka **URL Railway**, bukan `localhost`
- Cek log: harus ada `📷 QR baru dibuat` atau `🔑 Pairing code dibuat`
- Refresh halaman setelah server fully up

### Setelah redeploy harus scan ulang
- Volume belum di-mount, atau `AUTH_DIR` salah
- Pastikan Volume mount path = `/data/auth_info` **dan** variable `AUTH_DIR=/data/auth_info`

### WhatsApp sering disconnect
- Normal di IP cloud kadang-kadang
- Server otomatis reconnect (kecuali logout manual)
- Kalau `loggedOut`, hapus isi Volume / set ulang pairing

### Media (foto/video) tidak muncul
- Cek ukuran (default max 25 MB)
- Lihat log server: `Gagal download media` atau `Media terlalu besar`
- Naikkan `MAX_MEDIA_BYTES` jika perlu (ingat RAM plan Railway)

### Socket.IO error di browser
- Pastikan akses lewat HTTPS domain Railway (bukan HTTP random)
- Hard refresh (Ctrl+Shift+R)
- `CORS_ORIGIN=*` biasanya cukup

### Logout paksa & pairing ulang
1. Di Railway → Volume / shell, hapus isi `/data/auth_info`
2. Atau redeploy setelah empty volume
3. Restart service → scan / pairing lagi

---

## Struktur file yang relevan

```
wa-bridge/
├── server.js           ← sudah support AUTH_DIR, HOST, /health, CORS
├── package.json
├── railway.toml        ← start command + healthcheck
├── nixpacks.toml       ← Node 20
├── .env.example
├── .gitignore
├── public/
│   └── index.html
├── DEPLOY-RAILWAY.md   ← file ini
└── auth_info/          ← lokal saja; di Railway diganti Volume
```

---

## Biaya & plan

- Railway punya trial / hobby plan (cek harga terkini di situs mereka)
- Untuk 1 bot personal, resource kecil biasanya cukup
- Volume storage dihitung terpisah (biasanya sangat murah untuk beberapa MB sesi)

---

## Ringkas checklist

- [ ] Push ke GitHub
- [ ] New Project → Deploy from GitHub
- [ ] Buat **Volume** mount `/data/auth_info`
- [ ] Set variable `AUTH_DIR=/data/auth_info`
- [ ] Generate Domain
- [ ] Buka domain → sambungkan WA (QR atau Pairing)
- [ ] Set nomor tujuan + Mode WA ON

Kalau stuck di salah satu langkah, kirim screenshot log Railway-nya.
