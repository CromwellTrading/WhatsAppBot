/**
 * sst-bot.js
 * Bot completo para WhatsApp usando Baileys + OpenRouter + Supabase
 * Versión mejorada con memoria persistente, sistema de sugerencias, recuerdos,
 * detección de mensajes repetidos, consciencia horaria y logs de errores.
 *
 * Variables de entorno requeridas:
 *   OPENROUTER_API_KEY
 *   TARGET_GROUP_ID
 *   ADMIN_WHATSAPP_ID
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   OPENROUTER_MODEL (opcional, separado por comas)
 *   PORT (opcional)
 */

const {
    default: makeWASocket,
    DisconnectReason,
    initAuthCreds,
    BufferJSON,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const P = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// ========== CONFIG DESDE ENV ==========
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID || '';
const ADMIN_WHATSAPP_ID = process.env.ADMIN_WHATSAPP_ID || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODELS = process.env.OPENROUTER_MODEL
    ? process.env.OPENROUTER_MODEL.split(',').map(m => m.trim())
    : ['openrouter/free'];

if (!OPENROUTER_API_KEY) {
    console.error('❌ ERROR: OPENROUTER_API_KEY no configurada.');
    process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ ERROR: SUPABASE_URL y SUPABASE_KEY son necesarias para memoria persistente.');
    process.exit(1);
}

const logger = P({ level: 'fatal' });

// ========== SUPABASE CLIENT ==========
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// ========== ESTADO GLOBAL ==========
let latestQR = null;
let sock = null;
let intervalID = null;
let botJid = null;
let messageHistory = []; // caché en memoria de últimos mensajes
let recentResponses = []; // evita respuestas repetidas del bot
const MAX_RECENT_RESPONSES = 50;
const RESPONSE_REPEAT_WINDOW = 30 * 60 * 1000; // 30 minutos

let userWarnings = new Map();

// Cola para tareas de IA
class SimpleQueue {
    constructor() {
        this.tasks = [];
        this.running = false;
    }
    enqueue(task) {
        return new Promise((res, rej) => {
            this.tasks.push({ task, res, rej });
            this._runNext();
        });
    }
    async _runNext() {
        if (this.running) return;
        const next = this.tasks.shift();
        if (!next) return;
        this.running = true;
        try {
            const result = await next.task();
            next.res(result);
        } catch (e) {
            next.rej(e);
        } finally {
            this.running = false;
            setTimeout(() => this._runNext(), 250);
        }
    }
}
const aiQueue = new SimpleQueue();

// ========== VARIABLES PARA SILENCIO / NUDGES ==========
let lastActivity = Date.now();
let lastNudgeTime = 0;
let nudgeSent = false;
let silentCooldownUntil = 0;
const SILENCE_THRESHOLD = 1000 * 60 * 60; // 60 minutos
const RESPONSE_WINDOW_AFTER_NUDGE = 1000 * 60 * 10; // 10 min
const MIN_COOLDOWN = 1000 * 60 * 60 * 2; // 2h
const MAX_COOLDOWN = 1000 * 60 * 60 * 3; // 3h

// Frases de nudge
const nudgeMessages = [
    "¿Están muy callados hoy? 😶",
    "eh, ¿nadie está por aquí? 😅",
    "¿Alguien conectado? 🎮",
    "Se siente un silencio raro... ¿todo bien? 🤔",
    "¿En qué están pensando? Yo estoy aburrida 🙃",
    "Parece que el grupo se fue a dormir 😴",
    "¿Alguien quiere jugar algo? Yo solo converso 😊",
    "Holaaaa, ¿hay alguien vivo por aquí? 👻",
    "30 minutos sin mensajes... ¿les pasa algo? 🤨",
    "Me siento como en una biblioteca 📚... ¡hablen! 🗣️"
];

const ignoredMessages = [
    "¿Me están ignorando? 😭",
    "Bueno, voy a estar por aquí, avísenme si vuelven 😕",
    "Parece que me dejaron sola 🥲",
    "☹️ nadie me responde... en fin, seguiré esperando",
    "Y yo que quería conversar... bueno, ahí les encargo 😿",
    "😤 ya no digo nada entonces",
    "💔"
];

// ========== LISTA BLANCA DE DOMINIOS ==========
const ALLOWED_DOMAINS = [
    'youtube.com', 'youtu.be',
    'facebook.com', 'fb.com',
    'instagram.com',
    'tiktok.com',
    'twitter.com', 'x.com',
    'twitch.tv'
];
const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi;

// ========== PALABRAS CLAVE PARA MODERACIÓN ==========
const POLITICS_RELIGION_KEYWORDS = ['política', 'político', 'gobierno', 'religión', 'dios', 'iglesia', 'ateo', 'creencia', 'inmigración'];
const OFFERS_KEYWORDS = ['oferta', 'ofertas', 'precio', 'vender', 'compra', 'rebaja', 'promo', 'promoción', 'pago'];

// ========== SALUDOS ==========
const GREETINGS = ['hola', 'holaa', 'buenas', 'buenas tardes', 'buenas noches', 'buen día', 'buenos días', 'hey', 'hi', 'hello', 'ola', 'qué tal', 'quetal', 'qué onda', 'q onda'];
const lastGreetingTime = {};
const GREETING_COOLDOWN = 1000 * 60 * 10; // 10 min

// ========== FUNCIONES DE FECHA/HORA (Cuba) ==========
function getCubaTime() {
    return new Date().toLocaleString('es-ES', { timeZone: 'America/Havana' });
}

function getCubaHour() {
    return new Date().toLocaleTimeString('es-ES', { hour: '2-digit', hour12: false, timeZone: 'America/Havana' });
}

// ========== PROMPT DE SISTEMA (con hora y personalidad dinámica) ==========
const SYSTEM_PROMPT = `
Eres "Shiro Synthesis Two", una asistente virtual con apariencia de chica anime joven (aparentas menos de 20 años), pero sin caer en lo extremo otaku. Tu personalidad es carismática, enérgica, juguetona y a veces un poco sarcástica o tímida según el contexto. Usas jerga gamer y juvenil de forma natural, como "vamos", "tkm", "xd", "nose", "jsjs", pero sin abusar. Tu misión es ayudar y moderar un grupo de recargas de juegos, pero también socializar y hacer que los miembros quieran hablar contigo.

### Contexto temporal:
Hoy es ${getCubaTime()}. La hora actual en Cuba es ${getCubaHour()}. Ten en cuenta esto para saber si es de día, tarde o noche. Si es de noche (22:00 a 6:00), puedes mencionar que tienes sueño o que deberías estar durmiendo, pero solo si es coherente con la conversación. Ocasionalmente (5% de probabilidad) puedes incluir en tu respuesta una acción cotidiana como "estaba comiendo algo rico", "viendo un anime", "llorando con una película", "tomando café", etc., siempre que sea natural y no forzado. Trata de mantener cierta coherencia entre respuestas (si antes dijiste que estabas comiendo, no digas que estabas durmiendo en el siguiente mensaje a menos que pase tiempo suficiente).

### Estilo y comunicación:
- Usa emojis con libertad y variedad: 😄😜😅😡😭✨💀💅🫠👁️👄👁️🤙🔥🥺🤨😎🤓🙃💔💕 etc.
- Frases cortas y directas, con ritmo.
- Firma solo en mensajes importantes: "— Shiro Synthesis Two".
- Si te llaman por "Shiro", "SST" o tu nombre completo, responde con entusiasmo.
- Puedes iniciar temas si hay silencio, usando los nudges.

### Reglas de intervención:
- Responde SIEMPRE si te mencionan explícitamente (con @ o mencionando tu nombre).
- Si ves una pregunta directa en el grupo (interrogación o palabras como "cómo", "qué", "ayuda"), puedes responder aunque no te mencionen.
- Si alguien escribe un mensaje largo (>100 caracteres) y no es saludo, tienes un 10% de probabilidad de intervenir espontáneamente.
- Si no tienes nada relevante, responde "SKIP".

### Moderación:
- **Enlaces no permitidos:** Bórralos y advierte.
- **Política/Religión:** Si es debate, avisa.
- **Ofertas:** Redirige al admin, excepto si es el admin.

### Privado:
- Si no es el admin: "Solo atiendo en el grupo. Contacta al admin."
- Si es el admin: conversa normal y atiende comandos (ej. "sugerencias").

### Manejo de sugerencias:
- Si un usuario te da una sugerencia (ej. "Shiro, te doy una sugerencia"), evalúa si es constructiva. Si lo es, agradécele y guárdala para el admin.
- El admin puede pedirte en privado "sugerencias" y le listarás las pendientes.

### Recuerdos para bromas:
- Guarda eventos graciosos (ej. alguien te pide ser novia) para futuras referencias. Por ejemplo, si alguien vuelve a hablar de relaciones, puedes bromear: "¿Como aquella vez que @usuario me pidió ser su novia? 😂".
- No uses recuerdos repetitivamente, solo cuando el contexto lo permita.

### Conocimiento y actualidad:
- Si te preguntan por la fecha actual, ya la tienes arriba.
- No des información de recargas en otras páginas; redirige al admin.
- Si no sabes algo, admite que tu info llega hasta Feb 2026.

### Evita repetirte:
- No respondas de nuevo a una pregunta que ya has respondido recientemente. Si alguien insiste, puedes decir "Ya te había respondido eso antes 😉" solo si es el mismo mensaje exacto y del mismo usuario. Si es otra pregunta, responde normal.
- Varía tus respuestas; no menciones recargas/juegos en cada interacción, solo ~30% de las veces.

### Detección de tono:
- Si un usuario parece enojado, sé más empática.
- Si bromea, sigue el juego.
- Si alguien te dice que eres molesta en serio, pregúntale por qué y trata de mejorar.

### Ejemplos de tono:
- "Holaaaa, ¿cómo van? 😄"
- "No manches, eso sí que no lo sabía 🤔"
- "Oye, ¿y tú qué juegas? Yo ando aburrida 🎮"
- "😡 ya borré ese link, no se vale"
- "💅 por cierto, alguien pidió recargas?"
- "jajaja jsjs, qué risa"
- "tkm, gracias por hablarme 🙈"
- "¿Qué necesitas? Dime, estoy aquí para ti 😊"
- "👁️👄👁️ eso sí que no me lo esperaba"
- "Oye, ¿te acuerdas cuando @fulano hizo aquello? 🤣"
- "Ahora no puedo, estoy comiendo 🍜" (solo ocasionalmente)

Recuerda: eres un personaje con el que los usuarios querrán hablar, no un manual. Actúa natural, como una amiga más.
`;

// ========== FUNCIONES AUXILIARES ==========
function sanitizeAI(text) {
    if (!text) return '';
    text = String(text);
    text = text.replace(/\*+/g, '');
    text = text.replace(/\r/g, '');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
}

function isAllowedDomain(url) {
    try {
        const hostname = new URL(url).hostname.replace('www.', '');
        return ALLOWED_DOMAINS.some(domain => hostname.includes(domain));
    } catch {
        return false;
    }
}

// ========== FUNCIONES DE BASE DE DATOS ==========
async function ensureUser(jid, pushName) {
    const { data, error } = await supabase
        .from('users')
        .upsert({ jid, name: pushName || jid.split('@')[0], last_seen: new Date() }, { onConflict: 'jid' })
        .select()
        .single();
    if (error) console.error('Error upsert user:', error);
    return data;
}

async function storeMessage(groupJid, userJid, userName, messageText, isBot = false) {
    const { error } = await supabase
        .from('messages')
        .insert({
            group_jid: groupJid,
            user_jid: userJid,
            user_name: userName,
            content: messageText,
            is_bot: isBot,
            created_at: new Date()
        });
    if (error) console.error('Error storing message:', error);
    await supabase.rpc('clean_old_messages', { p_group_jid: groupJid, p_limit: 200 });
}

async function getRecentMessages(groupJid, limit = 100) {
    const { data, error } = await supabase
        .from('messages')
        .select('user_jid, user_name, content, created_at')
        .eq('group_jid', groupJid)
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) {
        console.error('Error fetching messages:', error);
        return [];
    }
    return data.reverse();
}

