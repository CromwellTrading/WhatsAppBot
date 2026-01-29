// mod-bot-baileys-full.js (versión robusta para hosts efímeros - Render free)
// - No requiere Persistent Disk: descarga sesión desde Supabase al arrancar y la sube inmediatamente al autenticar.
// - Reintentos en startup, subidas periódicas y endpoint para forzar upload.
// - Mantén una sola instancia del servicio en Render.

const express = require('express');
const cron = require('node-cron');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const {
  default: makeWASocket,
  DisconnectReason,
  useSingleFileAuthState,
  fetchLatestBaileysVersion,
  makeInMemoryStore
} = require('@adiwajshing/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------- CONFIG ----------------
const AUTH_DIR = path.join(__dirname, 'baileys_auth'); // carpeta local temporal
const AUTH_FILE = path.join(AUTH_DIR, 'auth_info_multi.json');
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
  "Recuerden las reglas del grupo.",
  "Mensaje automático: eviten enlaces."
];

// ---------------- AUTH (archivo) ----------------
const { state, saveState } = useSingleFileAuthState(AUTH_FILE);

// ---------------- STORE ----------------
const store = makeInMemoryStore({});

// ---------------- HELPERS ----------------
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

// ---------------- SUPABASE: auth persist ----------------
async function uploadAuthToSupabase() {
  try {
    if (!fs.existsSync(AUTH_FILE)) {
      console.warn('⚠️ No hay auth file local para subir');
      return false;
    }
    const b64 = fs.readFileSync(AUTH_FILE).toString('base64');
    const payload = [{ key: 'baileys_auth', auth_b64: b64 }];
    const { error } = await supabase.from('wa_session_json').upsert(payload, { onConflict: ['key'] });
    if (error) {
      console.error('❌ Error subiendo auth a Supabase:', error);
      return false;
    }
    console.log('✅ Auth subido a Supabase');
    return true;
  } catch (e) {
    console.error('uploadAuthToSupabase err:', e);
    return false;
  }
}

async function downloadAuthFromSupabase() {
  try {
    const { data, error } = await supabase.from('wa_session_json').select('auth_b64').eq('key', 'baileys_auth').single();
    if (error) {
      // no hay auth guardado o error
      console.warn('⚠️ No auth en Supabase o error al leer:', error.message || error);
      return false;
    }
    if (!data || !data.auth_b64) {
      console.warn('⚠️ Fila de auth vacía en Supabase');
      return false;
    }
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    fs.writeFileSync(AUTH_FILE, Buffer.from(data.auth_b64, 'base64'));
    console.log('⬇️ Auth restaurado desde Supabase');
    return true;
  } catch (e) {
    console.error('downloadAuthFromSupabase err:', e);
    return false;
  }
}

// ---------------- SUPABASE: warnings table helpers ----------------
// Tabla: warnings (user_id TEXT PK, warn_count INTEGER)
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
  } catch (e) {
    console.error('setWarnCount err:', e);
  }
}

async function deleteWarns(user_id) {
  try {
    const { error } = await supabase.from('warnings').delete().eq('user_id', user_id);
    if (error) console.error('Error deleteWarns:', error);
  } catch (e) {
    console.error('deleteWarns err:', e);
  }
}

