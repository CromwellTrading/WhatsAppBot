const express = require('express');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { Pool } = require('pg');

const app = express();
app.use(bodyParser.json());

// --- CONFIGURACIÓN ---
const PORT = process.env.PORT || 3000;
const GROUP_ID = process.env.GROUP_ID; // Se configura en Render
const DATABASE_URL = process.env.DATABASE_URL; // Usar puerto 6543 para Supabase
const MAX_WARNINGS = 3;

const AUTO_MESSAGES = [
  "¡Hola grupo! Recuerden que los enlaces no están permitidos aquí.",
  "¡Buen día! Mantengamos el chat limpio y respetuoso.",
  "🤖 Bot Moderador activo. Si ves spam, yo me encargo.",
  "¿Cómo va el día? Recuerden seguir las reglas del grupo."
];

// --- CONEXIÓN BASE DE DATOS (SUPABASE) ---
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  pool.query(`
    CREATE TABLE IF NOT EXISTS warnings (
      user_id TEXT PRIMARY KEY,
      warn_count INTEGER DEFAULT 0,
      updated_at TIMESTAMP DEFAULT now()
    );
  `).then(() => console.log('✅ Base de datos Supabase conectada.'))
    .catch(e => console.error('❌ Error DB:', e.message));
}

// --- CLIENTE WHATSAPP ---
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "moderator-bot" }),
  puppeteer: {
    headless: true,
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  }
});

let lastQr = null;
let clientReady = false;

client.on('qr', (qr) => {
  lastQr = qr;
  clientReady = false;
  qrcodeTerminal.generate(qr, { small: true });
  console.log('⚠️ NUEVO QR GENERADO. Abre la URL /qr para escanear.');
});

client.on('ready', () => {
  lastQr = null;
  clientReady = true;
  console.log('🚀 BOT TOTALMENTE LISTO Y RECIBIENDO MENSAJES');
});

// --- LÓGICA DE MODERACIÓN, ADVERTENCIAS Y BANEO ---
client.on('message_create', async (msg) => {
  try {
    const chat = await msg.getChat();
    
    // LOG DE DIAGNÓSTICO (Para el ID del grupo)
    if (msg.body) {
        console.log(`----------------------------------`);
        console.log(`📩 MSG: ${msg.body.substring(0, 50)}`);
        console.log(`👥 CHAT: ${chat.name}`);
        console.log(`🆔 ID GRUPO: ${chat.id._serialized}`);
        console.log(`----------------------------------`);
    }

    // Filtrar: solo grupos, no mensajes propios, y que tenga links
    if (!chat.isGroup || msg.fromMe) return;

    if (/https?:\/\/|www\.[^\s]+/i.test(msg.body)) {
      const senderId = msg.author || msg.from;
      const mentionName = `@${senderId.replace('@c.us', '')}`;
      
      console.log(`🚨 Link detectado de ${senderId}. Aplicando protocolo Ninja...`);

      // 1. DELAY NINJA (Evita baneo de WhatsApp)
      const delay = Math.floor(Math.random() * (45000 - 15000) + 15000); 
      
      setTimeout(async () => {
        try {
          // 2. BORRAR MENSAJE
          await msg.delete(true);
          console.log(`🗑️ Mensaje de ${senderId} borrado.`);

          // 3. GESTIONAR ADVERTENCIAS EN SUPABASE
          let currentWarns = 1;
          if (pool) {
            const res = await pool.query(
              `INSERT INTO warnings (user_id, warn_count) VALUES ($1, 1)
               ON CONFLICT (user_id) DO UPDATE SET warn_count = warnings.warn_count + 1, updated_at = now()
               RETURNING warn_count`, [senderId]
            );
            currentWarns = res.rows[0].warn_count;
          }

          const contact = await client.getContactById(senderId);

          // 4. ACCIÓN: ADVERTIR O EXPULSAR
          if (currentWarns < MAX_WARNINGS) {
            await chat.sendMessage(`⚠️ ${mentionName} ¡Prohibido enlaces! Advertencia ${currentWarns}/${MAX_WARNINGS}`, { mentions: [contact] });
            console.log(`⚠️ Advertencia ${currentWarns} enviada a ${senderId}`);
          } else {
            await chat.sendMessage(`🚫 ${mentionName} excedió el límite. Expulsando...`, { mentions: [contact] });
            
            // Pequeño delay para que lean el porqué de la expulsión
            setTimeout(async () => {
                await chat.removeParticipants([senderId]);
                console.log(`☠️ USUARIO EXPULSADO: ${senderId}`);
            }, 2000);

            // Limpiar historial del usuario tras baneo
            if (pool) await pool.query('DELETE FROM warnings WHERE user_id=$1', [senderId]);
          }
        } catch (e) {
          console.error('❌ Error en ejecución de moderación:', e.message);
        }
      }, delay);
    }
  } catch (e) {
    console.error('❌ Error en message_create:', e);
  }
});

// --- MENSAJE AUTOMÁTICO CADA HORA ---
cron.schedule('0 * * * *', async () => {
  if (clientReady && GROUP_ID) {
    try {
      const chat = await client.getChatById(GROUP_ID);
      const randomMsg = AUTO_MESSAGES[Math.floor(Math.random() * AUTO_MESSAGES.length)];
      await chat.sendMessage(randomMsg);
      console.log('⏰ Auto-post horario enviado.');
    } catch (e) {
      console.error('❌ Error en cron post:', e.message);
    }
  }
});

// --- RUTAS WEB ---
app.get('/qr', async (req, res) => {
  if (lastQr) {
    res.setHeader('Content-Type', 'image/png');
    await QRCode.toFileStream(res, lastQr);
  } else {
    res.send('<html><head><meta http-equiv="refresh" content="5"></head><body><h2>Cargando QR... Refrescando cada 5s.</h2><p>Si ya escaneaste, espera el READY en los logs.</p></body></html>');
  }
});

app.get('/', (req, res) => res.send('Bot Guardián Activo 🛡️'));

app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  client.initialize();
});

// Keep Alive para logs
setInterval(() => { if(clientReady) console.log("💓 Bot vigilando el grupo..."); }, 60000);
