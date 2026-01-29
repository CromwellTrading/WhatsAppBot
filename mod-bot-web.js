// mod-bot-baileys-full.js
// Bot Guardián LIGERO con Baileys + Supabase
// - Detecta enlaces, advierte y expulsa al alcanzar MAX_WARNINGS
// - Persiste credencial en archivo y en Supabase
// - Endpoints: /qr, /status, /chats, /test/:chatId/:message
// - Cron para mensajes automáticos
// -------------------------------------------------------

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
const AUTH_DIR = path.join(__dirname, 'baileys_auth');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
const AUTH_FILE = path.join(AUTH_DIR, 'auth_info_multi.json');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) console.warn('⚠️ Falta SUPABASE env vars');
const supabase = createClient(supabaseUrl, supabaseKey);

const GROUP_ID = process.env.GROUP_ID || null; // ej: '123456789-123456789@g.us'
const MAX_WARNINGS = parseInt(process.env.MAX_WARNINGS || '3', 10);
const AUTO_MESSAGES = [
  "🤖 Bot guardián activo (Baileys).",
  "Recuerden respetar las reglas del grupo.",
  "Mensaje automático: eviten enlaces."
];

// ---------------- AUTH (archivo) ----------------
const { state, saveState } = useSingleFileAuthState(AUTH_FILE);

// ---------------- STORE ----------------
const store = makeInMemoryStore({});

// ---------------- UTIL ----------------
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
      console.warn('No auth file para subir a Supabase.');
      return;
    }
    const b64 = fs.readFileSync(AUTH_FILE).toString('base64');
    const payload = [{ key: 'baileys_auth', auth_b64: b64 }];
    const { error } = await supabase.from('wa_session_json').upsert(payload, { onConflict: ['key'] });
    if (error) console.error('Error subiendo auth a Supabase:', error);
    else console.log('✅ Auth subido a Supabase');
  } catch (e) {
    console.error('Error uploadAuthToSupabase:', e);
  }
}