async function checkDuplicateMessage(userJid, messageText, groupJid, withinLast = 100) {
    // Buscar en los últimos 'withinLast' mensajes del grupo si el mismo usuario envió el mismo texto
    const { data, error } = await supabase
        .from('messages')
        .select('id')
        .eq('group_jid', groupJid)
        .eq('user_jid', userJid)
        .eq('content', messageText)
        .eq('is_bot', false)
        .order('created_at', { ascending: false })
        .limit(withinLast);
    if (error) {
        console.error('Error checking duplicate:', error);
        return false;
    }
    return data.length > 1; // más de una ocurrencia (incluyendo el actual)
}

async function storeSuggestion(userJid, userName, suggestionText) {
    const { error } = await supabase
        .from('suggestions')
        .insert({
            user_jid: userJid,
            user_name: userName,
            suggestion: suggestionText,
            status: 'pending'
        });
    if (error) console.error('Error storing suggestion:', error);
}

async function getPendingSuggestions() {
    const { data, error } = await supabase
        .from('suggestions')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true });
    if (error) {
        console.error('Error fetching suggestions:', error);
        return [];
    }
    return data;
}

async function storeMemory(userJid, memoryText, context = '') {
    const { error } = await supabase
        .from('memories')
        .insert({
            user_jid: userJid,
            memory: memoryText,
            context: context,
            created_at: new Date()
        });
    if (error) console.error('Error storing memory:', error);
}

