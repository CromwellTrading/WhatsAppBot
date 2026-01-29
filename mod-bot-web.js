// mod-bot-web.js
// Versión fuerte: detecta TODO lo que hace el dispositivo vinculado + mensajes entrantes
// Incluye: sync Supabase session, moderación (borrar enlaces, warnings, expulsar), y logs claros.
const express = require('express');
const cron = require('node-cron');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIG SUPABASE ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en env vars.');
}
const supabase = createClient(supabaseUrl, supabaseKey);

// --- BOT CONFIG ---
const GROUP_ID = process.env.GROUP_ID || null;
const MAX_WARNINGS = parseInt(process.env.MAX_WARNINGS || '3', 10);
const AUTO_MESSAGES = [
  "¡Hola grupo! Recuerden las reglas.",
  "Bot Guardián activo. Eviten enviar enlaces.",
  "Mensaje por hora: ¡Mantengamos el orden!",
  "🤖 Protegiendo el grupo 24/7."
];

// --- AUTH DIR (LocalAuth) ---
const AUTH_DIR = path.join(__dirname, 'wwebjs_auth');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// --- Supabase <-> Auth sync functions ---
async function downloadAuthFromSupabase() {
  try {
    const { data, error } = await supabase
      .from('wa_session_files')
      .select('file_name, file_b64');

    if (error) {
      console.error('Supabase downloadAuth error:', error);
      return;
    }
    if (!data || data.length === 0) {
      console.log('No hay archivos de sesión en Supabase.');
      return;
    }

    for (const row of data) {
      const filePath = path.join(AUTH_DIR, row.file_name);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, Buffer.from(row.file_b64, 'base64'));
    }
    console.log('✅ Sesión restaurada desde Supabase a', AUTH_DIR);
  } catch (e) {
    console.error('Error descargando sesión desde Supabase:', e);
  }
}

async function uploadAuthToSupabase() {
  try {
    const files = [];
    const walk = (dir) => {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const it of items) {
        const full = path.join(dir, it.name);
        if (it.isDirectory()) walk(full);
        else {
          const rel = path.relative(AUTH_DIR, full).replace(/\\/g, '/');
          const b64 = fs.readFileSync(full).toString('base64');
          files.push({ file_name: rel, file_b64: b64 });
        }
      }
    };
    if (fs.existsSync(AUTH_DIR)) walk(AUTH_DIR);
    if (files.length === 0) {
      console.warn('No se detectaron archivos en', AUTH_DIR);
      return;
    }

    const { error } = await supabase
      .from('wa_session_files')
      .upsert(files, { onConflict: ['file_name'] });

    if (error) console.error('Supabase uploadAuth error:', error);
    else console.log(`✅ Sesión subida a Supabase (${files.length} archivos)`);
  } catch (e) {
    console.error('Error subiendo sesión a Supabase:', e);
  }
}

// --- WHATSAPP CLIENT ---
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "moderator-bot", dataPath: AUTH_DIR }),
  puppeteer: {
    headless: true,
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  }
});

let lastQr = null;
let clientReady = false;

// Global error handlers
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', String(reason));
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err.stack || err);
});

// Helper de log claro (Render captura stdout)
function logSimple(prefix, stuff) {
  try {
    const now = new Date().toISOString();
    console.log(`${now} ${prefix} ${JSON.stringify(stuff)}`);
  } catch (e) {
    console.log('LOG ERR', prefix, stuff);
  }
}

// Client events: qr/auth/ready
client.on('qr', (qr) => {
  lastQr = qr;
  clientReady = false;
  qrcodeTerminal.generate(qr, { small: true });
  console.log('⚠️ NUEVO QR GENERADO.');
});

client.on('authenticated', () => {
  console.log('🔐 Autenticado.');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Falló autenticación:', msg);
});

client.on('ready', async () => {
  lastQr = null;
  clientReady = true;
  console.log('🚀 BOT LISTO Y CONECTADO');

  try {
    await uploadAuthToSupabase();
  } catch (e) {
    console.error('Error subiendo sesión tras ready:', e);
  }
});

