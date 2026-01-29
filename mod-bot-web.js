// mod-bot-web.js
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const path = require('path');
const cron = require('node-cron');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { Pool } = require('pg');

const POSTS_FILE = path.join(__dirname, 'posts.json');
const WARN_FILE  = path.join(__dirname, 'warnings.json');
fs.ensureFileSync(POSTS_FILE);
fs.ensureFileSync(WARN_FILE);
if (!fs.readJsonSync(POSTS_FILE, { throws:false })) fs.writeJsonSync(POSTS_FILE, []);
if (!fs.readJsonSync(WARN_FILE,  { throws:false })) fs.writeJsonSync(WARN_FILE, {});

const USE_DB = !!process.env.DATABASE_URL;
let pool = null;
if (USE_DB) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  (async ()=>{
    await pool.query(`CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      message TEXT NOT NULL,
      cron_spec TEXT,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT now()
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS warnings (
      id SERIAL PRIMARY KEY,
      user_id TEXT UNIQUE,
      warns INTEGER DEFAULT 0,
      updated_at TIMESTAMP DEFAULT now()
    );`);
  })().catch(e=>console.error('DB init error', e));
}

async function loadPosts() {
  if (USE_DB) {
    const res = await pool.query('SELECT id, message, cron_spec, active FROM posts ORDER BY id DESC;');
    return res.rows;
  } else {
    return fs.readJson(POSTS_FILE);
  }
}
async function savePost(post) {
  if (USE_DB) {
    const res = await pool.query('INSERT INTO posts(message, cron_spec, active) VALUES($1,$2,$3) RETURNING *',
      [post.message, post.cron_spec||null, post.active||true]);
    return res.rows[0];
  } else {
    const arr = await fs.readJson(POSTS_FILE);
    post.id = (arr[0] ? arr[0].id+1 : 1);
    arr.unshift(post);
    await fs.writeJson(POSTS_FILE, arr, { spaces:2 });
    return post;
  }
}

const MAX_WARNINGS = parseInt(process.env.MAX_WARNINGS||'3');
const GROUP_ID = process.env.GROUP_ID || '';

const client = new Client({
  authStrategy: new LocalAuth({ clientId: "moderator-bot" }),
  puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] }
});

client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
  console.log('[QR] Escanea el QR (logs) para vincular el bot');
});
client.on('ready', ()=>console.log('✅ WhatsApp client listo'));

function isLink(text) {
  if (!text) return false;
  const re = /https?:\/\/|www\.[^\s]+/i;
  return re.test(text);
}

