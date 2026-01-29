const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const path = require('path');
const cron = require('node-cron');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const puppeteer = require('puppeteer');

// --- CONFIGURACIÓN ---
const PORT = process.env.PORT || 3000;
const GROUP_ID = process.env.GROUP_ID || ''; // Pegarás esto en las variables de Render cuando lo tengas
const DATABASE_URL = process.env.DATABASE_URL; // URL interna de Postgres en Render

// Frases aleatorias para el saludo horario
const RANDOM_MESSAGES = [
  "¡Hola grupo! Recuerden leer las reglas.",
  "Buenos días a todos, esperamos que tengan una excelente jornada.",
  "¿Cómo va el día? Recuerden mantener el respeto en el chat.",
  "¡Saludos! Aquí su bot moderador reportándose.",
  "Recordatorio: Prohibido el spam en este grupo. ¡Gracias!",
  "¡Hey! Espero que estén disfrutando del grupo."
];

// --- INICIALIZACIÓN DE EXPRESS ---
const app = express();
app.use(bodyParser.json());

let lastQr = null;
let clientReady = false;

// --- CONFIGURACIÓN DE BASE DE DATOS (OPCIONAL/FUTURO) ---
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  // Aquí podrías inicializar tablas si lo deseas
  console.log('✅ Conexión a Base de Datos detectada.');
}

// --- CLIENTE WHATSAPP ---
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "moderator-bot" }), // NOTA: En Render Free, esto se borra al reiniciar si no usas Disco Persistente
  puppeteer: {
    headless: true,
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions'
    ]
  }
});

// 1. EVENTOS DE CONEXIÓN
client.on('qr', (qr) => {
  lastQr = qr;
  clientReady = false;
  qrcodeTerminal.generate(qr, { small: true });
  console.log('⚠️ [ESCANEAR] Nuevo QR generado. Ve a la URL /qr para escanearlo.');
});

client.on('ready', () => {
  lastQr = null;
  clientReady = true;
  console.log('✅ [SISTEMA] El bot está LISTO y CONECTADO.');
});

client.on('auth_failure', (msg) => console.error('❌ [ERROR] Fallo de autenticación:', msg));
client.on('disconnected', (reason) => {
  clientReady = false;
  console.log('❌ [DESCONECTADO] Razón:', reason);
});

// 2. DETECCIÓN Y BORRADO INTELIGENTE (LOGS ACTIVOS)
client.on('message_create', async (msg) => {
  try {
    // --- LOG DIAGNÓSTICO PARA OBTENER GROUP_ID ---
    const chat = await msg.getChat();
    
    // Imprimimos TODO para asegurar que los logs lleguen a Render
    console.log(`📨 [MSG] De: ${msg.author || msg.from} | En Chat: "${chat.name}" | ID Chat: ${chat.id._serialized} | Texto: ${msg.body.substring(0, 50)}...`);

    // Solo actuar si es un grupo y el mensaje NO es del bot
    if (!chat.isGroup || msg.fromMe) return;

    // Detectar Enlaces
    const hasLink = /https?:\/\/|www\.[^\s]+/i.test(msg.body);
    
    if (hasLink) {
      console.log(`🚨 [LINK DETECTADO] ID Usuario: ${msg.author} - Preparando eliminación...`);

      // Calcular delay aleatorio entre 15 y 60 segundos
      const delay = Math.floor(Math.random() * (60000 - 15000 + 1) + 15000);
      console.log(`⏳ Esperando ${delay / 1000} segundos para borrar mensaje...`);

      setTimeout(async () => {
        try {
          await msg.delete(true); // true = borrar para todos
          console.log(`🗑️ [BORRADO] Mensaje con link eliminado correctamente.`);
          
          // Opcional: Enviar advertencia después de borrar
          // await chat.sendMessage(`@${(msg.author || msg.from).split('@')[0]} Enlace eliminado. Lee las reglas.`, { mentions: [msg.author || msg.from] });
        } catch (error) {
          console.error(`❌ [ERROR BORRADO] No pude borrar el mensaje. ¿Soy Admin? Error: ${error.message}`);
        }
      }, delay);
    }

  } catch (err) {
    console.error('❌ [ERROR GENERAL] en message_create:', err);
  }
});

// 3. MENSAJE AUTOMÁTICO CADA HORA
// Cron: Minuto 0 de cada hora (* * * *)
cron.schedule('0 * * * *', async () => {
  console.log('⏰ [CRON] Ejecutando tarea programada por hora...');
  
  if (!clientReady) return console.log('⚠️ [CRON] Bot no está listo, saltando mensaje.');
  if (!GROUP_ID) return console.log('⚠️ [CRON] GROUP_ID no configurado. Revisa logs anteriores para obtener el ID del chat.');

  try {
    const chat = await client.getChatById(GROUP_ID);
    // Elegir mensaje aleatorio
    const randomMsg = RANDOM_MESSAGES[Math.floor(Math.random() * RANDOM_MESSAGES.length)];
    
    await chat.sendMessage(randomMsg);
    console.log(`✅ [AUTO-POST] Enviado al grupo: "${randomMsg}"`);
  } catch (error) {
    console.error('❌ [CRON ERROR] Falló el envío automático:', error.message);
  }
});

// 4. KEEP ALIVE (Latido interno)
// Esto imprime en logs cada 5 minutos para asegurar que Render sepa que la app "hace algo"
setInterval(() => {
  const memory = process.memoryUsage();
  console.log(`💓 [HEARTBEAT] Bot: ${clientReady ? 'Online' : 'Offline'} | RAM: ${(memory.rss / 1024 / 1024).toFixed(2)} MB`);
}, 300000); // 5 minutos

// --- RUTAS WEB ---
app.get('/qr', async (req, res) => {
  if (lastQr) {
    res.setHeader('Content-Type', 'image/png');
    await QRCode.toFileStream(res, lastQr);
  } else {
    res.send('<html><head><meta http-equiv="refresh" content="5"></head><body style="font-family:sans-serif;text-align:center;padding:50px;"><h2>Esperando QR o Bot Conectado...</h2><p>Refrescando cada 5s. Revisa los Logs.</p></body></html>');
  }
});

app.get('/', (req, res) => res.send('Bot Activo. Logs en consola.'));

app.listen(PORT, () => console.log(`🚀 Servidor Web iniciado en puerto ${PORT}`));

client.initialize();