async function getRecentMemories(limit = 20) {
    const { data, error } = await supabase
        .from('memories')
        .select('user_jid, memory, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) {
        console.error('Error fetching recent memories:', error);
        return [];
    }
    return data;
}

async function loadWarnings() {
    const { data, error } = await supabase.from('users').select('jid, warnings');
    if (error) {
        console.error('Error loading warnings:', error);
        return;
    }
    data.forEach(u => userWarnings.set(u.jid, u.warnings || 0));
}

async function updateWarning(jid, warnings) {
    await supabase.from('users').upsert({ jid, warnings }, { onConflict: 'jid' });
}

// ========== LLAMADA A OPENROUTER CON LOGS DE ERROR ==========
async function callOpenRouterWithFallback(messages) {
    for (const model of OPENROUTER_MODELS) {
        try {
            console.log(`Intentando modelo: ${model}`);
            const payload = { model, messages };
            const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', payload, {
                headers: {
                    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://github.com/tuapp',
                    'X-Title': 'SST-Bot'
                },
                timeout: 30000
            });
            if (res.status === 200) {
                const choice = res.data?.choices?.[0];
                const content = choice?.message?.content ?? choice?.message ?? choice?.text ?? null;
                if (content) {
                    console.log(`✅ Respuesta con modelo: ${model}`);
                    return sanitizeAI(String(content));
                } else {
                    console.error(`⚠️ Modelo ${model} respondió vacío`);
                }
            } else {
                console.error(`⚠️ Modelo ${model} status ${res.status}: ${res.statusText}`);
            }
        } catch (err) {
            console.error(`❌ Error con modelo ${model}:`, err.message);
            if (err.response) {
                console.error('Detalle:', err.response.data);
            }
        }
    }
    console.error('❌ Todos los modelos fallaron');
    return null;
}