// Moderation logic with debug to help get GROUP_ID
client.on('message_create', async msg=>{
  try {
    const chat = await msg.getChat().catch(()=>null);
    // DEBUG line to get GROUP_ID - dejar mientras obtienes el id
    console.log('MSG DEBUG -> from:', msg.from, ' author:', msg.author, ' chatId:', chat ? (chat.id && chat.id._serialized ? chat.id._serialized : 'no-serialized') : 'no-chat', ' chatName:', chat ? chat.name : 'no-name');

    if (!msg.from.endsWith('@g.us')) return;
    if (msg.fromMe) return;
    const senderId = msg.author || msg.from;
    const body = msg.body || (msg.hasMedia && msg.caption) || '';
    if (!isLink(body)) return;

    try { await msg.delete(true); console.log('Mensaje eliminado con intento "for everyone".'); } catch(e){ console.warn('No se pudo borrar:', e.message||e); }

    // warnings storage (DB or file)
    if (USE_DB) {
      const u = await pool.query('SELECT warns FROM warnings WHERE user_id=$1', [senderId]);
      if (u.rowCount===0) {
        await pool.query('INSERT INTO warnings(user_id, warns) VALUES($1,1)', [senderId]);
      } else {
        let warns = u.rows[0].warns + 1;
        await pool.query('UPDATE warnings SET warns=$1, updated_at=now() WHERE user_id=$2', [warns, senderId]);
      }
    } else {
      const warnings = await fs.readJson(WARN_FILE);
      const key = senderId.replace(/@c\.us|@s\.whatsapp\.net/g,'');
      warnings[key] = (warnings[key]||0)+1;
      await fs.writeJson(WARN_FILE, warnings, { spaces:2 });
    }

    const contact = await client.getContactById(senderId).catch(()=>null);
    try { await (await msg.getChat()).sendMessage(`⚠️ @${senderId.split('@')[0]} — Enlace detectado. Advertencia.`, { mentions: contact ? [contact] : [] }); } catch(e){}

    try { if (contact) await contact.sendMessage(`Has sido advertido por enviar enlaces. Reglas del grupo.`); } catch(e){}

    // get warn count
    let warnCount = 0;
    if (USE_DB) {
      const r = await pool.query('SELECT warns FROM warnings WHERE user_id=$1',[senderId]);
      if (r.rowCount) warnCount = r.rows[0].warns;
    } else {
      const warnings = await fs.readJson(WARN_FILE);
      warnCount = warnings[senderId.replace(/@c\.us|@s\.whatsapp\.net/g,'')];
    }

    if (warnCount >= MAX_WARNINGS) {
      try {
        await (await msg.getChat()).removeParticipants([senderId]);
        await (await msg.getChat()).sendMessage(`@${senderId.split('@')[0]} expulsado por exceder advertencias.`, { mentions: contact ? [contact] : [] });
        if (USE_DB) await pool.query('DELETE FROM warnings WHERE user_id=$1',[senderId]);
        else { const warnings = await fs.readJson(WARN_FILE); delete warnings[senderId.replace(/@c\.us|@s\.whatsapp\.net/g,'')]; await fs.writeJson(WARN_FILE,warnings,{spaces:2}); }
      } catch(e){ console.warn('No pude expulsar:', e.message||e); }
    }

  } catch (err) { console.error('Error moderación:', err); }
});

// Express admin + endpoints
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/posts', async (req,res)=> res.json(await loadPosts()));
app.post('/api/posts', async (req,res)=>{
  const { message, cron_spec } = req.body;
  if (!message) return res.status(400).json({ error:'message required' });
  const post = await savePost({ message, cron_spec, active: true });
  if (cron_spec) schedulePost(post.id, cron_spec);
  res.json(post);
});
app.post('/api/publish/:id', async (req,res)=>{
  const id = parseInt(req.params.id);
  const posts = await loadPosts();
  const post = posts.find(p => p.id === id) || (USE_DB ? (await pool.query('SELECT * FROM posts WHERE id=$1',[id])).rows[0] : null);
  if (!post) return res.status(404).json({ error:'post not found' });
  if (!GROUP_ID) return res.status(400).json({ error:'GROUP_ID not configured' });
  const chat = await client.getChatById(GROUP_ID).catch(()=>null);
  if (!chat) return res.status(404).json({ error:'group not found' });
  await chat.sendMessage(post.message);
  res.json({ ok:true });
});
app.get('/admin', (req,res) => res.sendFile(path.join(__dirname,'public','admin.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`Admin UI up on port ${PORT}`));

// scheduler
const scheduled = {};
function schedulePost(id, cronSpec) {
  if (scheduled[id]) { scheduled[id].stop(); delete scheduled[id]; }
  scheduled[id] = cron.schedule(cronSpec, async ()=> {
    console.log('Publicando programado:', id);
    try { await (await client.getChatById(GROUP_ID)).sendMessage((await loadPosts()).find(p=>p.id===id).message); }
    catch(e){ console.warn('Falló post programado:', e.message||e); }
  });
}
(async ()=>{
  const posts = await loadPosts();
  posts.forEach(p => { if (p.cron_spec) schedulePost(p.id, p.cron_spec); });
})();

client.initialize();