async function downloadAuthFromSupabase() {
  try {
    const { data, error } = await supabase.from('wa_session_json').select('auth_b64').eq('key', 'baileys_auth').single();
    if (error) {
      console.warn('No auth en Supabase o error:', error.message || error);
      return;
    }
    if (!data || !data.auth_b64) return;
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    fs.writeFileSync(AUTH_FILE, Buffer.from(data.auth_b64, 'base64'));
    console.log('✅ Auth restaurado desde Supabase');
  } catch (e) {
    console.error('Error downloadAuthFromSupabase:', e);
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

// ---------------- INICIALIZA BOT ----------------
async function startBot() {
  await downloadAuthFromSupabase();

  const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 2204, 13], isLatest: false }));
  console.log('Baileys version:', version, 'isLatest?', isLatest);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: { level: 'info' }
  });

  store.bind(sock.ev);
  let lastQr = null;

  // connection updates
  sock.ev.on('connection.update', async (update) => {
    try {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        lastQr = qr;
        console.log('⚠️ Nuevo QR generado. /qr disponible');
      }

      if (connection === 'open') {
        console.log('🚀 Conectado (OPEN).');
        // guardar credenciales
        try { await saveState(); } catch (e) { console.warn('saveState err', e); }
        await uploadAuthToSupabase();
      }

      if (connection === 'close') {
        console.warn('🔌 Conexión cerrada:', lastDisconnect?.error || lastDisconnect);
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          console.warn('Sesión deslogueada. Borrando auth local para forzar nuevo QR.');
          try { fs.unlinkSync(AUTH_FILE); } catch (e) {}
        }
      }
    } catch (e) {
      console.error('connection.update err:', e);
    }
  });

  // cred updates: save
  sock.ev.on('creds.update', async () => {
    try { await saveState(); } catch (e) { console.warn('creds.save err', e); }
  });

  // mensajes
  sock.ev.on('messages.upsert', async (m) => {
    try {
      if (!m.messages || m.type === 'notify') return;
      const msg = m.messages[0];
      if (!msg) return;

      // Ignorar mensajes de status broadcast
      if (msg.key && msg.key.remoteJid === 'status@broadcast') return;

      const remoteJid = msg.key.remoteJid; // chat id
      const isGroup = isGroupJid(remoteJid);
      const participant = msg.key.participant || msg.key.remoteJid; // quien envió (en grupo: participant)
      const fromMe = !!msg.key.fromMe;
      const body = safeTextFromMessage(msg);

      // Log básico
      console.log(`📨 [${isGroup ? 'GRUPO' : 'PRIVADO'}] ${remoteJid} | ${participant} | ${body.toString().slice(0,200)}`);

      // Guardar log local
      try {
        fs.appendFileSync('whatsapp_logs.txt',
          `${new Date().toISOString()} | FROM:${participant} | CHAT:${remoteJid} | GROUP:${isGroup} | FROM_ME:${fromMe} | CONTENT:${String(body).replace(/\n/g,' ')}\n`);
      } catch (e) { /* no fatal */ }

      // Moderación: sólo si es grupo y no es desde el bot (fromMe false)
      if (isGroup && !fromMe) {
        const hasLink = /https?:\/\/|www\.[^\s]+/i.test(String(body));
        if (!hasLink) return;

        // Intentar borrar mensaje (puede fallar si no tiene permisos)
        try {
          await sock.sendMessage(remoteJid, { delete: msg.key });
          console.log('Mensaje intentado borrar (delete request enviado).');
        } catch (e) {
          console.warn('No se pudo borrar mensaje automáticamente:', e.message || e);
        }

        // Manejo de warnings en Supabase
        const senderId = participant; // e.g. '123456789@s.whatsapp.net'
        let currentWarns = await getWarnCount(senderId);
        currentWarns = (currentWarns || 0) + 1;
        await setWarnCount(senderId, currentWarns);

        // Obtener contacto para mencionar (si está en store)
        const mentionJids = [senderId];

        if (currentWarns < MAX_WARNINGS) {
          const warnText = `⚠️ @${senderId.split('@')[0]} ¡No enlaces! Advertencia ${currentWarns}/${MAX_WARNINGS}`;
          try {
            await sock.sendMessage(remoteJid, { text: warnText, mentions: mentionJids });
            console.log(`Advertencia ${currentWarns} enviada a ${senderId}`);
          } catch (e) {
            console.warn('No se pudo enviar advertencia con mención:', e.message || e);
            try { await sock.sendMessage(remoteJid, { text: warnText }); } catch (err) {}
          }
        } else {
          const banText = `🚫 @${senderId.split('@')[0]} Baneado por spam (llegó a ${currentWarns}/${MAX_WARNINGS}).`;
          try {
            await sock.sendMessage(remoteJid, { text: banText, mentions: mentionJids });
          } catch (e) {
            await sock.sendMessage(remoteJid, { text: banText });
          }

          // Intentar expulsar (requiere que el bot sea admin del grupo)
          try {
            await sock.groupParticipantsUpdate(remoteJid, [senderId], 'remove');
            console.log(`Usuario expulsado: ${senderId}`);
          } catch (e) {
            console.error('No se pudo expulsar al usuario (asegúrate bot es admin):', e.message || e);
          }

          // Borrar registro de advertencias del usuario en Supabase
          await deleteWarns(senderId);
        }
      }

    } catch (e) {
      console.error('messages.upsert err:', e);
    }
  });

  // reactions / other events (opcional)
  sock.ev.on('messages.update', (m) => {
    // Puedes loguear ediciones o actualizaciones aquí si te interesa
    // console.log('messages.update', m);
  });

  // ------- Endpoints -------
  // /qr -> muestra QR si hay uno (si la auth local existe, indica autenticado)
  app.get('/qr', async (req, res) => {
    if (fs.existsSync(AUTH_FILE)) {
      return res.send(`<html><body><h3>Autenticado.</h3><p>Si quieres forzar un nuevo QR, elimina <code>auth_info_multi.json</code> y reinicia el servicio.</p></body></html>`);
    }
    // leer última QR desde variable (se actualiza en connection.update)
    // NOTA: Baileys guarda el QR en memory; aquí intentamos leer desde store.events (no garantizado)
    // Mejor ver logs o abrir /status y revisar que QR fue generado.
    return res.send('<html><body><h3>Esperando QR... revisa logs para ver el QR en terminal.</h3></body></html>');
  });

  // /status -> estado de conexión
  app.get('/status', (req, res) => {
    return res.json({ connected: !!sock.user, user: sock.user || null });
  });

  // /chats -> lista de chats (usa store)
  app.get('/chats', (req, res) => {
    try {
      // store.chats es un Map-like en memoria
      const chats = Array.from(store.chats.values()).map(c => ({
        id: c.id,
        name: c.contact?.vname || c.name || null,
        isGroup: isGroupJid(c.id),
        unreadCount: c.unreadCount || 0,
        timestamp: c.conversationTimestamp || c.lastMessages?.[0]?.messageTimestamp || null
      }));
      res.json({ total: chats.length, chats });
    } catch (e) {
      console.error('/chats err', e);
      res.status(500).send('Error listando chats');
    }
  });

  // /test/:chatId/:message -> enviar mensaje de prueba
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

  // iniciar servidor express
  app.listen(PORT, () => {
    console.log(`🌐 Servidor en puerto ${PORT}`);
  });

  // Cron: mensaje automático por hora si GROUP_ID definido
  cron.schedule('0 * * * *', async () => {
    try {
      if (!GROUP_ID) return;
      await sock.sendMessage(GROUP_ID, { text: AUTO_MESSAGES[Math.floor(Math.random() * AUTO_MESSAGES.length)] });
      console.log('Mensaje automático enviado a', GROUP_ID);
    } catch (e) {
      console.error('Cron error:', e.message || e);
    }
  });

  // Guardado periódico de credenciales y subida
  setInterval(async () => {
    try { await saveState(); } catch (e) {}
    try { await uploadAuthToSupabase(); } catch (e) {}
  }, 60 * 1000); // cada 60s

  console.log('Bot iniciado (Baileys). Revisa logs para QR si aún no autenticado.');
}

// arrancar
startBot().catch(e => {
  console.error('Error arrancando bot Baileys:', e);
});