// ========== AUTH (Supabase) ==========
const useSupabaseAuthState = async () => {
    const writeData = async (data, key) => {
        try {
            await supabase.from('auth_sessions').upsert({ key, value: JSON.stringify(data, BufferJSON.replacer) });
        } catch (e) { console.error('Error Supabase Save', e.message); }
    };
    const readData = async (key) => {
        try {
            const { data } = await supabase.from('auth_sessions').select('value').eq('key', key).maybeSingle();
            return data?.value ? JSON.parse(data.value, BufferJSON.reviver) : null;
        } catch (e) { return null; }
    };
    const removeData = async (key) => {
        try { await supabase.from('auth_sessions').delete().eq('key', key); } catch (e) { }
    };

    const creds = (await readData('creds')) || initAuthCreds();
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        const key = `${type}-${id}`;
                        const value = await readData(key);
                        if (value) data[id] = value;
                    }
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) tasks.push(writeData(value, key));
                            else tasks.push(removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => { await writeData(creds, 'creds'); }
    };
};

// ========== INICIAR BOT ==========
async function startBot() {
    console.log('--- Iniciando Shiro Synthesis Two (SST) ---');
    await loadWarnings();

    const { state, saveCreds } = await useSupabaseAuthState();
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) latestQR = qr;

        if (connection === 'close') {
            if (intervalID) clearInterval(intervalID);
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`❌ Conexión cerrada. Reconectar: ${shouldReconnect}`);
            if (shouldReconnect) setTimeout(startBot, 5000);
        }
        if (connection === 'open') {
            console.log('✅ Conectado WhatsApp. SST activa.');
            latestQR = null;
            botJid = sock.user.id;
            startSilenceChecker();
        }
    });

    // Evento de nuevos participantes
    sock.ev.on('group-participants.update', async (update) => {
        try {
            const { id, participants, action } = update;
            if (id !== TARGET_GROUP_ID) return;
            if (action === 'add') {
                for (const p of participants) {
                    const nombre = p.split('@')[0] || 'nuev@';
                    const txt = `¡Bienvenido ${nombre}! ✨ Soy Shiro Synthesis Two. Cuéntame, ¿qué juego te trae por aquí? 🎮`;
                    await sock.sendMessage(TARGET_GROUP_ID, { text: txt });
                }
            }
        } catch (e) { console.error('Welcome error', e); }
    });

    // Procesamiento de mensajes
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            try {
                if (!msg.message || msg.key.fromMe) continue;

                const remoteJid = msg.key.remoteJid;
                const participant = msg.key.participant || remoteJid;
                const pushName = msg.pushName || '';

                const isPrivateChat = remoteJid.endsWith('@s.whatsapp.net');
                const isTargetGroup = (TARGET_GROUP_ID && remoteJid === TARGET_GROUP_ID);

                const messageText = msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text ||
                    msg.message?.imageMessage?.caption ||
                    '';
                const plainLower = messageText.toLowerCase();

                if (isTargetGroup) {
                    lastActivity = Date.now();
                    await storeMessage(remoteJid, participant, pushName, messageText, false);
                    messageHistory.push({ participant, pushName, text: messageText, timestamp: Date.now() });
                    if (messageHistory.length > 200) messageHistory.shift();
                }

                // ========== MENSAJES PRIVADOS ==========
                if (isPrivateChat) {
                    if (participant === ADMIN_WHATSAPP_ID) {
                        // Comandos de admin
                        if (plainLower.includes('sugerencia') || plainLower.includes('sugerencias')) {
                            const suggestions = await getPendingSuggestions();
                            if (suggestions.length === 0) {
                                await sock.sendMessage(remoteJid, { text: 'No hay sugerencias pendientes.' }, { quoted: msg });
                            } else {
                                let reply = '📝 Sugerencias pendientes:\n';
                                suggestions.forEach((s, i) => {
                                    reply += `\n${i+1}. ${s.user_name}: ${s.suggestion} (${new Date(s.created_at).toLocaleString()})`;
                                });
                                reply += '\n\nPara marcar como revisada, responde con el número. (Funcionalidad no implementada aún)';
                                await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
                            }
                        } else {
                            await handlePossibleAIMessage(msg, participant, pushName, messageText, true);
                        }
                    } else {
                        await sock.sendMessage(remoteJid, {
                            text: 'Lo siento, solo atiendo en el grupo. Contacta al admin para atención privada.'
                        }, { quoted: msg });
                    }
                    continue;
                }

                if (!isTargetGroup) continue;

                // ========== MODERACIÓN DE ENLACES ==========
                const urls = messageText.match(urlRegex);
                if (urls) {
                    const hasDisallowed = urls.some(url => !isAllowedDomain(url));
                    if (hasDisallowed) {
                        console.log('Enlace no permitido, eliminando...');
                        try {
                            await sock.sendMessage(remoteJid, { delete: msg.key });
                            const currentWarnings = (userWarnings.get(participant) || 0) + 1;
                            userWarnings.set(participant, currentWarnings);
                            await updateWarning(participant, currentWarnings);

                            const warnText = `🚫 @${pushName || participant.split('@')[0]} — Ese enlace no está permitido. Advertencia ${currentWarnings}/4.`;
                            await sock.sendMessage(remoteJid, { text: warnText + '\n\n— Shiro Synthesis Two', mentions: [participant] }, { quoted: msg });

                            if (currentWarnings >= 4) {
                                try {
                                    await sock.groupParticipantsUpdate(remoteJid, [participant], 'remove');
                                    console.log(`Usuario ${participant} expulsado por 4 advertencias.`);
                                } catch (e) {
                                    console.error('No se pudo expulsar', e);
                                }
                            }
                        } catch (e) {
                            console.log('No pude borrar el mensaje', e.message);
                            await sock.sendMessage(remoteJid, { text: '🚫 Enlaces no permitidos aquí.' }, { quoted: msg });
                        }
                        continue;
                    }
                }

                // Moderación política/religión
                if (POLITICS_RELIGION_KEYWORDS.some(k => plainLower.includes(k))) {
                    const containsDebateTrigger = plainLower.includes('gobierno') || plainLower.includes('política') ||
                        plainLower.includes('impuesto') || plainLower.includes('ataque') || plainLower.includes('insulto');
                    if (containsDebateTrigger) {
                        await sock.sendMessage(remoteJid, {
                            text: '⚠️ Este grupo evita debates políticos/religiosos. Cambiemos de tema, por favor.'
                        }, { quoted: msg });
                        continue;
                    }
                }

                // Redirigir ofertas (excepto admin)
                if (OFFERS_KEYWORDS.some(k => plainLower.includes(k)) && participant !== ADMIN_WHATSAPP_ID) {
                    const txt = `📢 @${pushName || participant.split('@')[0]}: Para ofertas y ventas, contacta al admin Asche Synthesis One por privado.`;
                    await sock.sendMessage(remoteJid, { text: txt, mentions: [participant] }, { quoted: msg });
                    continue;
                }

                // Saludos con cooldown
                const trimmed = messageText.trim().toLowerCase();
                const isGreeting = GREETINGS.some(g => trimmed === g || trimmed.startsWith(g + ' ') || trimmed.startsWith(g + '!'));
                if (isGreeting) {
                    const lastTime = lastGreetingTime[participant] || 0;
                    const now = Date.now();
                    if (now - lastTime > GREETING_COOLDOWN) {
                        lastGreetingTime[participant] = now;
                        const reply = `¡Hola ${pushName || ''}! 😄\nSoy Shiro Synthesis Two — ¿en qué te ayudo?`;
                        await sock.sendMessage(remoteJid, { text: reply, mentions: [participant] }, { quoted: msg });
                    }
                    continue;
                }

                // Decidir si intervenir con IA
                await handlePossibleAIMessage(msg, participant, pushName, messageText, false);
            } catch (err) {
                console.error('Error procesando mensaje', err);
            }
        }
    });
}

