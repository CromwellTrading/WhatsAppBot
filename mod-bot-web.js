const express = require('express');
const cron = require('node-cron');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURACIÓN SUPABASE (API METHOD) ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- CONFIGURACIÓN BOT ---
const GROUP_ID = process.env.GROUP_ID; 
const MAX_WARNINGS = 3;
const AUTO_MESSAGES = [
  "¡Hola grupo! Recuerden las reglas.",
  "Bot Guardián activo. Eviten enviar enlaces.",
  "Mensaje por hora: ¡Mantengamos el orden!",
  "🤖 Protegiendo el grupo 24/7."
];

const client = new Client({
  authStrategy: new LocalAuth({ clientId: "moderator-bot" }),
  puppeteer: {
    headless: true,
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  }
});

let lastQr = null;
let clientReady = false;

// 1. EVENTOS DE CONEXIÓN
client.on('qr', (qr) => {
  lastQr = qr;
  clientReady = false;
  qrcodeTerminal.generate(qr, { small: true });
  console.log('⚠️ NUEVO QR GENERADO.');
});

client.on('ready', () => {
  lastQr = null;
  clientReady = true;
  console.log('🚀 BOT LISTO Y CONECTADO');
});

// 2. LÓGICA DE MODERACIÓN Y ADVERTENCIAS
client.on('message_create', async (msg) => {
  try {
    const chat = await msg.getChat();
    
    // Logs para sacar el ID del grupo
    if (msg.body) {
      console.log(`📩 [${chat.name}] ${msg.author || msg.from}: ${msg.body.substring(0, 30)}`);
      console.log(`🆔 ID Grupo: ${chat.id._serialized}`);
    }

    if (!chat.isGroup || msg.fromMe) return;

    if (/https?:\/\/|www\.[^\s]+/i.test(msg.body)) {
      const senderId = msg.author || msg.from;
      
      // MODO NINJA: Delay aleatorio
      const delay = Math.floor(Math.random() * (30000 - 15000) + 15000);
      
      setTimeout(async () => {
        try {
          await msg.delete(true);
          
          // --- GESTIÓN DE ADVERTENCIAS CON API DE SUPABASE ---
          // Buscamos si el usuario ya tiene advertencias
          let { data: userRow } = await supabase
            .from('warnings')
            .select('warn_count')
            .eq('user_id', senderId)
            .single();

          let currentWarns = (userRow ? userRow.warn_count : 0) + 1;

          if (!userRow) {
            await supabase.from('warnings').insert([{ user_id: senderId, warn_count: 1 }]);
          } else {
            await supabase.from('warnings').update({ warn_count: currentWarns }).eq('user_id', senderId);
          }

          const contact = await client.getContactById(senderId);
          const mention = `@${senderId.replace('@c.us', '')}`;

          if (currentWarns < MAX_WARNINGS) {
            await chat.sendMessage(`⚠️ ${mention} ¡No enlaces! Advertencia ${currentWarns}/${MAX_WARNINGS}`, { mentions: [contact] });
          } else {
            await chat.sendMessage(`🚫 ${mention} Baneado por spam.`, { mentions: [contact] });
            setTimeout(() => chat.removeParticipants([senderId]), 2000);
            await supabase.from('warnings').delete().eq('user_id', senderId);
          }
        } catch (e) { console.error('Error moderando:', e); }
      }, delay);
    }
  } catch (e) { console.error('Error general:', e); }
});

// 3. AUTO POST
cron.schedule('0 * * * *', async () => {
  if (clientReady && GROUP_ID) {
    const chat = await client.getChatById(GROUP_ID);
    await chat.sendMessage(AUTO_MESSAGES[Math.floor(Math.random() * AUTO_MESSAGES.length)]);
  }
});

// RUTAS WEB
app.get('/qr', async (req, res) => {
  if (lastQr) {
    res.setHeader('Content-Type', 'image/png');
    await QRCode.toFileStream(res, lastQr);
  } else {
    res.send('<html><head><meta http-equiv="refresh" content="5"></head><body>Cargando QR...</body></html>');
  }
});

app.get('/', (req, res) => res.send('Bot Guardián Online'));
app.listen(PORT, () => {
  console.log(`Puerto ${PORT}`);
  client.initialize();
});
