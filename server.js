require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const pino = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    getContentType,
    Browsers,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_CC = process.env.DEFAULT_COUNTRY_CODE || '62';
// Batas ukuran media yang di-download & dikirim ke web (bytes). Default 25 MB.
const MAX_MEDIA_BYTES = Number(process.env.MAX_MEDIA_BYTES) || 25 * 1024 * 1024;
// Folder sesi WA — di Railway mount Volume ke path ini (lihat DEPLOY-RAILWAY.md)
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_info');

const app = express();
// Static assets + cache ringan (HTML selalu dicek ulang)
app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    lastModified: true,
    maxAge: '1h',
    setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));

const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 50 * 1024 * 1024, // izinkan payload file/gambar/voice note lewat socket
    cors: {
        origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
        methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    pingTimeout: 30_000,
    pingInterval: 20_000
});

let sock = null;
let waConnected = false;
let latestQR = null;
let latestPairingCode = null;
let pairingRequested = false;
let waAuthReady = false; // true setelah QR pertama / socket siap auth
let preferredAuth = 'qr'; // 'qr' | 'pair'
let pendingPairingPhone = null; // nomor menunggu event QR untuk request code
let pairingCodeInFlight = false;
let isStartingWA = false;
let reconnectTimer = null;
let mediaDownloadQueue = 0;
const MAX_PARALLEL_MEDIA = 2;

/** Minta pairing code HANYA setelah event QR (socket sudah siap). Ini kunci agar kode valid. */
async function tryRequestPairingOnReady() {
    if (!sock || !pendingPairingPhone) return;
    if (sock.authState?.creds?.registered) return;
    if (pairingCodeInFlight) return;
    if (!waAuthReady) return;

    pairingCodeInFlight = true;
    pairingRequested = true;
    const phone = pendingPairingPhone;
    try {
        console.log('🔑 Meminta pairing code untuk', phone, '...');
        const code = await sock.requestPairingCode(phone);
        const formatted = formatPairingCode(code);
        latestPairingCode = formatted || code;
        io.emit('pairing-code', latestPairingCode);
        io.emit('wa-status', 'pairing');
        console.log('🔑 Pairing code SIAP:', latestPairingCode, '(masukkan di WA dalam ~1 menit)');
    } catch (err) {
        console.error('Gagal requestPairingCode:', err?.message || err);
        latestPairingCode = null;
        pairingRequested = false;
        io.emit('pairing-error', {
            error: (err?.message ? err.message + ' — ' : '') +
                'Gagal membuat kode pairing. Ini kadang disebabkan gangguan sementara di sisi WhatsApp untuk metode pairing code. Coba "Minta Kode Baru", atau gunakan tab Scan QR (lebih stabil).'
        });
    } finally {
        pairingCodeInFlight = false;
    }
}

// Healthcheck untuk Railway / uptime monitor
app.get('/health', (_req, res) => {
    res.json({
        ok: true,
        wa: waConnected ? 'connected' : 'disconnected',
        uptime: Math.floor(process.uptime())
    });
});

// ---- Helper: ubah input nomor jadi WhatsApp JID ----
function normalizeJid(input) {
    if (!input) return null;
    let n = String(input).replace(/[^0-9]/g, '');
    if (!n) return null;
    if (n.startsWith('0')) n = DEFAULT_CC + n.slice(1);
    // jika belum ada kode negara dan panjang wajar untuk nomor lokal, tambahkan DEFAULT_CC
    if (!n.startsWith(DEFAULT_CC) && n.length <= 12) n = DEFAULT_CC + n;
    return n + '@s.whatsapp.net';
}

function sanitizePhone(input) {
    if (!input) return null;
    let n = String(input).replace(/[^0-9]/g, '');
    if (!n) return null;
    // 08xxxx → 628xxxx
    if (n.startsWith('0')) n = DEFAULT_CC + n.slice(1);
    // 8xxxx (10–12 digit lokal ID) → 628xxxx
    if (!n.startsWith(DEFAULT_CC) && n.length >= 9 && n.length <= 12) {
        n = DEFAULT_CC + n;
    }
    return n;
}