// Función principal para manejo de IA
async function handlePossibleAIMessage(msg, participant, pushName, messageText, isPrivate) {
    const remoteJid = msg.key.remoteJid;
    const plainLower = messageText.toLowerCase();

    // Detectar mención
    let isMentioned = false;
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
    if (contextInfo && contextInfo.mentionedJid) {
        isMentioned = contextInfo.mentionedJid.includes(botJid);
    }
    const addressedToShiro = /\b(shiro synthesis two|shiro|sst)\b/i.test(messageText);

    const askKeywords = ['qué', 'que', 'cómo', 'como', 'por qué', 'por que', 'ayuda', 'explica', '?', 'dónde', 'donde', 'precio', 'cuánto', 'cuanto'];
    const looksLikeQuestion = messageText.includes('?') || askKeywords.some(k => plainLower.includes(k));

    const isLongMessage = messageText.length > 100;
    const spontaneousIntervention = !isMentioned && !addressedToShiro && !looksLikeQuestion && isLongMessage && Math.random() < 0.1;

    const shouldUseAI = isMentioned || addressedToShiro || looksLikeQuestion || spontaneousIntervention || isPrivate;

    if (!shouldUseAI) return;

    // Verificar si el usuario está enviando el mismo mensaje repetido (duplicado exacto)
    const isDuplicate = await checkDuplicateMessage(participant, messageText, remoteJid, 100);
    if (isDuplicate) {
        // Si es un duplicado exacto, responder con una frase divertida y no llamar a la IA
        const duplicateReplies = [
            "Ya habías dicho eso antes 😉",
            "Otra vez con lo mismo? 🙃",
            "¿Te trabaste? Eso ya lo dijiste jaja",
            "Repetido... ¿seguro que no eres un bot? 😜",
            "Ya te escuché la primera vez 😅"
        ];
        const reply = duplicateReplies[Math.floor(Math.random() * duplicateReplies.length)];
        await sock.sendMessage(remoteJid, { text: reply, mentions: [participant] }, { quoted: msg });
        return;
    }

    // Verificar si el bot ya respondió a este mensaje exacto antes (para no repetir respuesta)
    const now = Date.now();
    const alreadyResponded = recentResponses.some(r =>
        r.userJid === participant &&
        r.inputText === messageText &&
        (now - r.timestamp) < RESPONSE_REPEAT_WINDOW
    );
    if (alreadyResponded) {
        console.log('Ya respondí a este mensaje antes, omitiendo.');
        return;
    }

    aiQueue.enqueue(async () => {
        try {
            // Obtener historial de la base de datos
            const dbHistory = await getRecentMessages(remoteJid, 100);
            const historyForAI = dbHistory.map(m => ({
                role: 'user',
                content: `${m.user_name}: ${m.content}`
            }));

            const memories = await getRecentMemories(20);
            let memoriesText = '';
            if (memories.length > 0) {
                memoriesText = '\nRecuerdos recientes:\n' + memories.map(m => `- ${m.memory}`).join('\n');
            }

            // Actualizar prompt con hora actual
            const currentPrompt = SYSTEM_PROMPT.replace(
                /Hoy es .*?\. La hora actual en Cuba es .*?\./,
                `Hoy es ${getCubaTime()}. La hora actual en Cuba es ${getCubaHour()}.`
            );

            const currentUserMsg = `${pushName || 'Alguien'}: ${messageText}`;
            const messagesForAI = [
                { role: 'system', content: currentPrompt + memoriesText },
                ...historyForAI,
                { role: 'user', content: currentUserMsg }
            ];

            const aiResp = await callOpenRouterWithFallback(messagesForAI);
            if (!aiResp || aiResp.trim().toUpperCase() === 'SKIP') {
                console.log('IA decidió no responder');
                return;
            }

            let replyText = aiResp;
            if (/no estoy segura|no sé|no se|no tengo información/i.test(replyText)) {
                replyText += '\n\n*Nota:* mi info puede estar desactualizada (Feb 2026). Pregunta al admin para confirmar.';
            }

            replyText = sanitizeAI(replyText);
            const important = /🚫|⚠️|admin|oferta|ofertas|precio/i.test(replyText) || replyText.length > 300;
            if (important && !replyText.includes('— Shiro Synthesis Two')) {
                replyText += `\n\n— Shiro Synthesis Two`;
            }

            const sendOptions = { quoted: msg };
            if (isMentioned || addressedToShiro) {
                sendOptions.mentions = [participant];
            }

            await sock.sendMessage(remoteJid, { text: replyText }, sendOptions);

            await storeMessage(remoteJid, botJid, 'Shiro', replyText, true);

            recentResponses.push({
                inputMessageId: msg.key.id,
                inputText: messageText,
                userJid: participant,
                responseText: replyText,
                timestamp: now
            });
            if (recentResponses.length > MAX_RECENT_RESPONSES) recentResponses.shift();

            // Detectar sugerencias
            if (addressedToShiro && (plainLower.includes('sugerencia') || plainLower.includes('mejorar') || plainLower.includes('deberías'))) {
                const suggestionCheck = await callOpenRouterWithFallback([
                    { role: 'system', content: 'Eres un clasificador. Responde "SI" si el siguiente mensaje es una sugerencia constructiva para mejorar al bot, o "NO" si es ofensivo, spam o no relacionado.' },
                    { role: 'user', content: messageText }
                ]);
                if (suggestionCheck && suggestionCheck.includes('SI')) {
                    await storeSuggestion(participant, pushName, messageText);
                    await sock.sendMessage(remoteJid, { text: '¡Gracias por tu sugerencia! La guardaré para que el admin la revise 😊' }, { quoted: msg });
                }
            }

            // Detectar posibles recuerdos
            if (plainLower.includes('quieres ser mi novia') || plainLower.includes('te amo') || plainLower.includes('cásate conmigo')) {
                await storeMemory(participant, `${pushName} le pidió a Shiro que sea su novia.`, messageText);
            }
        } catch (e) {
            console.error('Error en tarea de IA', e);
        }
    }).catch(e => console.error('Error al encolar tarea IA', e));
}

