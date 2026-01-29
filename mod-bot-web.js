// mod-bot-web.js
// Bot guardián WhatsApp + Supabase session-sync (Captura TODOS los mensajes)
const express = require('express');
const cron = require('node-cron');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
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

// Client events
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

  // Listar todos los chats al iniciar
  try {
    const chats = await client.getChats();
    console.log(`📱 Total de chats: ${chats.length}`);
    chats.forEach((chat, index) => {
      console.log(`Chat ${index + 1}: ${chat.isGroup ? 'GRUPO' : 'PRIVADO'} - ${chat.name || 'Sin nombre'} - ID: ${chat.id._serialized}`);
    });
    
    await uploadAuthToSupabase();
  } catch (e) {
    console.error('Error obteniendo chats:', e);
  }
});

// ============================================
// FUNCIÓN PARA CAPTURAR TODOS LOS MENSAJES
// ============================================
function capturarMensajeCompleto(msg) {
  try {
    // Datos básicos del mensaje
    const timestamp = new Date().toISOString();
    const from = msg.from || 'unknown';
    const to = msg.to || 'unknown';
    const isFromMe = msg.fromMe;
    const isGroup = msg.id.remote ? msg.id.remote.includes('@g.us') : false;
    
    // Obtener el chat si es posible
    let chatInfo = {};
    try {
      msg.getChat().then(chat => {
        chatInfo = {
          name: chat.name || 'Sin nombre',
          id: chat.id._serialized,
          isGroup: chat.isGroup,
          isReadOnly: chat.isReadOnly
        };
      }).catch(() => {});
    } catch (e) {}
    
    // Tipo de mensaje
    let tipo = 'texto';
    let contenido = '';
    
    if (msg.hasMedia) {
      if (msg.type === 'image') {
        tipo = 'imagen';
        contenido = msg.body || '[IMAGEN]';
      } else if (msg.type === 'video') {
        tipo = 'video';
        contenido = msg.body || '[VIDEO]';
      } else if (msg.type === 'audio') {
        tipo = 'audio';
        contenido = msg.body || '[AUDIO]';
      } else if (msg.type === 'document') {
        tipo = 'documento';
        contenido = msg.body || '[DOCUMENTO]';
      } else if (msg.type === 'sticker') {
        tipo = 'sticker';
        contenido = msg.body || '[STICKER]';
      }
    } else if (msg.location) {
      tipo = 'ubicación';
      contenido = `Lat: ${msg.location.latitude}, Lon: ${msg.location.longitude}`;
    } else if (msg.body) {
      contenido = msg.body;
    } else {
      contenido = '[SIN CONTENIDO]';
    }
    
    // Limitar contenido para logs
    const contenidoLog = contenido.length > 200 ? contenido.substring(0, 200) + '...' : contenido;
    
    // Log completo
    console.log(`\n📨 ====== MENSAJE CAPTURADO ======`);
    console.log(`🕐 ${timestamp}`);
    console.log(`📱 DE: ${from} ${isFromMe ? '(YO)' : ''}`);
    console.log(`📨 PARA: ${to}`);
    console.log(`🏷 TIPO: ${tipo.toUpperCase()}`);
    console.log(`💬 CONTENIDO: ${contenidoLog}`);
    console.log(`👥 ES GRUPO: ${isGroup}`);
    if (chatInfo.name) {
      console.log(`🗂 CHAT: ${chatInfo.name} (${chatInfo.id})`);
    }
    console.log(`🔑 ID MENSAJE: ${msg.id._serialized}`);
    console.log(`📎 TIENE MEDIA: ${msg.hasMedia}`);
    console.log(`==================================\n`);
    
    // ======= LÍNEA ESPECIAL PARA ID DE GRUPO =======
    if (isGroup && chatInfo.id) {
      console.log(`🚨🚨🚨 IDGRP ${chatInfo.id} 🚨🚨🚨`);
    }
    
    // Guardar en archivo log (opcional)
    const logEntry = `${timestamp} | FROM:${from} | TO:${to} | TYPE:${tipo} | CONTENT:${contenido.replace(/\n/g, ' ').substring(0, 100)} | GROUP:${isGroup} | CHAT_ID:${chatInfo.id || 'N/A'}\n`;
    fs.appendFileSync('whatsapp_logs.txt', logEntry, 'utf8');
    
  } catch (error) {
    console.error('Error capturando mensaje:', error);
  }
}

// ============================================
// ESCUCHAR TODOS LOS EVENTOS DE MENSAJES
// ============================================

// 1. Mensajes nuevos recibidos
client.on('message', async (msg) => {
  capturarMensajeCompleto(msg);
});

