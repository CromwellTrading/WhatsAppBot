// mod-bot-baileys-full.js
// Bot Guardián Baileys - versión robusta para hosts efímeros (Render free)
// Usa useMultiFileAuthState + persistencia multi-file en Supabase.

const express = require('express');
const cron = require('node-cron');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@adiwajshing/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

// -------- CONFIG --------
const AUTH_DIR = path.join(__dirname, 'baileys_auth'); // carpeta local temporal
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('❌ FALTAN ENV VARS: SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

const GROUP_ID = process.env.GROUP_ID || null;
const MAX_WARNINGS = parseInt(process.env.MAX_WARNINGS || '3', 10);
const AUTO_MESSAGES = [
  "🤖 Bot guardián activo (Baileys).",
  "Recuerden respetar las reglas del grupo.",
  "Mensaje automático: eviten enlaces."
];

// -------- SMALL RECENT CHATS MAP --------
const RECENT_CHAT_LIMIT = 200;
const recentChats = new Map(); // key: jid, value: { id, lastSeenISO, isGroup, sampleText }
function pushRecentChat(jid, isGroup, sampleText) {
  recentChats.set(jid, { id: jid, isGroup: !!isGroup, lastSeenISO: new Date().toISOString(), sampleText: String(sampleText).slice(0, 200) });
  if (recentChats.size > RECENT_CHAT_LIMIT) {
    const firstKey = recentChats.keys().next().value;
    recentChats.delete(firstKey);
  }
}

// -------- HELPERS --------
function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}
function safeTextFromMessage(msg) {
  if (!msg) return '';
  if (msg.message?.conversation) return msg.message.conversation;
  if (msg.message?.extendedTextMessage?.text) return msg.message.extendedTextMessage.text;
  if (msg.message?.imageMessage?.caption) return msg.message.imageMessage.caption;
  if (msg.message?.documentMessage?.caption) return msg.message.documentMessage.caption;
  if (msg.message?.videoMessage?.caption) return msg.message.videoMessage.caption;
  return '[NO-TEXTO]';
}

// -------- SUPABASE: session multi-file persistence --------
// We'll store ALL files in AUTH_DIR as a JSON object in wa_session_json.auth_json
// Row shape: { key: 'baileys_auth', auth_json: '{"filename": "base64", ...}' }

async function uploadAuthToSupabase() {
  try {
    // build object of files
    const obj = {};
    if (!fs.existsSync(AUTH_DIR)) {
      console.warn('⚠️ AUTH_DIR vacío al subir (ningún archivo aún).');
      return false;
    }
    const walk = (dir) => {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const it of items) {
        const full = path.join(dir, it.name);
        if (it.isDirectory()) walk(full);
        else {
          const rel = path.relative(AUTH_DIR, full).replace(/\\/g, '/');
          obj[rel] = fs.readFileSync(full).toString('base64');
        }
      }
    };
    walk(AUTH_DIR);
    const payload = [{ key: 'baileys_auth', auth_json: JSON.stringify(obj) }];
    const { error } = await supabase.from('wa_session_json').upsert(payload, { onConflict: ['key'] });
    if (error) {
      console.error('❌ Error subiendo auth a Supabase:', error);
      return false;
    }
    console.log('✅ Auth (multi-file) subido a Supabase');
    return true;
  } catch (e) {
    console.error('uploadAuthToSupabase err:', e);
    return false;
  }
}

async function downloadAuthFromSupabase() {
  try {
    const { data, error } = await supabase.from('wa_session_json').select('auth_json').eq('key', 'baileys_auth').single();
    if (error) {
      console.warn('⚠️ No auth en Supabase o error al leer:', error.message || error);
      return false;
    }
    if (!data || !data.auth_json) {
      console.warn('⚠️ Fila auth vacía');
      return false;
    }
    const obj = JSON.parse(data.auth_json);
    // write files
    for (const [rel, b64] of Object.entries(obj)) {
      const full = path.join(AUTH_DIR, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, Buffer.from(b64, 'base64'));
    }
    console.log('⬇️ Auth restaurado desde Supabase (archivos escritos en AUTH_DIR)');
    return true;
  } catch (e) {
    console.error('downloadAuthFromSupabase err:', e);
    return false;
  }
}