// ---------------- START BOT ----------------
async function startBot() {
  // Si Supabase tiene auth, restaurar antes de inicializar
  // Hacemos varios intentos por si hay latencia de red
  let restored = false;
  for (let i = 0; i < 5; i++) {
    try {
      restored = await downloadAuthFromSupabase();
      if (restored) break;
    } catch (e) { /* skip */ }
    console.log(`Intento de restore ${i+1}/5 fallido, reintentando en 1s...`);
    await new Promise(r => setTimeout(r, 1000));
  }

  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 2204, 13] }));
  console.log('Baileys version:', version);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: { level: 'info' }
  });

  store.bind(sock.ev);
  let lastQr = null;
  let uploadedOnce = false;
  let uploading = false;

  // wrapper para guardar cred + subir (evita colisiones)
  async function saveAndUploadDebounced() {
    if (uploading) return;
    uploading = true;
    try {
      await saveState();
      const ok = await uploadAuthToSupabase();
      if (ok) uploadedOnce = true;
    } catch (e) {
      console.warn('saveAndUpload err:', e);
    } finally {
      uploading = false;
    }
  }

  // eventos de conexion
  sock.ev.on('connection.update', async (update) => {
    try {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        lastQr = qr;
        console.log('⚠️ Nuevo QR generado. Abre /qr para escanear.');
      }

      if (connection === 'open') {
        console.log('🚀 Conectado (OPEN). Guardando cred y subiendo a Supabase...');
        // Guardamos y subimos inmediatamente (minimiza posibilidad de perder sesión)
        await saveAndUploadDebounced();
      }

      if (connection === 'close') {
        console.warn('🔌 Conexión cerrada:', lastDisconnect?.error || lastDisconnect);
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          console.warn('Sesión deslogueada. Borrando auth local para forzar nuevo QR.');
          try { fs.unlinkSync(AUTH_FILE); } catch (e) {}
          // también limpiar en Supabase para forzar reauth si quieres:
          // await supabase.from('wa_session_json').delete().eq('key','baileys_auth');
        }
      }
    } catch (e) {
      console.error('connection.update err:', e);
    }
  });

  // cuando cambian creds -> guardar y subir
  sock.ev.on('creds.update', async () => {
    try {
      await saveAndUploadDebounced();
    } catch (e) {
      console.warn('creds.update err:', e);
    }
  });

  // mensajes entrantes
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

      console.log(`📨 [${isGroup ? 'GRUPO' : 'PRIVADO'}] ${remoteJid} | ${participant} | ${body.toString().slice(0,200)}`);

      // Guardar log local (temporal)
      try {
        fs.appendFileSync('whatsapp_logs.txt', `${new Date().toISOString()} | FROM:${participant} | CHAT:${remoteJid} | GROUP:${isGroup} | FROM_ME:${fromMe} | CONTENT:${String(body).replace(/\n/g,' ')}\n`);
      } catch (e) { /* ignore */ }

      if (isGroup && !fromMe) {
        const hasLink = /https?:\/\/|www\.[^\s]+/i.test(String(body));
        if (!hasLink) return;

        // Intentar borrar (no siempre funciona)
        try { await sock.sendMessage(remoteJid, { delete: msg.key }); } catch (e) { console.warn('No se pudo borrar mensaje:', e.message || e); }

        const senderId = participant;
        let currentWarns = await getWarnCount(senderId);
        currentWarns = (currentWarns || 0) + 1;
        await setWarnCount(senderId, currentWarns);

        const mentionJids = [senderId];

        if (currentWarns < MAX_WARNINGS) {
          const warnText = `⚠️ @${senderId.split('@')[0]} ¡No enlaces! Advertencia ${currentWarns}/${MAX_WARNINGS}`;
          try { await sock.sendMessage(remoteJid, { text: warnText, mentions: mentionJids }); } catch (e) { await sock.sendMessage(remoteJid, { text: warnText }); }
        } else {
          const banText = `🚫 @${senderId.split('@')[0]} Baneado por spam (llegó a ${currentWarns}/${MAX_WARNINGS}).`;
          try { await sock.sendMessage(remoteJid, { text: banText, mentions: mentionJids }); } catch (e) { await sock.sendMessage(remoteJid, { text: banText }); }
          try { await sock.groupParticipantsUpdate(remoteJid, [senderId], 'remove'); } catch (e) { console.error('No se pudo expulsar:', e.message || e); }
          await deleteWarns(senderId);
        }
      }
    } catch (e) {
      console.error('messages.upsert err:', e);
    }
  });

  // Endpoints:
  app.get('/qr', async (req, res) => {
    if (fs.existsSync(AUTH_FILE)) {
      return res.send(`<html><body><h3>Autenticado.</h3><p>Si necesitas forzar nuevo QR, elimina el auth local y/o la fila en Supabase y reinicia el servicio.</p></body></html>`);
    }
    if (!lastQr) return res.send('<html><body>Esperando QR... revisa logs.</body></html>');
    const dataUrl = await QRCode.toDataURL(lastQr);
    res.send(`<html><body><h3>Escanea con la app WhatsApp → Dispositivos vinculados → Vincular un dispositivo</h3><img src="${dataUrl}" /></body></html>`);
  });

  app.get('/status', (req, res) => res.json({ connected: !!sock.user, user: sock.user || null, uploadedOnce }));

  app.get('/force-upload', async (req, res) => {
    const ok = await uploadAuthToSupabase();
    return res.json({ ok });
  });

  // /test endpoint
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

  // subida periódica: cada 15s hasta uploadedOnce, luego cada 60s
  setInterval(async () => {
    try {
      if (!uploadedOnce) {
        await saveAndUploadDebounced();
      } else {
        // cada 60s subir para asegurar persistencia en cambios de creds
        await saveAndUploadDebounced();
      }
    } catch (e) {}
  }, 15 * 1000);

  console.log('Bot iniciado (Baileys). Revisa logs para QR si aún no autenticado.');
}

// arrancar
startBot().catch(e => {
  console.error('Error arrancando bot Baileys:', e);
});
