const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const path = require('path');
const cron = require('node-cron');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { Pool } = require('pg');
const puppeteer = require('puppeteer');

const POSTS_FILE = path.join(__dirname, 'posts.json');
const WARN_FILE  = path.join(__dirname, 'warnings.json');

// Asegurar existencia de archivos JSON
fs.ensureFileSync(POSTS_FILE);
fs.ensureFileSync(WARN_FILE);
if (!fs.readJsonSync(POSTS_FILE, { throws:false })) fs.writeJsonSync(POSTS_FILE, []);
if (!fs.readJsonSync(WARN_FILE,  { throws:false })) fs.writeJsonSync(WARN_FILE, {});

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
    } catch(e){ console.error('Error inicializando DB:', e); }
  })();
}

// Funciones de carga/guardado
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

const MAX_WARNINGS = parseInt(process.env.MAX_WARNINGS||'3');
const GROUP_ID = process.env.GROUP_ID || '';

// Inicialización del Cliente con Puppeteer optimizado para Docker
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "moderator-bot" }),
  puppeteer: {
    headless: true,
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  }
});

client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
  console.log('[QR] Escanea el código para vincular el bot');
});

client.on('ready', () => console.log('✅ Cliente de WhatsApp listo'));

function isLink(text) {
  if (!text) return false;
  return /https?:\/\/|www\.[^\s]+/i.test(text);
}

// Lógica de Moderación
client.on('message_create', async msg => {
  try {
    if (!msg.from.endsWith('@g.us') || msg.fromMe) return;

    const senderId = msg.author || msg.from;
    const body = msg.body || (msg.hasMedia && msg.caption) || '';
    if (!isLink(body)) return;

    // Intentar borrar mensaje
    try { await msg.delete(true); } catch(e) { console.warn('No se pudo borrar:', e.message); }

    // Manejo de advertencias
    let warnCount = 0;
    if (USE_DB) {
      await pool.query('INSERT INTO warnings(user_id, warns) VALUES($1,1) ON CONFLICT (user_id) DO UPDATE SET warns = warnings.warns + 1, updated_at = now()', [senderId]);
      const res = await pool.query('SELECT warns FROM warnings WHERE user_id=$1', [senderId]);
      warnCount = res.rows[0].warns;
    } else {
      const warnings = await fs.readJson(WARN_FILE);
      const key = senderId.replace(/@c\.us|@s\.whatsapp\.net/g,'');
      warnings[key] = (warnings[key]||0) + 1;
      await fs.writeJson(WARN_FILE, warnings, { spaces:2 });
      warnCount = warnings[key];
    }

    const chat = await msg.getChat();
    const contact = await client.getContactById(senderId).catch(()=>null);

    await chat.sendMessage(`⚠️ @${senderId.split('@')[0]} — Enlace detectado (${warnCount}/${MAX_WARNINGS}).`, { mentions: contact ? [contact] : [] });

    if (warnCount >= MAX_WARNINGS) {
      try {
        await chat.removeParticipants([senderId]);
        await chat.sendMessage(`🚫 @${senderId.split('@')[0]} expulsado por exceso de advertencias.`, { mentions: contact ? [contact] : [] });
        if (USE_DB) await pool.query('DELETE FROM warnings WHERE user_id=$1', [senderId]);
      } catch(e) { console.warn('Error al expulsar:', e.message); }
    }
  } catch (err) { console.error('Error en moderación:', err); }
});

// Servidor Express
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/posts', async (req,res) => res.json(await loadPosts()));
app.post('/api/posts', async (req,res) => {
  const { message, cron_spec } = req.body;
  if (!message) return res.status(400).json({ error:'message required' });
  const post = await savePost({ message, cron_spec, active: true });
  if (cron_spec) schedulePost(post.id, cron_spec);
  res.json(post);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Admin UI en puerto ${PORT}`));

// Planificador
const scheduled = {};
function schedulePost(id, cronSpec) {
  if (scheduled[id]) { scheduled[id].stop(); delete scheduled[id]; }
  scheduled[id] = cron.schedule(cronSpec, async () => {
    try {
      const posts = await loadPosts();
      const post = posts.find(p => p.id === id);
      if (post && post.active && GROUP_ID) {
        const chat = await client.getChatById(GROUP_ID);
        await chat.sendMessage(post.message);
      }
    } catch(e) { console.warn('Error en post programado:', e.message); }
  });
}

client.initialize();