// ------------------ EVENT LISTENERS PARA CAPTURAR TODO ------------------

// 1) Mensajes entrantes (reliable for received messages)
client.on('message', async (msg) => {
  try {
    const chat = await msg.getChat().catch(() => null);
    const chatId = chat ? chat.id._serialized : (msg.from || '[unknown]');
    const chatName = chat ? (chat.name || chatId) : chatId;
    const author = msg.author || msg.from;
    const fromMe = !!msg.fromMe;
    const body = (msg.body || '').replace(/\n/g, ' ').substring(0, 800);

    // Línea prioritaria para buscar en Render: IDGRP
    console.log(`IDGRP ${chatId} | EVENT message | fromMe:${fromMe} | author:${author} | CHAT "${chatName}" | MSG "${body}"`);

    // ----------------------------------------------------------------
    // Conserva la misma lógica de moderación: solo actúa en grupos y si no es del bot
    // Para no duplicar acciones, si el msg fue creado por el cliente (fromMe true) 
    // evitamos volver a procesar la moderación que también se maneja en message_create.
    if (!chat || !chat.isGroup || msg.fromMe) return;

    // Detección enlaces y resto de la lógica (idéntica a la que ya tenías)
    const hasLink = /https?:\/\/|www\.[^\s]+/i.test(msg.body || '');
    if (!hasLink) return;

    const senderId = msg.author || msg.from;
    const delay = Math.floor(Math.random() * (30000 - 15000 + 1)) + 15000;

    setTimeout(async () => {
      try {
        try {
          await msg.delete(true);
          console.log(`Mensaje borrado de ${senderId} en ${chatId}`);
        } catch (err) {
          console.warn('No se pudo borrar el mensaje (¿es el bot admin?). Error:', err.message || err);
        }

        const { data: userRow, error: selError } = await supabase
          .from('warnings')
          .select('warn_count')
          .eq('user_id', senderId)
          .single();

        if (selError && selError.code !== 'PGRST116') {
          console.error('Supabase select error (warnings):', selError);
        }

        let currentWarns = (userRow ? userRow.warn_count : 0) + 1;

        if (!userRow) {
          const { error: insErr } = await supabase.from('warnings').insert([{ user_id: senderId, warn_count: 1 }]);
          if (insErr) console.error('Supabase insert error (warnings):', insErr);
        } else {
          const { error: upErr } = await supabase.from('warnings').update({ warn_count: currentWarns }).eq('user_id', senderId);
          if (upErr) console.error('Supabase update error (warnings):', upErr);
        }

        let contact;
        try { contact = await client.getContactById(senderId); } catch (e) { contact = null; }
        const mentionText = contact ? `@${contact.number}` : `@${senderId.replace('@c.us', '')}`;

        if (currentWarns < MAX_WARNINGS) {
          try {
            await chat.sendMessage(`⚠️ ${mentionText} ¡No enlaces! Advertencia ${currentWarns}/${MAX_WARNINGS}`, { mentions: contact ? [contact] : [] });
            console.log(`Advertencia ${currentWarns} enviada a ${senderId}`);
          } catch (e) {
            console.warn('No se pudo enviar advertencia con mención:', e.message || e);
            await chat.sendMessage(`⚠️ ${mentionText} ¡No enlaces! Advertencia ${currentWarns}/${MAX_WARNINGS}`);
          }
        } else {
          try {
            await chat.sendMessage(`🚫 ${mentionText} Baneado por spam.`, { mentions: contact ? [contact] : [] });
            setTimeout(async () => {
              try {
                await chat.removeParticipants([senderId]);
                console.log(`Usuario ${senderId} expulsado del chat ${chatId}`);
              } catch (e) {
                console.error('No se pudo expulsar al usuario (¿es el bot admin?).', e.message || e);
              }
            }, 2000);
            const { error: delErr } = await supabase.from('warnings').delete().eq('user_id', senderId);
            if (delErr) console.error('Error al borrar advertencias en Supabase:', delErr);
          } catch (e) {
            console.error('Error al manejar baneo:', e);
          }
        }
      } catch (e) {
        console.error('Error moderando (interno):', e);
      }
    }, delay);

  } catch (e) {
    console.error('Error en handler message:', e);
  }
});