function base64ToBuffer(dataUrl) {
    if (!dataUrl) return null;
    const comma = dataUrl.indexOf(',');
    return Buffer.from(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl, 'base64');
}

/**
 * Unwrap pesan yang dibungkus ephemeral / viewOnce / documentWithCaption / dll.
 * Agar imageMessage, videoMessage, dll. bisa diakses dengan benar.
 */
function unwrapMessage(msg) {
    if (!msg) return null;
    // rekursif buka wrapper yang umum di WhatsApp
    const wrappers = [
        'ephemeralMessage',
        'viewOnceMessage',
        'viewOnceMessageV2',
        'viewOnceMessageV2Extension',
        'documentWithCaptionMessage',
        'editedMessage',
        'associatedChildMessage'
    ];
    let current = msg;
    for (let i = 0; i < 5; i++) {
        let unwrapped = false;
        for (const w of wrappers) {
            if (current[w]?.message) {
                current = current[w].message;
                unwrapped = true;
                break;
            }
        }
        if (!unwrapped) break;
    }
    return current;
}

function getMimeAndExt(mimetype, fallbackType) {
    const mime = (mimetype || '').split(';')[0].trim() || 'application/octet-stream';
    const map = {
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'video/mp4': 'mp4',
        'video/3gpp': '3gp',
        'audio/ogg': 'ogg',
        'audio/mpeg': 'mp3',
        'audio/mp4': 'm4a',
        'audio/aac': 'aac',
        'application/pdf': 'pdf'
    };
    const ext = map[mime] || (mime.split('/')[1] || fallbackType || 'bin').replace(/[^a-z0-9]/gi, '');
    return { mime, ext };
}

// ---- Koneksi WhatsApp (Baileys) ----
function formatPairingCode(code) {
    if (!code) return null;
    const raw = String(code).replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    if (raw.length === 8) return raw.slice(0, 4) + '-' + raw.slice(4);
    return String(code);
}

function waitForAuthReady(timeoutMs = 20000) {
    if (waAuthReady && sock) return Promise.resolve(true);
    return new Promise((resolve) => {
        const start = Date.now();
        const t = setInterval(() => {
            if (waAuthReady && sock) {
                clearInterval(t);
                resolve(true);
            } else if (Date.now() - start > timeoutMs) {
                clearInterval(t);
                resolve(false);
            }
        }, 300);
    });
}