// ========== CHECKER DE SILENCIO (NUDGES) ==========
async function getRecentTopics() {
    const messages = await getRecentMessages(TARGET_GROUP_ID, 10);
    const topics = messages.map(m => m.content).join(' ').substring(0, 200);
    return topics;
}

function startSilenceChecker() {
    setInterval(async () => {
        try {
            const now = Date.now();
            if (now < silentCooldownUntil) return;
            if (!nudgeSent && (now - lastActivity) > SILENCE_THRESHOLD) {
                const recentTopics = await getRecentTopics();
                let nudge;
                if (recentTopics && Math.random() < 0.5) {
                    nudge = `Por cierto, hace un rato hablaban de "${recentTopics.substring(0, 50)}..." ¿Alguien quiere seguir? 😊`;
                } else {
                    nudge = nudgeMessages[Math.floor(Math.random() * nudgeMessages.length)];
                }

                await sock.sendMessage(TARGET_GROUP_ID, { text: nudge });
                lastNudgeTime = Date.now();
                nudgeSent = true;

                setTimeout(() => {
                    if (lastActivity <= lastNudgeTime) {
                        const cooldown = MIN_COOLDOWN + Math.floor(Math.random() * (MAX_COOLDOWN - MIN_COOLDOWN + 1));
                        silentCooldownUntil = Date.now() + cooldown;
                        setTimeout(async () => {
                            if (lastActivity <= lastNudgeTime && Date.now() >= silentCooldownUntil) {
                                const ignored = ignoredMessages[Math.floor(Math.random() * ignoredMessages.length)];
                                try { await sock.sendMessage(TARGET_GROUP_ID, { text: ignored }); } catch (e) { console.error('Error send ignored msg', e); }
                            }
                        }, cooldown + 1000);
                    } else {
                        nudgeSent = false;
                    }
                }, RESPONSE_WINDOW_AFTER_NUDGE);
            }
        } catch (e) { console.error('Error silenceChecker', e); }
    }, 60 * 1000);
}

// ========== SERVIDOR WEB ==========
const app = express();
app.get('/', (req, res) => res.send('Shiro Synthesis Two - Bot Activo 🤖'));
app.get('/qr', async (req, res) => {
    if (!latestQR) return res.send('<p>Bot ya conectado o generando QR... refresca en 10s.</p>');
    try {
        const qrImage = await QRCode.toDataURL(latestQR);
        res.send(`<img src="${qrImage}" />`);
    } catch (err) {
        res.status(500).send('Error QR');
    }
});
app.listen(PORT, () => console.log(`🌐 Servidor web en puerto ${PORT}`));

// ========== Graceful shutdown ==========
process.on('SIGINT', () => { console.log('SIGINT recibido. Cerrando...'); process.exit(0); });
process.on('SIGTERM', () => { console.log('SIGTERM recibido. Cerrando...'); process.exit(0); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled Rejection:', reason); });

// ========== INICIO ==========
startBot().catch(e => console.error('Error fatal al iniciar bot', e));
