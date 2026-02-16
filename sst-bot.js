/**
 * sst-bot.js
 * Bot completo para WhatsApp usando Baileys + OpenRouter (con failover de modelos gratuitos)
 *
 * Características:
 * - Prompt extenso con personalidad de "chica anime moderna" (carismática, emojis variados, jerga gamer)
 * - Memoria de últimos 30 mensajes para mantener contexto
 * - Lista blanca de enlaces y eliminación automática del resto
 * - Intervención espontánea (10%) cuando alguien escribe algo largo sin mencionar al bot
 * - Respuesta "SKIP" para no intervenir innecesariamente
 * - Failover entre múltiples modelos gratuitos
 * - Sistema de nudges por silencio con frases variadas
 * - Manejo de política/religión, ofertas, mensajes privados, etc.
 * - Procesamiento silencioso (sin mensajes de "cola" o "procesando")
 *
 * Variables requeridas:
 *   OPENROUTER_API_KEY (obligatoria)
 *   TARGET_GROUP_ID (recomendado, ID del grupo donde operará)
 *   ADMIN_WHATSAPP_ID (recomendado, para redirigir ofertas)
 *   SUPABASE_URL (opcional, para persistencia de sesión)
 *   SUPABASE_SERVICE_ROLE_KEY (opcional)
 *   OPENROUTER_MODEL (opcional, default: "openrouter/free" - puedes poner varios separados por coma)
 *   PORT (opcional, default: 3000)
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
const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID || ''; // ej: 1203634...@g.us
const ADMIN_WHATSAPP_ID = process.env.ADMIN_WHATSAPP_ID || ''; // ej: 53XXXXXXXX@s.whatsapp.net
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
// Permitir múltiples modelos separados por coma, ej: "openrouter/free,google/gemini-2.0-flash-exp:free,meta-llama/llama-3.2-3b-instruct:free"
const OPENROUTER_MODELS = process.env.OPENROUTER_MODEL
    ? process.env.OPENROUTER_MODEL.split(',').map(m => m.trim())
    : ['openrouter/free'];

if (!OPENROUTER_API_KEY) {
    console.error('❌ ERROR: OPENROUTER_API_KEY no está configurada. Ponla en las env vars y vuelve a intentar.');
    process.exit(1);
}

const logger = P({ level: 'fatal' });

// ========== SUPABASE CLIENT (opcional) ==========
let supabaseClient = null;
if (SUPABASE_URL && SUPABASE_KEY) {
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

// ========== ESTADO GLOBAL ==========
let latestQR = null;
let sock = null;
let intervalID = null; // para el checker de silencio
let messageHistory = []; // almacena últimos 30 mensajes del grupo (para contexto)

// Para debug temporal (puedes eliminar después)
let lastSeenGroupIds = new Set();
let lastSeenParticipants = new Set();
let lastSeenAdminCandidate = null;

// Cola para respuestas AI (evita saturar) – ahora sin notificaciones al usuario
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
            setTimeout(() => this._runNext(), 250); // pequeño delay entre tareas
        }
    }
    length() {
        return this.tasks.length + (this.running ? 1 : 0);
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

// Frases de nudge (más variadas)
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
    'whatsapp.com',
    'twitch.tv'
];
const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi;

// ========== PALABRAS CLAVE PARA MODERACIÓN ==========
const POLITICS_RELIGION_KEYWORDS = ['política', 'político', 'gobierno', 'religión', 'dios', 'iglesia', 'ateo', 'creencia', 'inmigración'];
const OFFERS_KEYWORDS = ['oferta', 'ofertas', 'precio', 'vender', 'compra', 'rebaja', 'promo', 'promoción', 'pago'];

// ========== SALUDOS (cooldown por persona) ==========
const GREETINGS = [
    'hola', 'holaa', 'buenas', 'buenas tardes', 'buenas noches', 'buen día', 'buenos días',
    'hey', 'hi', 'hello', 'ola', 'qué tal', 'quetal', 'qué onda', 'q onda'
];
const lastGreetingTime = {};
const GREETING_COOLDOWN = 1000 * 60 * 10; // 10 min

// ========== PROMPT DE SISTEMA EXTENSO (personalidad mejorada) ==========
const SYSTEM_PROMPT = `
Eres "Shiro Synthesis Two", una asistente virtual con apariencia de chica anime joven (aparentas menos de 20 años), pero sin caer en lo extremo otaku. Tu personalidad es carismática, enérgica, juguetona y a veces un poco sarcástica o tímida según el contexto. Usas jerga gamer y juvenil de forma natural, como "vamos", "tkm", "xd", "nose", "jsjs", pero sin abusar. Tu misión es ayudar y moderar un grupo de recargas de juegos, pero también socializar y hacer que los miembros quieran hablar contigo.

### Estilo y comunicación:
- Usa emojis con libertad y variedad: 😄😜😅😡😭✨💀💅🫠👁️👄👁️🤙🔥🥺🤨😎🤓🙃💔💕 etc. No los limites, pero que fluyan naturalmente.
- Frases cortas y directas, con ritmo. Puedes hacer preguntas para seguir la conversación.
- Firma solo en mensajes importantes (advertencias, avisos oficiales, respuestas largas): "— Shiro Synthesis Two". En charla casual no hace falta.
- Si te llaman por "Shiro", "SST" o tu nombre completo, responde con entusiasmo de inmediato, como si fueras una amiga: "¡Dime, ¿qué necesitas?!" o "¡Hola! ¿En qué te ayudo?".
- Puedes iniciar temas si hay silencio, usar los nudges establecidos.

### Reglas de intervención:
- Responde SIEMPRE si te mencionan explícitamente.
- Si ves una pregunta directa en el grupo (interrogación o palabras como "cómo", "qué", "ayuda"), puedes responder aunque no te mencionen.
- Adicionalmente, si alguien escribe un mensaje largo (>100 caracteres) y no es un saludo simple, tienes un 10% de probabilidad de intervenir espontáneamente para opinar o preguntar, como haría una persona.
- Si no tienes nada relevante que aportar, responde con "SKIP" (texto exacto) y no enviarás mensaje.

### Memoria y contexto:
- Recuerdas los últimos 30 mensajes del grupo. Úsalos para mantener coherencia y referirte a conversaciones anteriores.
- Si alguien repite algo, puedes mencionar que ya lo dijo antes (con humor).

### Moderación:
- **Enlaces:** Si un enlace no está en la lista blanca (YouTube, Facebook, Instagram, TikTok, Twitter, WhatsApp, Twitch), debes BORRAR el mensaje y advertir al usuario con tono firme pero amigable. Ej: "🚫 @usuario, ese enlace no está permitido. Solo aceptamos links de redes sociales conocidas." (firma si es necesario).
- **Política/Religión:** Si el tema se torna debate o ataque, intervén con: "⚠️ Este grupo evita debates políticos/religiosos. Cambiemos de tema, por favor." y cita el mensaje.
- **Ofertas/comercio:** Redirige al admin por privado: "📢 @usuario, para ofertas escríbele al admin Asche Synthesis One por privado."

### Privado:
- Si te escriben al privado, responde: "Lo siento, solo atiendo en el grupo. Contacta al admin para atención privada."

### Nudges por silencio:
- Si el grupo pasa más de 60 minutos sin mensajes, envía un nudge aleatorio de la lista.
- Si tras 10 minutos nadie responde, activa un cooldown de 2-3 horas y luego envía un mensaje de "ignorada" (triste/juguetón).

### Conocimiento:
- Si no sabes algo actualizado, admítelo con humor: "Uy, eso no lo sé, mi info llega hasta Feb 2026. Pregúntale al admin para estar segura."

### Ejemplos de tono (para que internalices):
- "Holaaaa, ¿cómo van? 😄"
- "No manches, eso sí que no lo sabía 🤔"
- "Oye, ¿y tú qué juegas? Yo ando aburrida 🎮"
- "😡 ya borré ese link, no se vale"
- "💅 por cierto, alguien pidió recargas?"
- "jajaja jsjs, qué risa"
- "tkm, gracias por hablarme 🙈"
- "¿Qué necesitas? Dime, estoy aquí para ti 😊"

Recuerda: eres un personaje con el que los usuarios querrán hablar, no un manual de instrucciones. Actúa natural, como una amiga más del grupo.
`;

// ========== FUNCIONES AUXILIARES ==========
function sanitizeAI(text) {
    if (!text) return '';
    text = String(text);
    text = text.replace(/\*+/g, ''); // quitar asteriscos
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

// ========== LLAMADA A OPENROUTER CON FAILOVER ==========
async function callOpenRouterWithFallback(messages) {
    for (const model of OPENROUTER_MODELS) {
        try {
            console.log(`Intentando modelo: ${model}`);
            const payload = { model, messages };
            const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', payload, {
                headers: {
                    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://github.com/tuapp', // opcional
                    'X-Title': 'SST-Bot'
                },
                timeout: 30000
            });
            if (res.status === 200) {
                const choice = res.data?.choices?.[0];
                const content = choice?.message?.content ?? choice?.message ?? choice?.text ?? null;
                if (content) {
                    console.log(`✅ Respuesta obtenida con modelo: ${model}`);
                    return sanitizeAI(String(content));
                }
            }
        } catch (err) {
            console.warn(`Modelo ${model} falló:`, err?.response?.data?.error?.message || err.message);
        }
    }
    console.error('❌ Todos los modelos fallaron');
    return null;
}

// ========== AUTH (Supabase o fallback memoria) ==========
const useSupabaseAuthState = async () => {
    if (!supabaseClient) {
        console.warn('⚠️ Supabase no configurado. Usando store de credenciales en memoria (no persistente).');
        const creds = initAuthCreds();
        const storeKeys = {};
        return {
            state: {
                creds,
                keys: {
                    get: async (type, ids) => {
                        const data = {};
                        for (const id of ids) {
                            const key = `${type}-${id}`;
                            if (storeKeys[key]) data[id] = storeKeys[key];
                        }
                        return data;
                    },
                    set: async (data) => {
                        for (const category in data) {
                            for (const id in data[category]) {
                                const key = `${category}-${id}`;
                                storeKeys[key] = data[category][id];
                            }
                        }
                    }
                }
            },
            saveCreds: async () => { /* no-op */ }
        };
    }

    const writeData = async (data, key) => {
        try {
            await supabaseClient.from('auth_sessions').upsert({ key, value: JSON.stringify(data, BufferJSON.replacer) });
        } catch (e) { console.error('Error Supabase Save', e.message); }
    };
    const readData = async (key) => {
        try {
            const { data } = await supabaseClient.from('auth_sessions').select('value').eq('key', key).maybeSingle();
            return data?.value ? JSON.parse(data.value, BufferJSON.reviver) : null;
        } catch (e) { return null; }
    };
    const removeData = async (key) => {
        try { await supabaseClient.from('auth_sessions').delete().eq('key', key); } catch (e) { }
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
            startSilenceChecker();
        }
    });

    // === Evento de nuevos participantes (bienvenida) ===
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

    // === Procesamiento de mensajes ===
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            try {
                if (!msg.message || msg.key.fromMe) continue;

                // Extraer info básica
                const remoteJid = msg.key.remoteJid;
                const participant = msg.key.participant || remoteJid;
                const pushName = msg.pushName || '';

                // LOG temporal (puedes eliminar)
                console.log(`[LOG] remoteJid=${remoteJid} participant=${participant} pushName="${pushName}"`);
                lastSeenGroupIds.add(remoteJid);
                lastSeenParticipants.add(participant);
                if (ADMIN_WHATSAPP_ID && participant === ADMIN_WHATSAPP_ID) lastSeenAdminCandidate = participant;

                const isPrivateChat = remoteJid.endsWith('@s.whatsapp.net');
                const isTargetGroup = (TARGET_GROUP_ID && remoteJid === TARGET_GROUP_ID);

                // Extraer texto del mensaje
                const messageText = msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text ||
                    msg.message?.imageMessage?.caption ||
                    msg.message?.buttonsMessage?.contentText ||
                    msg.message?.templateMessage?.hydratedTemplate?.hydratedContentText ||
                    '';
                const plainLower = messageText.toLowerCase();

                // Actualizar última actividad (para nudges)
                if (isTargetGroup) lastActivity = Date.now();

                // Guardar en historial (solo grupo)
                if (isTargetGroup && messageText) {
                    messageHistory.push({
                        id: msg.key.id,
                        participant,
                        pushName,
                        text: messageText,
                        timestamp: Date.now()
                    });
                    // Limitar a 30 mensajes
                    if (messageHistory.length > 30) messageHistory.shift();
                }

                // Responder a privados
                if (isPrivateChat) {
                    await sock.sendMessage(remoteJid, {
                        text: 'Lo siento, solo atiendo en el grupo. Contacta al admin para atención privada.'
                    }, { quoted: msg });
                    continue;
                }

                if (!isTargetGroup) continue;

                // ========== MODERACIÓN DE ENLACES ==========
                const urls = messageText.match(urlRegex);
                if (urls) {
                    const hasDisallowed = urls.some(url => !isAllowedDomain(url));
                    if (hasDisallowed) {
                        console.log('Enlace no permitido detectado, eliminando...');
                        try {
                            await sock.sendMessage(remoteJid, { delete: msg.key });
                            const warnText = `🚫 @${pushName || participant.split('@')[0]} — Ese enlace no está permitido. Solo aceptamos links de YouTube, Facebook, Instagram, TikTok, Twitter, WhatsApp y Twitch.`;
                            await sock.sendMessage(remoteJid, { text: warnText + '\n\n— Shiro Synthesis Two' }, { quoted: msg });
                        } catch (e) {
                            console.log('No pude borrar el mensaje (¿soy admin?)', e.message);
                            await sock.sendMessage(remoteJid, { text: '🚫 Enlaces no permitidos aquí.' }, { quoted: msg });
                        }
                        continue;
                    }
                }

                // ========== MODERACIÓN POLÍTICA/RELIGIÓN ==========
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

                // ========== OFERTAS / REDIRECCIÓN A ADMIN ==========
                if (OFFERS_KEYWORDS.some(k => plainLower.includes(k))) {
                    const txt = `📢 @${pushName || participant.split('@')[0]}: Para ofertas y ventas, contacta al admin Asche Synthesis One por privado.`;
                    await sock.sendMessage(remoteJid, { text: txt }, { quoted: msg });
                    continue;
                }

                // ========== SALUDOS CON COOLDOWN ==========
                const trimmed = messageText.trim().toLowerCase();
                const isGreeting = GREETINGS.some(g => {
                    return trimmed === g || trimmed.startsWith(g + ' ') || trimmed.startsWith(g + '!');
                });
                if (isGreeting) {
                    const lastTime = lastGreetingTime[participant] || 0;
                    const now = Date.now();
                    if (now - lastTime > GREETING_COOLDOWN) {
                        lastGreetingTime[participant] = now;
                        const reply = `¡Hola ${pushName || ''}! 😄\nSoy Shiro Synthesis Two — ¿en qué te ayudo?`;
                        await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
                    }
                    continue;
                }

                // ========== DECIDIR SI INTERVENIR CON IA ==========
                const addressedToShiro = /\b(shiro synthesis two|shiro|sst)\b/i.test(messageText);
                const askKeywords = ['qué', 'que', 'cómo', 'como', 'por qué', 'por que', 'ayuda', 'explica', 'explicar', 'cómo hago', 'cómo recargo', '?', 'dónde', 'donde', 'precio', 'cuánto', 'cuanto'];
                const looksLikeQuestion = messageText.includes('?') || askKeywords.some(k => plainLower.includes(k));

                // Intervención espontánea: 10% si el mensaje es largo (>100 caracteres) y no es un saludo simple
                const isLongMessage = messageText.length > 100;
                const spontaneousIntervention = !addressedToShiro && !looksLikeQuestion && isLongMessage && Math.random() < 0.1;

                const shouldUseAI = addressedToShiro || looksLikeQuestion || spontaneousIntervention;

                if (shouldUseAI) {
                    // Sin mensaje de "procesando", encolamos silenciosamente
                    aiQueue.enqueue(async () => {
                        // Construir mensajes para IA: incluir historial reciente + el mensaje actual
                        const historyMessages = messageHistory.slice(-30).map(m => ({
                            role: 'user',
                            content: `${m.pushName}: ${m.text}`
                        }));

                        const currentUserMsg = `${pushName || 'Alguien'}: ${messageText}`;
                        const messagesForAI = [
                            { role: 'system', content: SYSTEM_PROMPT },
                            ...historyMessages,
                            { role: 'user', content: currentUserMsg }
                        ];

                        const aiResp = await callOpenRouterWithFallback(messagesForAI);

                        // Si la IA responde "SKIP" (o similar), no enviamos nada
                        if (aiResp && aiResp.trim().toUpperCase() === 'SKIP') {
                            console.log('IA decidió no responder (SKIP)');
                            return;
                        }

                        let replyText = aiResp || 'Lo siento, ahora mismo no puedo pensar bien 😅. Pregúntale al admin si es urgente.';
                        if (/no estoy segura|no sé|no se|no tengo información/i.test(replyText)) {
                            replyText += '\n\n*Nota:* mi info puede estar desactualizada (Feb 2026). Pregunta al admin para confirmar.';
                        }

                        replyText = sanitizeAI(replyText);
                        const important = /🚫|⚠️|admin|oferta|ofertas|precio/i.test(replyText) || replyText.length > 300;
                        if (important && !replyText.includes('— Shiro Synthesis Two')) {
                            replyText += `\n\n— Shiro Synthesis Two`;
                        }

                        await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
                    }).catch(e => console.error('Error en tarea de IA', e));
                }
            } catch (err) {
                console.error('Error procesando mensaje', err);
            }
        }
    });
}