async function startWA() {
    if (isStartingWA) return;
    isStartingWA = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    // Pastikan folder auth ada (penting saat Volume Railway masih kosong)
    try {
        if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    } catch (e) {
        console.warn('Tidak bisa membuat AUTH_DIR:', e.message);
    }

    waAuthReady = false;
    pairingCodeInFlight = false;
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    let version;
    try {
        const verInfo = await fetchLatestBaileysVersion();
        version = verInfo.version;
        console.log('WA Web version:', version?.join?.('.') || version);
    } catch (_) {
        version = undefined;
    }

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        // Browser HARUS salah satu identitas resmi (Chrome/Safari/Edge) — custom label bikin pairing ditolak WA.
        // Google Chrome dipakai karena paling stabil untuk metode pairing code per rekomendasi resmi Baileys.
        browser: Browsers.macOS('Google Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000
    });
    isStartingWA = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            waAuthReady = true;
            try {
                latestQR = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
                if (!pairingRequested && !pendingPairingPhone) {
                    latestPairingCode = null;
                }
                io.emit('qr', latestQR);
                io.emit('wa-status', pendingPairingPhone || pairingRequested ? 'pairing' : 'qr');
                console.log('📷 QR/socket auth ready.');
            } catch (e) {
                console.error('Gagal generate QR image', e);
            }
            // KUNCI: minta pairing code HANYA di sini (setelah QR event)
            if (pendingPairingPhone && !sock.authState?.creds?.registered) {
                await tryRequestPairingOnReady();
            }
        }

        if (connection === 'open') {
            waConnected = true;
            waAuthReady = true;
            latestQR = null;
            latestPairingCode = null;
            pairingRequested = false;
            pendingPairingPhone = null;
            preferredAuth = 'qr';
            io.emit('wa-status', 'connected');
            io.emit('pairing-code', null);
            console.log('✅ WhatsApp terhubung!');
        } else if (connection === 'close') {
            waConnected = false;
            waAuthReady = false;
            io.emit('wa-status', 'disconnected');
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;
            console.log(
                '❌ Koneksi WhatsApp tertutup.',
                loggedOut
                    ? 'Kamu logout — hapus folder auth_info lalu jalankan ulang untuk scan QR / pairing baru.'
                    : 'Mencoba reconnect...'
            );
            if (!loggedOut) {
                if (!reconnectTimer) {
                    reconnectTimer = setTimeout(() => {
                        reconnectTimer = null;
                        startWA().catch(console.error);
                    }, 3000);
                }
            } else {
                sock = null;
                latestQR = null;
                latestPairingCode = null;
                pairingRequested = false;
            }
        } else if (connection === 'connecting') {
            io.emit('wa-status', 'connecting');
        }
    });

    // ---- Pesan masuk dari WhatsApp asli -> diteruskan ke web UI ----
    sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
        if (type !== 'notify') return;

        for (const m of msgs) {
            try {
                if (!m.message || m.key.fromMe) continue;
                const jid = m.key.remoteJid;
                if (!jid || jid.endsWith('@g.us')) continue; // lewati grup (versi ini)
                if (jid === 'status@broadcast') continue;

                const senderName = m.pushName || jid.split('@')[0];
                const payload = {
                    from: jid,
                    sender: senderName,
                    timestamp: (m.messageTimestamp ? Number(m.messageTimestamp) * 1000 : Date.now()),
                    time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
                };

                // Unwrap nested wrappers (ephemeral, viewOnce, dll.)
                const content = unwrapMessage(m.message);
                if (!content) continue;

                // Ambil tipe konten yang sebenarnya
                const msgType = getContentType(content) || Object.keys(content).find(k => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage');

                if (msgType === 'conversation' || msgType === 'extendedTextMessage') {
                    payload.type = 'text';
                    payload.text =
                        content.conversation ||
                        content.extendedTextMessage?.text ||
                        '';
                    if (!payload.text) continue;
                } else if (
                    ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(msgType)
                ) {
                    const mediaNode = content[msgType];
                    if (!mediaNode) continue;

                    // Cek ukuran kasar dari fileLength jika ada
                    const declaredSize = Number(mediaNode.fileLength || 0);
                    if (declaredSize > MAX_MEDIA_BYTES) {
                        console.warn(`Media terlalu besar (${declaredSize} bytes) dari ${jid}, dilewati`);
                        payload.type = 'text';
                        payload.text = `[Media terlalu besar untuk ditampilkan di web — ukuran ~${Math.round(declaredSize / 1024 / 1024)} MB]`;
                        io.emit('incoming-message', payload);
                        continue;
                    }

                    // Batasi download paralel agar RAM Railway tidak meledak
                    while (mediaDownloadQueue >= MAX_PARALLEL_MEDIA) {
                        await new Promise((r) => setTimeout(r, 200));
                    }
                    mediaDownloadQueue++;

                    let buffer;
                    const dlOpts = {
                        logger: pino({ level: 'silent' }),
                        reuploadRequest: sock.updateMediaMessage
                    };
                    try {
                        // Prioritas: pesan dengan content yang sudah di-unwrap (penting utk viewOnce/ephemeral)
                        const mediaCarrier = { key: m.key, message: { [msgType]: mediaNode } };
                        buffer = await downloadMediaMessage(mediaCarrier, 'buffer', {}, dlOpts);
                    } catch (dlErr1) {
                        try {
                            // Fallback ke objek pesan asli (Baileys punya normalizer sendiri)
                            buffer = await downloadMediaMessage(m, 'buffer', {}, dlOpts);
                        } catch (dlErr) {
                            console.error('Gagal download media:', dlErr?.message || dlErr);
                            payload.type = 'text';
                            payload.text = `[Gagal mengunduh media ${msgType.replace('Message', '')}]`;
                            io.emit('incoming-message', payload);
                            mediaDownloadQueue = Math.max(0, mediaDownloadQueue - 1);
                            continue;
                        }
                    }
                    mediaDownloadQueue = Math.max(0, mediaDownloadQueue - 1);

                    if (!buffer || !buffer.length) {
                        payload.type = 'text';
                        payload.text = `[Media kosong / gagal diunduh]`;
                        io.emit('incoming-message', payload);
                        continue;
                    }

                    if (buffer.length > MAX_MEDIA_BYTES) {
                        console.warn(`Buffer media terlalu besar (${buffer.length}), dilewati`);
                        payload.type = 'text';
                        payload.text = `[Media terlalu besar (~${Math.round(buffer.length / 1024 / 1024)} MB)]`;
                        io.emit('incoming-message', payload);
                        continue;
                    }

                    const { mime, ext } = getMimeAndExt(mediaNode.mimetype, msgType.replace('Message', ''));
                    const base64 = buffer.toString('base64');

                    const typeMap = {
                        imageMessage: 'image',
                        videoMessage: 'video',
                        audioMessage: 'audio',
                        documentMessage: 'file',
                        stickerMessage: 'image' // tampilkan stiker sebagai gambar di web
                    };
                    payload.type = typeMap[msgType] || 'file';
                    payload.fileName =
                        mediaNode.fileName ||
                        `${payload.type}_${Date.now()}.${ext}`;
                    payload.fileData = `data:${mime};base64,${base64}`;
                    payload.fileSize = buffer.length;
                    payload.text = mediaNode.caption || mediaNode.text || '';
                    // flag khusus audio voice note
                    if (msgType === 'audioMessage' && mediaNode.ptt) {
                        payload.isPtt = true;
                    }
                    if (msgType === 'stickerMessage') {
                        payload.isStickerMedia = true;
                    }
                } else {
                    // tipe lain (reaksi, lokasi, kontak, dll.) dilewati di versi ini
                    continue;
                }

                io.emit('incoming-message', payload);
                console.log(`📩 Pesan masuk dari ${senderName} (${jid}) tipe=${payload.type}`);
            } catch (err) {
                console.error('Gagal memproses pesan masuk:', err);
            }
        }
    });
}