// -------- SUPABASE: warnings helpers --------
async function getWarnCount(user_id) {
  try {
    const { data, error } = await supabase.from('warnings').select('warn_count').eq('user_id', user_id).single();
    if (error && error.code !== 'PGRST116') {
      console.error('Error getWarnCount:', error);
      return 0;
    }
    return data ? data.warn_count : 0;
  } catch (e) {
    console.error('getWarnCount err:', e);
    return 0;
  }
}
async function setWarnCount(user_id, count) {
  try {
    const { error } = await supabase.from('warnings').upsert([{ user_id, warn_count: count }], { onConflict: ['user_id'] });
    if (error) console.error('Error setWarnCount:', error);
  } catch (e) { console.error('setWarnCount err:', e); }
}
async function deleteWarns(user_id) {
  try {
    const { error } = await supabase.from('warnings').delete().eq('user_id', user_id);
    if (error) console.error('Error deleteWarns:', error);
  } catch (e) { console.error('deleteWarns err:', e); }
}

// -------- START BOT --------
async function startBot() {
  // 1) Try restore from Supabase (multiple attempts)
  let restored = false;
  for (let i = 0; i < 6; i++) {
    try {
      restored = await downloadAuthFromSupabase();
      if (restored) break;
    } catch (e) {}
    console.log(`Intento restore ${i + 1}/6 fallido, reintentando en 1s...`);
    await new Promise(r => setTimeout(r, 1000));
  }

  // 2) useMultiFileAuthState -> returns { state, saveCreds }
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 2204, 13] }));
  console.log('Baileys version:', version);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: { level: 'warn' }
  });

  let lastQr = null;
  let uploadedOnce = false;
  let uploading = false;

  // Debounced uploader (reads folder and uploads)
  async function saveAndUploadDebounced() {
    if (uploading) return;
    uploading = true;
    try {
      const ok = await uploadAuthToSupabase();
      if (ok) uploadedOnce = true;
    } catch (e) {
      console.warn('saveAndUpload err:', e);
    } finally {
      uploading = false;
    }
  }

  // When creds update: saveCreds AND upload
  sock.ev.on('creds.update', async (creds) => {
    try {
      await saveCreds(creds); // writes files under AUTH_DIR
      await saveAndUploadDebounced();
    } catch (e) {
      console.warn('creds.update handler err:', e);
    }
  });

  // connection updates
  sock.ev.on('connection.update', async (update) => {
    try {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        lastQr = qr;
        console.log('⚠️ Nuevo QR generado. /qr para escanear.');
      }
      if (connection === 'open') {
        console.log('🚀 Conectado (OPEN). Subiendo credenciales a Supabase...');
        await saveAndUploadDebounced();
      }
      if (connection === 'close') {
        console.warn('🔌 Conexión cerrada:', lastDisconnect?.error || lastDisconnect);
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          console.warn('Sesión deslogueada. Borrando auth local y en Supabase...');
          // borrar local files
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
          } catch (e) {}
          // borrar en supabase
          try { await supabase.from('wa_session_json').delete().eq('key', 'baileys_auth'); } catch (e) { console.warn('No se pudo borrar en Supabase:', e); }
        }
      }
    } catch (e) {
      console.error('connection.update err:', e);
    }
  });

  // messages
  sock.ev.on('messages.upsert', async (m) => {
    try {
      if (!m.messages || m.type === 'notify') return;
      const msg = m.messages[0];
      if (!msg) return;
      if (msg.key && msg.key.remoteJid === 'status@broadcast') return;

      const remoteJid = msg.key.remoteJid;
      const isGroup = isGroupJid(remoteJid);
      const participant = msg.key.participant || msg.key.remoteJid;
      const fromMe = !!msg.key.fromMe;
      const body = safeTextFromMessage(msg);

      pushRecentChat(remoteJid, isGroup, body);
      console.log(`MSG ${isGroup ? 'GRUPO' : 'PRIVADO'} ${remoteJid} ${participant} ${String(body).slice(0,80)}`);

      if (isGroup && !fromMe) {
        const hasLink = /https?:\/\/|www\.[^\s]+/i.test(String(body));
        if (!hasLink) return;

        try { await sock.sendMessage(remoteJid, { delete: msg.key }); } catch (e) { /* ignore */ }

        const senderId = participant;
        let currentWarns = await getWarnCount(senderId);
        currentWarns = (currentWarns || 0) + 1;
        await setWarnCount(senderId, currentWarns);

        const mentionJids = [senderId];

        if (currentWarns < MAX_WARNINGS) {
          const warnText = `⚠️ @${senderId.split('@')[0]} ¡No enlaces! Advertencia ${currentWarns}/${MAX_WARNINGS}`;
          try { await sock.sendMessage(remoteJid, { text: warnText, mentions: mentionJids }); } catch (e) { try { await sock.sendMessage(remoteJid, { text: warnText }); } catch (err) {} }
        } else {
          const banText = `🚫 @${senderId.split('@')[0]} Baneado por spam (llegó a ${currentWarns}/${MAX_WARNINGS}).`;
          try { await sock.sendMessage(remoteJid, { text: banText, mentions: mentionJids }); } catch (e) { try { await sock.sendMessage(remoteJid, { text: banText }); } catch (err) {} }
          try { await sock.groupParticipantsUpdate(remoteJid, [senderId], 'remove'); } catch (e) { console.error('Expulsión falló (asegúrate bot admin):', e.message || e); }
          await deleteWarns(senderId);
        }
      }
    } catch (e) {
      console.error('messages.upsert err:', e);
    }
  });

  // endpoints
  app.get('/qr', async (req, res) => {
    // if any files exist, assume authenticated
    const files = fs.existsSync(AUTH_DIR) ? fs.readdirSync(AUTH_DIR) : [];
    if (files.length > 0) {
      return res.send(`<html><body><h3>Autenticado (archivos en AUTH_DIR).</h3><p>Si necesitas forzar nuevo QR, elimina archivos de /baileys_auth y la fila en Supabase y reinicia.</p></body></html>`);
    }
    if (!lastQr) return res.send('<html><body>Esperando QR... revisa logs.</body></html>');
    try {
      const dataUrl = await QRCode.toDataURL(lastQr);
      res.send(`<html><body><h3>Escanea con WhatsApp app → Dispositivos vinculados → Vincular un dispositivo</h3><img src="${dataUrl}" /></body></html>`);
    } catch (e) {
      res.send('<html><body>Error generando QR. Revisa logs.</body></html>');
    }
  });

  app.get('/status', (req, res) => res.json({ connected: !!sock.user, user: sock.user || null, uploadedOnce }));

  app.get('/chats', (req, res) => {
    try {
      const chats = Array.from(recentChats.values()).map(c => ({
        id: c.id,
        isGroup: c.isGroup,
        lastSeenISO: c.lastSeenISO,
        sampleText: c.sampleText
      }));
      res.json({ total: chats.length, chats });
    } catch (e) {
      res.status(500).send('Error listando chats');
    }
  });

  app.get('/test/:chatId/:message', async (req, res) => {
    try {
      const { chatId, message } = req.params;
      if (!chatId || !message) return res.status(400).send('Faltan parámetros');
      await sock.sendMessage(chatId, { text: `[TEST] ${message}` });
      res.send(`Mensaje enviado a ${chatId}`);
    } catch (e) {
      console.error('/test err', e);
      res.status(500).send(`Error: ${e.message || e}`);
    }
  });

  app.get('/force-upload', async (req, res) => {
    const ok = await uploadAuthToSupabase();
    res.json({ ok });
  });

  app.get('/logout', async (req, res) => {
    try {
      // borrar local
      try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); fs.mkdirSync(AUTH_DIR, { recursive: true }); } catch (e) {}
      // borrar en Supabase
      const { error } = await supabase.from('wa_session_json').delete().eq('key', 'baileys_auth');
      if (error) console.error('Error borrando auth en Supabase:', error);
      res.send('Logout forzado: auth local y Supabase eliminados.');
    } catch (e) {
      res.status(500).send('Error en logout');
    }
  });

  // start express
  app.listen(PORT, () => console.log(`🌐 Servidor en puerto ${PORT}`));

  // Cron: mensajes automáticos si GROUP_ID definido
  cron.schedule('0 * * * *', async () => {
    try {
      if (!GROUP_ID) return;
      await sock.sendMessage(GROUP_ID, { text: AUTO_MESSAGES[Math.floor(Math.random() * AUTO_MESSAGES.length)] });
      console.log('Mensaje automático enviado a', GROUP_ID);
    } catch (e) {
      console.error('Cron error:', e.message || e);
    }
  });

  // periodic upload: try every 15s early then continues
  setInterval(async () => {
    try { await saveAndUploadDebounced(); } catch (e) {}
  }, 15 * 1000);

  console.log('Bot iniciado (Baileys). Revisa logs para QR si aún no autenticado.');
}

startBot().catch(e => {
  console.error('Error arrancando bot Baileys:', e);
});