// 2. Mensajes creados (incluye los que envías tú)
client.on('message_create', async (msg) => {
  // Primero capturar el mensaje
  capturarMensajeCompleto(msg);
  
  // Luego aplicar moderación (solo si no es tuyo y es grupo)
  try {
    if (!msg.fromMe) {
      const chat = await msg.getChat();
      if (chat && chat.isGroup) {
        
        // === AQUÍ TU CÓDIGO DE MODERACIÓN ORIGINAL ===
        const hasLink = /https?:\/\/|www\.[^\s]+/i.test(msg.body || '');
        if (!hasLink) return;

        const senderId = msg.author || msg.from;
        const delay = Math.floor(Math.random() * (30000 - 15000 + 1)) + 15000;

        setTimeout(async () => {
          try {
            try {
              await msg.delete(true);
              console.log(`Mensaje borrado de ${senderId}`);
            } catch (err) {
              console.warn('No se pudo borrar el mensaje:', err.message || err);
            }

            // Gestionar warnings en Supabase
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
                    console.log(`Usuario ${senderId} expulsado`);
                  } catch (e) {
                    console.error('No se pudo expulsar al usuario:', e.message || e);
                  }
                }, 2000);
                const { error: delErr } = await supabase.from('warnings').delete().eq('user_id', senderId);
                if (delErr) console.error('Error al borrar advertencias:', delErr);
              } catch (e) {
                console.error('Error al manejar baneo:', e);
              }
            }
          } catch (e) {
            console.error('Error moderando:', e);
          }
        }, delay);
      }
    }
  } catch (e) {
    console.error('Error en moderación:', e);
  }
});

// 3. Mensajes eliminados
client.on('message_revoke_everyone', async (after, before) => {
  console.log(`🗑 MENSAJE ELIMINADO:`);
  if (before) {
    console.log(`   Contenido original: ${before.body || '[SIN TEXTO]'}`);
    console.log(`   De: ${before.author || before.from}`);
  }
  if (after) {
    console.log(`   Reemplazado por: ${after.body || '[SIN TEXTO]'}`);
  }
});

// 4. Mensajes editados
client.on('message_edit', async (msg, newBody, oldBody) => {
  console.log(`✏️ MENSAJE EDITADO:`);
  console.log(`   De: ${msg.from || msg.author}`);
  console.log(`   Antes: ${oldBody}`);
  console.log(`   Después: ${newBody}`);
});

// 5. Reacciones a mensajes
client.on('message_reaction', async (reaction) => {
  console.log(`👍 REACCIÓN: ${reaction.emoji || '[sin emoji]'}`);
  console.log(`   Al mensaje de: ${reaction.msgId ? reaction.msgId.remote : 'desconocido'}`);
  console.log(`   Por: ${reaction.senderId}`);
});

// Auto post horario
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

// Función para forzar la obtención de chats
app.get('/chats', async (req, res) => {
  try {
    if (!clientReady) {
      return res.status(400).send('Cliente no listo');
    }
    
    const chats = await client.getChats();
    const chatList = chats.map(chat => ({
      id: chat.id._serialized,
      name: chat.name || 'Sin nombre',
      isGroup: chat.isGroup,
      isReadOnly: chat.isReadOnly,
      timestamp: chat.timestamp,
      unreadCount: chat.unreadCount
    }));
    
    res.json({
      total: chats.length,
      chats: chatList
    });
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

// Ruta para enviar un mensaje de prueba
app.get('/test/:chatId/:message', async (req, res) => {
  try {
    if (!clientReady) {
      return res.status(400).send('Cliente no listo');
    }
    
    const { chatId, message } = req.params;
    await client.sendMessage(chatId, `[TEST] ${message}`);
    res.send(`Mensaje enviado a ${chatId}`);
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

// Rutas web: /qr y /
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

app.get('/', (req, res) => res.send(`
  <html>
    <head>
      <title>Bot Guardián Online</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        h1 { color: #333; }
        .endpoints { background: #f5f5f5; padding: 20px; border-radius: 5px; }
        code { background: #e0e0e0; padding: 2px 5px; }
      </style>
    </head>
    <body>
      <h1>🤖 Bot Guardián WhatsApp</h1>
      <p>Estado: ${clientReady ? '✅ CONECTADO' : '⏳ CONECTANDO...'}</p>
      <p><a href="/qr">Ver QR Code</a></p>
      <p><a href="/chats">Ver todos los chats</a></p>
      <div class="endpoints">
        <h3>Endpoints:</h3>
        <ul>
          <li><code>/qr</code> - Ver código QR</li>
          <li><code>/chats</code> - Listar todos los chats</li>
          <li><code>/test/[chatId]/[mensaje]</code> - Enviar mensaje de prueba</li>
        </ul>
      </div>
    </body>
  </html>
`));

(async () => {
  await downloadAuthFromSupabase();
  client.initialize();
  app.listen(PORT, () => {
    console.log(`Puerto ${PORT} - Servidor iniciado`);
    console.log(`Accede a http://localhost:${PORT} para ver el estado`);
  });
})();
