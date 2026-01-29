// mod-bot-web.js
// Bot Guardián WhatsApp + Supabase session-sync
// Captura TODOS los mensajes + debug fuerte para Render

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

// ==================== SUPABASE ====================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ FALTAN ENV VARS DE SUPABASE');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ==================== CONFIG BOT ====================
const GROUP_ID = process.env.GROUP_ID || null;
const MAX_WARNINGS = parseInt(process.env.MAX_WARNINGS || '3', 10);

const AUTO_MESSAGES = [
  "🤖 Bot guardián activo.",
  "Recuerden respetar las reglas.",
  "Protegiendo el grupo 24/7."
];

// ==================== AUTH DIR ====================
const AUTH_DIR = path.join(__dirname, 'wwebjs_auth');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// ==================== UTIL ====================
function listAuthFiles() {
  const files = [];
  if (!fs.existsSync(AUTH_DIR)) return files;

  const walk = (dir) => {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) walk(full);
      else files.push(path.relative(AUTH_DIR, full).replace(/\\/g, '/'));
    }
  };
  walk(AUTH_DIR);
  return files;
}

// ==================== SUPABASE SYNC ====================
async function downloadAuthFromSupabase() {
  console.log('⬇️ Restaurando sesión desde Supabase...');
  const { data, error } = await supabase
    .from('wa_session_files')
    .select('file_name, file_b64');

  if (error) {
    console.error('❌ Error Supabase restore:', error);
    return;
  }

  if (!data || data.length === 0) {
    console.log('ℹ️ No hay sesión guardada en Supabase');
    return;
  }

  for (const row of data) {
    const filePath = path.join(AUTH_DIR, row.file_name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(row.file_b64, 'base64'));
  }

  console.log('✅ Sesión restaurada. Archivos:', listAuthFiles());
}

async function uploadAuthToSupabase() {
  const files = listAuthFiles();
  if (files.length === 0) {
    console.warn('⚠️ No hay archivos para subir a Supabase');
    return;
  }

  const payload = files.map(f => ({
    file_name: f,
    file_b64: fs.readFileSync(path.join(AUTH_DIR, f)).toString('base64')
  }));

  const { error } = await supabase
    .from('wa_session_files')
    .upsert(payload, { onConflict: ['file_name'] });

  if (error) console.error('❌ Error subiendo sesión:', error);
  else console.log(`✅ Sesión subida a Supabase (${files.length} archivos)`);
}

// ==================== WHATSAPP CLIENT ====================
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'moderator-bot',
    dataPath: AUTH_DIR
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote'
    ]
  }
});

let lastQr = null;
let clientReady = false;

// ==================== PROCESS ERRORS ====================
process.on('unhandledRejection', r => console.error('unhandledRejection:', r));
process.on('uncaughtException', e => console.error('uncaughtException:', e));

// ==================== CLIENT EVENTS ====================
client.on('qr', qr => {
  lastQr = qr;
  clientReady = false;
  console.log('⚠️ NUEVO QR GENERADO');
  qrcodeTerminal.generate(qr, { small: true });
});

client.on('authenticated', async () => {
  console.log('🔐 AUTENTICADO');
  console.log('📂 Archivos auth:', listAuthFiles());
  await uploadAuthToSupabase(); // CLAVE
});

client.on('auth_failure', msg => {
  console.error('❌ AUTH FAILURE:', msg);
});

client.on('ready', async () => {
  clientReady = true;
  lastQr = null;
  console.log('🚀 BOT LISTO Y CONECTADO');

  const chats = await client.getChats();
  console.log(`📱 Chats cargados: ${chats.length}`);

  await uploadAuthToSupabase();
});

client.on('change_state', state => {
  console.log('🔄 STATE CHANGED:', state);
});

client.on('disconnected', reason => {
  console.error('🔌 CLIENT DISCONNECTED:', reason);
});

// ==================== MENSAJES ====================
client.on('message_create', async msg => {
  console.log(`📨 ${msg.from} | ${msg.type} | ${msg.body?.slice(0, 80)}`);
});

// ==================== CRON ====================
cron.schedule('0 * * * *', async () => {
  if (!clientReady || !GROUP_ID) return;
  try {
    const chat = await client.getChatById(GROUP_ID);
    const msg = AUTO_MESSAGES[Math.floor(Math.random() * AUTO_MESSAGES.length)];
    await chat.sendMessage(msg);
  } catch (e) {
    console.error('❌ Cron error:', e.message);
  }
});

// ==================== WEB ====================
app.get('/', (req, res) => {
  res.send(`
    <h1>Bot Guardián</h1>
    <p>Estado: ${clientReady ? '✅ CONECTADO' : '⏳ CONECTANDO'}</p>
    <a href="/qr">Ver QR</a>
  `);
});

app.get('/qr', async (req, res) => {
  if (!lastQr) {
    return res.send('<meta http-equiv="refresh" content="5">Esperando QR...');
  }
  const dataUrl = await QRCode.toDataURL(lastQr);
  res.send(`
    <h2>Escanea con WhatsApp (APP móvil)</h2>
    <img src="${dataUrl}" style="width:300px"/>
  `);
});

app.get('/chats', async (req, res) => {
  if (!clientReady) return res.status(400).send('Cliente no listo');
  const chats = await client.getChats();
  res.json(chats.map(c => ({
    id: c.id._serialized,
    name: c.name,
    isGroup: c.isGroup
  })));
});

// ==================== START ====================
(async () => {
  await downloadAuthFromSupabase();
  client.initialize();
  app.listen(PORT, () => {
    console.log(`🌐 Servidor activo en puerto ${PORT}`);
  });

  // Chequeo forzado de estado
  setTimeout(async () => {
    try {
      const state = await client.getState();
      console.log('📡 ESTADO CLIENTE:', state);
    } catch (e) {
      console.error('❌ No se pudo obtener estado:', e.message);
    }
  }, 20000);
})();
