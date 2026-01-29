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

const app = express();
const POSTS_FILE = path.join(__dirname, 'posts.json');
const WARN_FILE  = path.join(__dirname, 'warnings.json');

let lastQr = null;

// --- INICIALIZACIÓN DE ARCHIVOS ---
fs.ensureFileSync(POSTS_FILE);
fs.ensureFileSync(WARN_FILE);
if (!fs.readJsonSync(POSTS_FILE, { throws:false })) fs.writeJsonSync(POSTS_FILE, []);
if (!fs.readJsonSync(WARN_FILE,  { throws:false })) fs.writeJsonSync(WARN_FILE, {});

// --- CONFIGURACIÓN DE BASE DE DATOS (POSTGRESQL) ---
const USE_DB = !!process.env.DATABASE_URL;
let pool = null;
if (USE_DB) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  (async ()=>{
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY, message TEXT NOT NULL, cron_spec TEXT, active BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT now()
      );`);
      await pool.query(`CREATE TABLE IF NOT EXISTS warnings (
        id SERIAL PRIMARY KEY, user_id TEXT UNIQUE, warns INTEGER DEFAULT 0, updated_at TIMESTAMP DEFAULT now()
      );`);
      console.log('✅ Base de datos PostgreSQL conectada y tablas listas');
    } catch(e){ console.error('❌ Error DB init:', e); }
  })();
}

// --- FUNCIONES DE PERSISTENCIA ---
async function loadPosts() {
  if (USE_DB) {
    const res = await pool.query('SELECT id, message, cron_spec, active FROM posts ORDER BY id DESC;');
    return res.rows;
  }
  return fs.readJson(POSTS_FILE);
}

async function savePost(post) {
  if (USE_DB) {
    const res = await pool.query('INSERT INTO posts(message, cron_spec, active) VALUES($1,$2,$3) RETURNING *',
      [post.message, post.cron_spec||null, post.active||true]);
    return res.rows[0];
  }
  const arr = await fs.readJson(POSTS_FILE);
  post.id = (arr[0] ? arr[0].id+1 : 1);
  arr.unshift(post);
  await fs.writeJson(POSTS_FILE, arr, { spaces:2 });
  return post;
}

// --- CONFIGURACIÓN DEL CLIENTE WHATSAPP ---
const MAX_WARNINGS = parseInt(process.env.MAX_WARNINGS||'3');
const GROUP_ID = process.env.GROUP_ID || '';

const client = new Client({
  authStrategy: new LocalAuth({ clientId: "moderator-bot" }),
  puppeteer: {
    headless: true,
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  }
});

client.on('qr', (qr) => {
  lastQr = qr;
  qrcodeTerminal.generate(qr, { small: true });
  console.log('[QR] Nuevo código generado. Míralo en: /qr');
});

client.on('ready', () => {
  lastQr = null;
  console.log('✅ Bot de WhatsApp activo y guardián funcionando');
});

// --- LÓGICA DE MODERACIÓN (GUARDÍAN) ---
function isLink(text) {
  return /https?:\/\/|www\.[^\s]+/i.test(text);
}

client.on('message_create', async msg => {
  try {
    // Solo actuar en grupos y si no es un mensaje propio
    if (!msg.from.endsWith('@g.us') || msg.fromMe) return;

    const body = msg.body || (msg.hasMedia && msg.caption) || '';
    if (!isLink(body)) return;

    const senderId = msg.author || msg.from;
    const chat = await msg.getChat();

    // 1. Borrar el mensaje inmediatamente
    try { await msg.delete(true); } catch(e) { console.warn('No pude borrar el mensaje. ¿Soy admin?'); }

    // 2. Gestionar advertencias
    let warnCount = 0;
    if (USE_DB) {
      await pool.query('INSERT INTO warnings(user_id, warns) VALUES($1,1) ON CONFLICT (user_id) DO UPDATE SET warns = warnings.warns + 1, updated_at = now()', [senderId]);
      const res = await pool.query('SELECT warns FROM warnings WHERE user_id=$1', [senderId]);
      warnCount = res.rows[0].warns;
    } else {
      const warnings = await fs.readJson(WARN_FILE);
      const key = senderId.replace(/[^0-9]/g, '');
      warnings[key] = (warnings[key]||0) + 1;
      await fs.writeJson(WARN_FILE, warnings, { spaces:2 });
      warnCount = warnings[key];
    }

    // 3. Notificar y expulsar
    const contact = await client.getContactById(senderId).catch(()=>null);
    await chat.sendMessage(`⚠️ @${senderId.split('@')[0]} ¡Prohibido enviar enlaces! Advertencia ${warnCount}/${MAX_WARNINGS}`, { mentions: contact ? [contact] : [] });

    if (warnCount >= MAX_WARNINGS) {
      try {
        await chat.removeParticipants([senderId]);
        await chat.sendMessage(`🚫 @${senderId.split('@')[0]} ha sido expulsado por ignorar las reglas.`, { mentions: contact ? [contact] : [] });
        // Limpiar advertencias tras expulsión
        if (USE_DB) await pool.query('DELETE FROM warnings WHERE user_id=$1', [senderId]);
      } catch(e) { console.error('Error al intentar expulsar:', e.message); }
    }
  } catch (err) { console.error('Error en moderación:', err); }
});

// --- SERVIDOR EXPRESS Y ADMIN UI ---
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ver QR desde navegador
app.get('/qr', async (req, res) => {
  if (!lastQr) return res.send('<h3>El QR no está disponible. Revisa si el bot ya está conectado.</h3>');
  res.setHeader('Content-Type', 'image/png');
  await QRCode.toFileStream(res, lastQr);
});

// API para gestión de posts
app.get('/api/posts', async (req,res) => res.json(await loadPosts()));
app.post('/api/posts', async (req,res) => {
  const { message, cron_spec } = req.body;
  const post = await savePost({ message, cron_spec, active: true });
  if (cron_spec) schedulePost(post.id, cron_spec);
  res.json(post);
});

// --- PLANIFICADOR DE POSTS (CRON) ---
const scheduledTasks = {};
function schedulePost(id, cronSpec) {
  if (scheduledTasks[id]) { scheduledTasks[id].stop(); delete scheduledTasks[id]; }
  
  scheduledTasks[id] = cron.schedule(cronSpec, async () => {
    try {
      if (!GROUP_ID) return console.log('⚠️ Error: No hay GROUP_ID configurado para el post automático.');
      const posts = await loadPosts();
      const post = posts.find(p => p.id === id);
      if (post && post.active) {
        const chat = await client.getChatById(GROUP_ID);
        await chat.sendMessage(post.message);
        console.log(`[AUTO-POST] Enviado id: ${id}`);
      }
    } catch(e) { console.warn('Fallo en post programado:', e.message); }
  });
}

// Iniciar cron jobs al arrancar
(async () => {
  const posts = await loadPosts();
  posts.forEach(p => { if (p.cron_spec && p.active) schedulePost(p.id, p.cron_spec); });
})();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Admin UI en puerto ${PORT}`));

client.initialize();