// ---- Jembatan Socket.IO ke web UI ----
io.on('connection', (socket) => {
    socket.emit('wa-status', waConnected ? 'connected' : (latestQR ? 'qr' : 'connecting'));
    if (latestQR) socket.emit('qr', latestQR);
    if (latestPairingCode) socket.emit('pairing-code', latestPairingCode);

    // Minta pairing code (nomor HP yang mau di-link)
    socket.on('request-pairing-code', async (data, callback) => {
        const cb = typeof callback === 'function' ? callback : () => {};
        try {
            if (waConnected) {
                return cb({ ok: false, error: 'WhatsApp sudah terhubung. Logout dulu jika ingin ganti akun.' });
            }

            const forceNew = !!(data && data.forceNew);
            const phone = sanitizePhone(data?.phone);
            if (!phone || phone.length < 10 || phone.length > 15) {
                return cb({
                    ok: false,
                    error: 'Nomor tidak valid. Pakai format 628xxxxxxxxxx (kode negara + nomor, tanpa +).'
                });
            }

            // Kode lama masih valid & user tidak minta baru
            if (!forceNew && latestPairingCode && pendingPairingPhone === phone) {
                return cb({ ok: true, code: latestPairingCode, cached: true, phone });
            }

            if (sock?.authState?.creds?.registered) {
                return cb({
                    ok: false,
                    error: 'Sesi sudah terdaftar. Reset sesi / hapus Volume auth, restart, lalu pairing ulang.'
                });
            }

            preferredAuth = 'pair';
            pendingPairingPhone = phone;
            latestPairingCode = null;
            pairingRequested = true;
            pairingCodeInFlight = false;

            // Jika socket sudah punya QR (auth ready), minta kode sekarang
            if (waAuthReady && sock) {
                await tryRequestPairingOnReady();
                if (latestPairingCode) {
                    return cb({ ok: true, code: latestPairingCode, phone });
                }
            }

            // Belum ready: tunggu sampai kode muncul dari event QR (max 35 dtk)
            const gotCode = await new Promise((resolve) => {
                const start = Date.now();
                const t = setInterval(() => {
                    if (latestPairingCode) {
                        clearInterval(t);
                        resolve(true);
                    } else if (Date.now() - start > 35000) {
                        clearInterval(t);
                        resolve(false);
                    }
                }, 400);
            });

            if (gotCode && latestPairingCode) {
                return cb({ ok: true, code: latestPairingCode, phone });
            }

            // Timeout — minta user coba lagi / QR
            return cb({
                ok: false,
                error: 'Kode belum siap. Tunggu 5 detik, klik Minta Kode Baru, atau pakai tab Scan QR.'
            });
        } catch (err) {
            console.error('Gagal request pairing code:', err);
            pairingRequested = false;
            latestPairingCode = null;
            const msg = err?.message || String(err);
            cb({
                ok: false,
                error: /closed|precondition/i.test(msg)
                    ? 'Koneksi tertutup. Refresh halaman, tunggu sebentar, lalu minta kode lagi.'
                    : (msg || 'Gagal membuat pairing code. Coba tab Scan QR.')
            });
        }
    });

    // Reset sesi auth (untuk pairing ulang total)
    socket.on('reset-wa-session', async (_data, callback) => {
        const cb = typeof callback === 'function' ? callback : () => {};
        try {
            try {
                if (sock) sock.end(undefined);
            } catch (_) {}
            sock = null;
            waConnected = false;
            waAuthReady = false;
            latestQR = null;
            latestPairingCode = null;
            pairingRequested = false;
            pendingPairingPhone = null;
            pairingCodeInFlight = false;
            // Hapus file auth
            try {
                if (fs.existsSync(AUTH_DIR)) {
                    for (const f of fs.readdirSync(AUTH_DIR)) {
                        fs.unlinkSync(path.join(AUTH_DIR, f));
                    }
                }
            } catch (e) {
                console.warn('Gagal bersihkan AUTH_DIR:', e.message);
            }
            io.emit('wa-status', 'connecting');
            io.emit('pairing-code', null);
            setTimeout(() => startWA().catch(console.error), 800);
            cb({ ok: true });
        } catch (err) {
            cb({ ok: false, error: err.message || 'Gagal reset sesi' });
        }
    });

    socket.on('send-message', async (data, callback) => {
        const cb = typeof callback === 'function' ? callback : () => {};
        try {
            if (!sock || !waConnected) {
                return cb({ ok: false, error: 'WhatsApp belum terhubung. Scan QR atau masukkan pairing code dulu.' });
            }
            const jid = normalizeJid(data.to);
            if (!jid) {
                return cb({ ok: false, error: 'Nomor tujuan tidak valid.' });
            }

            let content;
            const type = data.type || 'text';

            if (type === 'text') {
                content = { text: data.text || '' };
            } else if (type === 'image') {
                content = { image: base64ToBuffer(data.fileData), caption: data.text || '' };
            } else if (type === 'video') {
                content = { video: base64ToBuffer(data.fileData), caption: data.text || '' };
            } else if (type === 'audio') {
                // Voice note (PTT) — mimetype ogg/opus
                content = {
                    audio: base64ToBuffer(data.fileData),
                    mimetype: data.mimeType || 'audio/ogg; codecs=opus',
                    ptt: true
                };
            } else if (type === 'file') {
                content = {
                    document: base64ToBuffer(data.fileData),
                    fileName: data.fileName || 'file',
                    mimetype: data.mimeType || 'application/octet-stream'
                };
            } else {
                return cb({ ok: false, error: 'Tipe pesan tidak dikenali.' });
            }

            await sock.sendMessage(jid, content);
            cb({ ok: true });
        } catch (err) {
            console.error('Gagal kirim pesan ke WhatsApp:', err);
            cb({ ok: false, error: err.message || 'Gagal mengirim pesan.' });
        }
    });
});

startWA().catch(err => {
    console.error('Gagal memulai koneksi WhatsApp:', err);
});

server.listen(PORT, HOST, () => {
    console.log(`🚀 NeoChat WhatsApp Bridge jalan di http://${HOST}:${PORT}`);
    console.log(`   AUTH_DIR = ${AUTH_DIR}`);
    console.log('Buka URL publik (Railway) di browser, lalu Menu ⋮ → "Sambungkan WhatsApp Asli" (QR atau Pairing Code).');
});
