const express = require('express');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { Pool } = require('pg');

// --- CONFIGURACIÓN Y VARIABLES DE ENTORNO ---
const PORT = process.env.PORT || 3000;
const GROUP_ID = process.env.GROUP_ID; // EJ: '1203630456...@g.us'
const DATABASE_URL = process.env.DATABASE_URL; // URL interna de Render Postgres
const MAX_WARNINGS = 3; // Límite de advertencias antes del BAN

// Frases aleatorias para el mensaje de cada hora
const AUTO_MESSAGES = [
  "¡Hola a todos! Recuerden mantener el respeto en el grupo.",
  "Buenos días/tardes. Si ven spam, el bot se encargará.",
  "Recordatorio: Los enlaces no autorizados están prohibidos.",
  "¡Saludos! Aquí su bot moderador reportándose 🤖",
];

// --- INICIALIZAR EXPRESS Y DB ---
const app = express();
app.use(bodyParser.json());

let pool = null;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Necesario para Render
  });
  
  // Crear tablas automáticamente al iniciar
  pool.query(`
    CREATE TABLE IF NOT EXISTS warnings (
      user_id TEXT PRIMARY KEY,
      warn_count INTEGER DEFAULT 0,
      updated_at TIMESTAMP DEFAULT now()
    );
  `).then(() => console.log('✅ Base de datos sincronizada (Tabla warnings lista).'))
    .catch(err => console.error('❌ Error DB:', err));
} else {
  console.error('❌ FATAL: No has puesto la DATABASE_URL en las variables de entorno.');
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

// EVENTOS DE CONEXIÓN
client.on('qr', (qr) => {
  lastQr = qr;
  clientReady = false;
  qrcodeTerminal.generate(qr, { small: true });
  console.log('⚠️ NUEVO QR. Ve a /qr para vincular.');
});

client.on('ready', () => {
  lastQr = null;
  clientReady = true;
  console.log('✅ BOT CONECTADO Y LISTO PARA MODERAR.');
});

// --- LÓGICA PRINCIPAL: MODERACIÓN Y BANEO ---
client.on('message_create', async (msg) => {
  try {
    const chat = await msg.getChat();
    // LOG DIAGNÓSTICO (Para que saques el ID si aún no lo tienes)
    console.log(`📨 [MSG] De: ${msg.author || msg.from} | Chat ID: ${chat.id._serialized}`);

    // Solo moderar en grupos y ignorar al propio bot
    if (!chat.isGroup || msg.fromMe) return;

    // Detectar enlace
    if (/https?:\/\/|www\.[^\s]+/i.test(msg.body)) {
      const senderId = msg.author || msg.from;
      console.log(`🚨 LINK DETECTADO de ${senderId}. Iniciando protocolo de eliminación...`);

      // MODO NINJA: Esperar entre 15 y 45 segundos aleatoriamente
      const delay = Math.floor(Math.random() * (45000 - 15000 + 1) + 15000);
      
      setTimeout(async () => {
        try {
          // 1. Borrar mensaje
          await msg.delete(true);
          console.log('🗑️ Mensaje eliminado.');

          // 2. Gestionar Advertencias en Base de Datos
          if (pool) {
            // Esta consulta suma 1 advertencia y devuelve el nuevo total
            const res = await pool.query(
              `INSERT INTO warnings (user_id, warn_count) VALUES ($1, 1)
               ON CONFLICT (user_id) DO UPDATE SET warn_count = warnings.warn_count + 1, updated_at = now()
               RETURNING warn_count`,
              [senderId]
            );
            
            const currentWarns = res.rows[0].warn_count;
            const contact = await client.getContactById(senderId);

            // 3. Decidir: Advertir o Expulsar
            if (currentWarns < MAX_WARNINGS) {
              // ADVERTENCIA
              await chat.sendMessage(`⚠️ @${senderId.replace('@c.us', '')} Enlace prohibido. Advertencia ${currentWarns}/${MAX_WARNINGS}.`, {
                mentions: [contact]
              });
              console.log(`⚠️ Usuario advertido (${currentWarns}/${MAX_WARNINGS})`);
            } else {
              // EXPULSIÓN (BAN)
              await chat.sendMessage(`🚫 @${senderId.replace('@c.us', '')} has excedido el límite de advertencias. Adiós.`, {
                mentions: [contact]
              });
              
              await chat.removeParticipants([senderId]); // EXPULSAR
              console.log(`☠️ USUARIO EXPULSADO: ${senderId}`);

              // Reiniciar advertencias (opcional, para que si vuelve a entrar empiece de 0, o borrar fila)
              await pool.query('DELETE FROM warnings WHERE user_id=$1', [senderId]);
            }
          }

        } catch (err) {
          console.error('❌ Error en proceso de moderación (¿Soy Admin?):', err.message);
        }
      }, delay);
    }
  } catch (e) {
    console.error('Error general message_create:', e);
  }
});

// --- MENSAJE AUTOMÁTICO CADA HORA ---
cron.schedule('0 * * * *', async () => {
  if (!clientReady || !GROUP_ID) return;
  try {
    const chat = await client.getChatById(GROUP_ID);
    const msg = AUTO_MESSAGES[Math.floor(Math.random() * AUTO_MESSAGES.length)];
    await chat.sendMessage(msg);
    console.log('⏰ Auto-post enviado.');
  } catch (e) {
    console.error('Error cron:', e.message);
  }
});

// --- SERVIDOR WEB (QR + KeepAlive) ---
app.get('/qr', async (req, res) => {
  if (lastQr) {
    res.setHeader('Content-Type', 'image/png');
    await QRCode.toFileStream(res, lastQr);
  } else {
    res.send('<html><head><meta http-equiv="refresh" content="5"></head><body><h2>Cargando... o ya conectado.</h2></body></html>');
  }
});

// Keep Alive Endpoint (Úsalo con UptimeRobot)
app.get('/', (req, res) => res.send('Bot Online.'));

app.listen(PORT, () => console.log(`🚀 Server en puerto ${PORT}`));
client.initialize();