// 2) Mensajes creados por el cliente (este captura cosas que el cliente genera localmente)
client.on('message_create', async (msg) => {
  try {
    const chat = await msg.getChat().catch(() => null);
    const chatId = chat ? chat.id._serialized : (msg.from || '[unknown]');
    const chatName = chat ? (chat.name || chatId) : chatId;
    const author = msg.author || msg.from;
    const fromMe = !!msg.fromMe;
    const body = (msg.body || '').replace(/\n/g, ' ').substring(0, 800);

    // Línea clara para buscar: CREATED
    console.log(`CREATED ${chatId} | fromMe:${fromMe} | author:${author} | CHAT "${chatName}" | MSG "${body}"`);

    // No volvemos a ejecutar la moderación aquí (para evitar duplicados) - la moderación se maneja en 'message' cuando corresponde.
  } catch (e) {
    console.error('Error en handler message_create:', e);
  }
});

// 3) ACKs de mensajes (útil para ver que el dispositivo envió/recibió ack)
client.on('message_ack', (msg, ack) => {
  try {
    // ack codes: 0 - ACK_TYPE_PENDING? ; 1 - SENT, 2 - DELIVERED, 3 - READ (puede variar)
    const chatId = msg?.from || '[unknown]';
    console.log(`ACK ${chatId} | msgId:${msg?.id?._serialized} | fromMe:${!!msg?.fromMe} | ack:${ack}`);
  } catch (e) {
    console.error('Error en message_ack:', e);
  }
});

// 4) Revoke events (mensaje eliminado por usuario)
client.on('message_revoke_everyone', async (after, before) => {
  try {
    // after = message AFTER revoke (maybe null), before = message BEFORE revoke (the deleted msg)
    const beforeBody = before && before.body ? before.body.replace(/\n/g, ' ').substring(0, 400) : '[no-body]';
    const chatId = (before && before.from) || (after && after.from) || '[unknown]';
    console.log(`REVOKE ${chatId} | deleted-msg-snippet: "${beforeBody}"`);
  } catch (e) {
    console.error('Error en message_revoke_everyone:', e);
  }
});

// ------------------ AUTO POST (mantengo) ------------------
cron.schedule('0 * * * *', async () => {
  if (clientReady && GROUP_ID) {
    try {
      const chat = await client.getChatById(GROUP_ID);
      if (chat) {
        const msg = AUTO_MESSAGES[Math.floor(Math.random() * AUTO_MESSAGES.length)];
        await chat.sendMessage(msg);
        console.log('Mensaje automático enviado:', msg);
      }
    } catch (e) {
      console.error('Error enviando auto-mensaje:', e);
    }
  }
});

// RUTAS web: /qr y /
app.get('/qr', async (req, res) => {
  if (lastQr) {
    res.setHeader('Content-Type', 'image/png');
    try {
      await QRCode.toFileStream(res, lastQr);
    } catch (e) {
      console.error('Error generando QR PNG:', e);
      res.status(500).send('Error generando QR');
    }
  } else {
    res.send('<html><head><meta http-equiv="refresh" content="5"></head><body>Cargando QR... (si lleva mucho tiempo, revisa logs)</body></html>');
  }
});

app.get('/', (req, res) => res.send('Bot Guardián Online'));

// Iniciar: restaurar sesión y arrancar cliente
(async () => {
  await downloadAuthFromSupabase();
  client.initialize();
  app.listen(PORT, () => {
    console.log(`Puerto ${PORT} - Servidor iniciado`);
  });
})();