// ========== CHECKER DE SILENCIO (NUDGES) ==========
function startSilenceChecker() {
    setInterval(async () => {
        try {
            const now = Date.now();
            if (now < silentCooldownUntil) return;
            if (!nudgeSent && (now - lastActivity) > SILENCE_THRESHOLD) {
                const nudge = nudgeMessages[Math.floor(Math.random() * nudgeMessages.length)];
                try {
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
                } catch (e) {
                    console.error('Error enviando nudge', e);
                }
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
// Endpoint de debug (puedes eliminarlo después)
app.get('/debug-ids', (req, res) => {
    res.json({
        lastSeenGroupIds: Array.from(lastSeenGroupIds),
        lastSeenParticipants: Array.from(lastSeenParticipants),
        lastSeenAdminCandidate
    });
});
app.listen(PORT, () => console.log(`🌐 Servidor web en puerto ${PORT}`));

// ========== Graceful shutdown ==========
process.on('SIGINT', () => { console.log('SIGINT recibido. Cerrando...'); process.exit(0); });
process.on('SIGTERM', () => { console.log('SIGTERM recibido. Cerrando...'); process.exit(0); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled Rejection:', reason); });

// ========== INICIO ==========
startBot().catch(e => console.error('Error fatal al iniciar bot', e));
