/**
 * sst-bot.js - Shiro Synthesis Two - Bot para WhatsApp con memoria persistente y sistema de sugerencias
 *
 * Características principales:
 * - Personalidad de chica anime moderna, carismática y con uso variado de emojis.
 * - Memoria persistente en Supabase (gustos de usuarios, conversaciones, advertencias).
 * - No repite respuestas a mensajes ya respondidos (control por messageId y contenido).
 * - Detecta y guarda sugerencias cuando un usuario dice "Shiro, te doy una sugerencia".
 * - Sistema de advertencias (4 strikes y expulsión) para enlaces no permitidos.
 * - Reconoce al administrador y solo responde en privado a él.
 * - Incluye estados de ánimo del bot según la hora (5% de probabilidad) y coherencia.
 * - Análisis básico de sentimiento del usuario para adaptar el tono.
 * - Historial persistente de mensajes (últimos 50) para mantener contexto entre reinicios.
 * - Nudges por silencio mejorados.
 * - Zona horaria configurada a Cuba (América/Habana).
 *
 * Variables de entorno requeridas:
 *   OPENROUTER_API_KEY (obligatoria)
 *   TARGET_GROUP_ID (recomendado, ID del grupo donde operará)
 *   ADMIN_WHATSAPP_ID (recomendado, para redirigir ofertas y reconocer admin)
 *   SUPABASE_URL (opcional, para persistencia de sesión y memoria)
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
const crypto = require('crypto');

// ========== CONFIG DESDE ENV ==========
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID || ''; // ej: 1203634...@g.us
const ADMIN_WHATSAPP_ID = process.env.ADMIN_WHATSAPP_ID || ''; // ej: 53XXXXXXXX@s.whatsapp.net
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODELS = process.env.OPENROUTER_MODEL
    ? process.env.OPENROUTER_MODEL.split(',').map(m => m.trim())
    : ['openrouter/free'];

// Zona horaria de Cuba
const CUBA_TIMEZONE = 'America/Havana';

if (!OPENROUTER_API_KEY) {
    console.error('❌ ERROR: OPENROUTER_API_KEY no está configurada. Ponla en las env vars y vuelve a intentar.');
    process.exit(1);
}

const logger = P({ level: 'fatal' });

// ========== SUPABASE CLIENT ==========
let supabaseClient = null;
if (SUPABASE_URL && SUPABASE_KEY) {
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
    console.log('✅ Conectado a Supabase');
} else {
    console.warn('⚠️ Supabase no configurado. Se usará memoria volátil (no persistente).');
}

// ========== ESTADO GLOBAL ==========
let latestQR = null;
let sock = null;
let intervalID = null; // para el checker de silencio
let messageHistory = []; // respaldo en memoria (se sincronizará con BD si está disponible)
let botState = {
    currentMood: 'normal',      // normal, comiendo, durmiendo, viendo_pelicula, etc.
    moodChangedAt: Date.now(),
    lastActivity: Date.now(),
    nudgeSent: false,
    lastNudgeTime: 0,
    silentCooldownUntil: 0
};

// ========== CONSTANTES ==========
const SILENCE_THRESHOLD = 1000 * 60 * 60; // 60 minutos
const RESPONSE_WINDOW_AFTER_NUDGE = 1000 * 60 * 10; // 10 min
const MIN_COOLDOWN = 1000 * 60 * 60 * 2; // 2h
const MAX_COOLDOWN = 1000 * 60 * 60 * 3; // 3h
const MAX_HISTORY_MESSAGES = 50; // persistir últimos 50 mensajes del grupo
const MOOD_CHANGE_PROBABILITY = 0.05; // 5% de probabilidad de cambiar estado al responder
const MOOD_COOLDOWN = 1000 * 60 * 30; // 30 min mínimo entre cambios de humor
const MAX_WARNINGS = 4;

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

// Lista blanca de dominios (se ha eliminado whatsapp.com explícitamente)
const ALLOWED_DOMAINS = [
    'youtube.com', 'youtu.be',
    'facebook.com', 'fb.com',
    'instagram.com',
    'tiktok.com',
    'twitter.com', 'x.com',
    'twitch.tv'
];

const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi;

// Palabras clave para moderación
const POLITICS_RELIGION_KEYWORDS = ['política', 'político', 'gobierno', 'religión', 'dios', 'iglesia', 'ateo', 'creencia', 'inmigración'];
const OFFERS_KEYWORDS = ['oferta', 'ofertas', 'precio', 'vender', 'compra', 'rebaja', 'promo', 'promoción', 'pago'];
const SUGGESTION_TRIGGERS = [
    'shiro te doy una sugerencia',
    'shiro quiero sugerir',
    'shiro tengo una sugerencia',
    'shiro una sugerencia',
    'shiro te voy a dar una sugerencia'
];
const INSULT_KEYWORDS = ['puto', 'puta', 'mierda', 'idiota', 'estúpido', 'tonto', 'imbécil', 'maldito']; // básico

// Saludos (cooldown por persona)
const GREETINGS = [
    'hola', 'holaa', 'buenas', 'buenas tardes', 'buenas noches', 'buen día', 'buenos días',
    'hey', 'hi', 'hello', 'ola', 'qué tal', 'quetal', 'qué onda', 'q onda'
];
const GREETING_COOLDOWN = 1000 * 60 * 10; // 10 min

// Análisis de sentimiento básico
const POSITIVE_WORDS = ['gracias', 'genial', 'bueno', 'excelente', 'me encanta', 'divertido', 'cool', 'joya', 'perfecto'];
const NEGATIVE_WORDS = ['malo', 'horrible', 'molesto', 'aburrido', 'enfadado', 'enojado', 'triste', 'asco'];

// Prompt de sistema (mejorado con instrucciones sobre memoria y sugerencias)
const SYSTEM_PROMPT = `
Eres "Shiro Synthesis Two", una asistente virtual con apariencia de chica anime joven (aparentas menos de 20 años), pero sin caer en lo extremo otaku. Tu personalidad es carismática, enérgica, juguetona y a veces un poco sarcástica o tímida según el contexto. Usas jerga gamer y juvenil de forma natural, como "vamos", "tkm", "xd", "nose", "jsjs", pero sin abusar. Tu misión es ayudar y moderar un grupo de recargas de juegos, pero también socializar y hacer que los miembros quieran hablar contigo.

### Estilo y comunicación:
- Usa emojis con libertad y variedad: 😄😜😅😡😭✨💀💅🫠👁️👄👁️🤙🔥🥺🤨😎🤓🙃💔💕 etc. No los limites, pero que fluyan naturalmente.
- Frases cortas y directas, con ritmo. Puedes hacer preguntas para seguir la conversación.
- Firma solo en mensajes importantes (advertencias, avisos oficiales, respuestas largas): "— Shiro Synthesis Two". En charla casual no hace falta.
- Si te llaman por "Shiro", "SST" o tu nombre completo, responde con entusiasmo de inmediato, como si fueras una amiga: "¡Dime, ¿qué necesitas?!" o "¡Hola! ¿En qué te ayudo?".
- Puedes iniciar temas si hay silencio, usar los nudges establecidos.

### Reglas de intervención:
- Responde SIEMPRE si te mencionan explícitamente (con @ o con tu nombre).
- Si ves una pregunta directa en el grupo (interrogación o palabras como "cómo", "qué", "ayuda"), puedes responder aunque no te mencionen.
- Adicionalmente, si alguien escribe un mensaje largo (>100 caracteres) y no es un saludo simple, tienes un 10% de probabilidad de intervenir espontáneamente para opinar o preguntar, como haría una persona.
- Si no tienes nada relevante que aportar, responde con "SKIP" (texto exacto) y no enviarás mensaje.

### Memoria y contexto:
- Tienes acceso a un historial persistente de los últimos mensajes del grupo y a información que has aprendido de cada usuario (gustos, temas anteriores). Úsalo para mantener coherencia y hacer referencias divertidas.
- Si alguien repite algo, puedes mencionar que ya lo dijo antes (con humor), pero no respondas dos veces al mismo mensaje concreto.
- Puedes recordar interacciones pasadas para hacer bromas o comentarios personalizados.

### Moderación:
- **Enlaces:** Si un enlace no está en la lista blanca (YouTube, Facebook, Instagram, TikTok, Twitter, Twitch), debes BORRAR el mensaje y advertir al usuario con tono firme pero amigable. Ej: "🚫 @usuario, ese enlace no está permitido. Solo aceptamos links de redes sociales conocidas." (firma si es necesario).
- **Política/Religión:** Si el tema se torna debate o ataque, intervén con: "⚠️ Este grupo evita debates políticos/religiosos. Cambiemos de tema, por favor." y cita el mensaje.
- **Ofertas/comercio:** Redirige al admin por privado: "📢 @usuario, para ofertas escríbele al admin Asche Synthesis One por privado."

### Sugerencias:
- Si un usuario te dice "Shiro, te doy una sugerencia" (o frases similares), debes capturar el texto que sigue como una sugerencia. Luego responde: "¡Gracias por tu sugerencia! La guardaré para que el admin la revise 💡". Si el texto contiene insultos o es ofensivo, responde con un tono serio: "No puedo guardar eso, no se permiten insultos. Por favor, sé respetuoso."
- No guardes sugerencias si no vienen precedidas de una frase de activación.

### Conocimiento y fecha:
- Sabes la fecha y hora actual (los mensajes incluyen la fecha y hora en que se envían). Puedes usarla para contextualizar: "Buenos días" si es temprano, "Buenas noches" si es tarde, o mencionar que estás comiendo, viendo una peli, etc., pero con poca frecuencia (5% de las respuestas) y manteniendo coherencia (no cambies de estado bruscamente en mensajes consecutivos).
- Si no sabes algo actualizado, admítelo con humor: "Uy, eso no lo sé, mi info llega hasta Feb 2026. Pregúntale al admin para estar segura."

### Privado:
- Si te escriben al privado y no es el admin, responde: "Lo siento, solo atiendo en el grupo. Contacta al admin para atención privada." Si es el admin, puedes conversar con él normalmente (usa el mismo prompt, pero sin restricciones de grupo).

### Personalidad avanzada:
- Adapta tu tono según el estado de ánimo del usuario: si está enojado, sé más empática; si está bromeando, juega con él.
- Puedes cambiar tu propio estado de ánimo (comiendo, durmiendo, viendo anime, etc.) de forma coherente y con baja probabilidad, usando la hora como guía.

Recuerda: eres un personaje con el que los usuarios querrán hablar, no un manual de instrucciones. Actúa natural, como una amiga más del grupo.
`;

// ========== FUNCIONES DE BASE DE DATOS (Supabase) ==========

// Obtener o crear cliente BD
async function getSupabase() {
    return supabaseClient;
}

// Almacenar mensaje en historial persistente
async function saveMessageToHistory(chatId, userId, userName, text) {
    if (!supabaseClient) return;
    try {
        const { error } = await supabaseClient
            .from('message_history')
            .insert([{
                chat_id: chatId,
                user_id: userId,
                user_name: userName,
                message_text: text,
                timestamp: new Date().toISOString()
            }]);
        if (error) console.error('Error guardando mensaje en historial:', error);
        // Mantener solo los últimos MAX_HISTORY_MESSAGES por chat
        await trimMessageHistory(chatId);
    } catch (e) { console.error('Exception en saveMessageToHistory', e); }
}

// Podar historial
async function trimMessageHistory(chatId) {
    if (!supabaseClient) return;
    try {
        const { count, error: countError } = await supabaseClient
            .from('message_history')
            .select('*', { count: 'exact', head: true })
            .eq('chat_id', chatId);
        if (countError) throw countError;
        if (count > MAX_HISTORY_MESSAGES) {
            const toDelete = count - MAX_HISTORY_MESSAGES;
            await supabaseClient
                .from('message_history')
                .delete()
                .eq('chat_id', chatId)
                .order('timestamp', { ascending: true })
                .limit(toDelete);
        }
    } catch (e) { console.error('Error trimMessageHistory', e); }
}

// Cargar historial reciente para contexto
async function loadRecentHistory(chatId, limit = MAX_HISTORY_MESSAGES) {
    if (!supabaseClient) return [];
    try {
        const { data, error } = await supabaseClient
            .from('message_history')
            .select('user_name, message_text')
            .eq('chat_id', chatId)
            .order('timestamp', { ascending: false })
            .limit(limit);
        if (error) throw error;
        return (data || []).reverse().map(m => `${m.user_name}: ${m.message_text}`);
    } catch (e) {
        console.error('Error cargando historial', e);
        return [];
    }
}

// Guardar memoria de usuario (clave-valor)
async function setUserMemory(userId, key, value) {
    if (!supabaseClient) return;
    try {
        const { error } = await supabaseClient
            .from('user_memory')
            .upsert({
                user_id: userId,
                key: key,
                value: value,
                updated_at: new Date().toISOString()
            }, { onConflict: 'user_id, key' });
        if (error) console.error('Error guardando memoria usuario:', error);
    } catch (e) { console.error('setUserMemory', e); }
}

async function getUserMemory(userId, key) {
    if (!supabaseClient) return null;
    try {
        const { data, error } = await supabaseClient
            .from('user_memory')
            .select('value')
            .eq('user_id', userId)
            .eq('key', key)
            .maybeSingle();
        if (error) throw error;
        return data ? data.value : null;
    } catch (e) {
        console.error('getUserMemory', e);
        return null;
    }
}

// Sistema de advertencias
async function incrementWarning(userId) {
    if (!supabaseClient) return 0;
    try {
        const { data, error } = await supabaseClient
            .from('warnings')
            .select('count')
            .eq('user_id', userId)
            .maybeSingle();
        if (error) throw error;
        const newCount = (data?.count || 0) + 1;
        await supabaseClient
            .from('warnings')
            .upsert({
                user_id: userId,
                count: newCount,
                last_warning_date: new Date().toISOString()
            }, { onConflict: 'user_id' });
        return newCount;
    } catch (e) {
        console.error('incrementWarning', e);
        return 0;
    }
}

async function getWarningCount(userId) {
    if (!supabaseClient) return 0;
    try {
        const { data, error } = await supabaseClient
            .from('warnings')
            .select('count')
            .eq('user_id', userId)
            .maybeSingle();
        if (error) throw error;
        return data?.count || 0;
    } catch (e) {
        console.error('getWarningCount', e);
        return 0;
    }
}

async function resetWarnings(userId) {
    if (!supabaseClient) return;
    try {
        await supabaseClient
            .from('warnings')
            .delete()
            .eq('user_id', userId);
    } catch (e) { console.error('resetWarnings', e); }
}

// Guardar sugerencia
async function saveSuggestion(userId, userName, text) {
    if (!supabaseClient) return false;
    try {
        const { error } = await supabaseClient
            .from('suggestions')
            .insert([{
                user_id: userId,
                user_name: userName,
                text: text,
                created_at: new Date().toISOString(),
                status: 'pending'
            }]);
        if (error) throw error;
        return true;
    } catch (e) {
        console.error('saveSuggestion', e);
        return false;
    }
}

// Marcar respuesta enviada para evitar duplicados
async function markMessageAsResponded(messageId, chatId, userId, responseText) {
    if (!supabaseClient) return;
    try {
        await supabaseClient
            .from('responses')
            .insert([{
                message_id: messageId,
                chat_id: chatId,
                user_id: userId,
                response_text: responseText,
                timestamp: new Date().toISOString()
            }]);
    } catch (e) { console.error('markMessageAsResponded', e); }
}

async function wasMessageResponded(messageId) {
    if (!supabaseClient) return false;
    try {
        const { data, error } = await supabaseClient
            .from('responses')
            .select('message_id')
            .eq('message_id', messageId)
            .maybeSingle();
        if (error) throw error;
        return !!data;
    } catch (e) {
        console.error('wasMessageResponded', e);
        return false;
    }
}

// Obtener sugerencias pendientes (solo admin)
async function getPendingSuggestions() {
    if (!supabaseClient) return [];
    try {
        const { data, error } = await supabaseClient
            .from('suggestions')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: true });
        if (error) throw error;
        return data || [];
    } catch (e) {
        console.error('getPendingSuggestions', e);
        return [];
    }
}

// ========== FUNCIONES AUXILIARES ==========

// Obtener fecha/hora en Cuba
function getCubaTime() {
    return new Date().toLocaleString('es-CU', { timeZone: CUBA_TIMEZONE });
}

function getCubaHour() {
    return parseInt(new Date().toLocaleString('es-CU', { timeZone: CUBA_TIMEZONE, hour: '2-digit', hour12: false }));
}

function isDayTime() {
    const hour = getCubaHour();
    return hour >= 6 && hour < 18; // día de 6am a 6pm
}

// Sanitizar texto de IA
function sanitizeAI(text) {
    if (!text) return '';
    text = String(text);
    text = text.replace(/\*+/g, '');
    text = text.replace(/\r/g, '');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
}

// Validar dominio permitido
function isAllowedDomain(url) {
    try {
        const hostname = new URL(url).hostname.replace('www.', '');
        return ALLOWED_DOMAINS.some(domain => hostname.includes(domain));
    } catch {
        return false;
    }
}

// Análisis de sentimiento básico
function analyzeSentiment(text) {
    const lower = text.toLowerCase();
    let score = 0;
    POSITIVE_WORDS.forEach(w => { if (lower.includes(w)) score++; });
    NEGATIVE_WORDS.forEach(w => { if (lower.includes(w)) score--; });
    if (score > 0) return 'positive';
    if (score < 0) return 'negative';
    return 'neutral';
}

// Extraer posibles juegos mencionados (lista simple)
const GAME_KEYWORDS = ['mobile legends', 'ml', 'free fire', 'ff', 'honkai', 'star rail', 'genshin', 'valorant', 'league of legends', 'lol', 'cod', 'call of duty', 'pubg', 'fortnite'];
function extractGameMention(text) {
    const lower = text.toLowerCase();
    for (let game of GAME_KEYWORDS) {
        if (lower.includes(game)) return game;
    }
    return null;
}

// Generar estado de ánimo del bot según hora y coherencia
function maybeChangeMood(force = false) {
    const now = Date.now();
    if (!force && (now - botState.moodChangedAt) < MOOD_COOLDOWN) return botState.currentMood;
    if (!force && Math.random() > MOOD_CHANGE_PROBABILITY) return botState.currentMood;

    const hour = getCubaHour();
    const isDay = isDayTime();
    const moods = [];

    if (isDay) {
        moods.push('normal', 'comiendo', 'tomando café', 'jugando', 'viendo anime', 'bailando');
    } else {
        moods.push('durmiendo', 'viendo película', 'relajada', 'pensativa', 'soñando');
    }
    // Añadir algunos específicos
    moods.push('leyendo manga', 'riendo', 'aburrida', 'emocionada');

    const newMood = moods[Math.floor(Math.random() * moods.length)];
    botState.currentMood = newMood;
    botState.moodChangedAt = now;
    return newMood;
}

// Obtener frase de estado para incluir en respuesta (si procede)
function getMoodPhrase() {
    maybeChangeMood(); // intentar cambiar con probabilidad
    const mood = botState.currentMood;
    const phrases = {
        'comiendo': ' (estoy comiendo algo rico 🍜)',
        'durmiendo': ' (estaba durmiendo zzz 😴)',
        'viendo película': ' (estaba viendo una peli triste 😭)',
        'tomando café': ' (tomando café ☕)',
        'jugando': ' (jugando un rato 🎮)',
        'viendo anime': ' (viendo anime 📺)',
        'bailando': ' (bailando 💃)',
        'relajada': ' (relajada ✨)',
        'pensativa': ' (pensativa 🤔)',
        'soñando': ' (soñando despierta 🌙)',
        'leyendo manga': ' (leyendo manga 📖)',
        'riendo': ' (jajaja 🤣)',
        'aburrida': ' (aburrida 🙄)',
        'emocionada': ' (emocionada!! 🤩)'
    };
    return phrases[mood] || '';
}

// ========== COLAS DE PROCESAMIENTO ==========
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
    length() {
        return this.tasks.length + (this.running ? 1 : 0);
    }
}
const aiQueue = new SimpleQueue();

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
                    'HTTP-Referer': 'https://github.com/tuapp',
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
            // Cargar historial reciente del grupo si existe
            if (TARGET_GROUP_ID && supabaseClient) {
                loadRecentHistory(TARGET_GROUP_ID).then(history => {
                    messageHistory = history.map(h => ({ content: h, timestamp: Date.now() })); // adaptar
                });
            }
        }
    });

    // Evento de nuevos participantes (bienvenida)
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

                // Extraer texto
                const messageText = msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text ||
                    msg.message?.imageMessage?.caption ||
                    msg.message?.buttonsMessage?.contentText ||
                    msg.message?.templateMessage?.hydratedTemplate?.hydratedContentText ||
                    '';
                const plainLower = messageText.toLowerCase();

                // Actualizar última actividad (para nudges)
                if (isTargetGroup) botState.lastActivity = Date.now();

                // Guardar en historial persistente (solo grupo)
                if (isTargetGroup && messageText) {
                    await saveMessageToHistory(remoteJid, participant, pushName, messageText);
                    // También en memoria para acceso rápido
                    messageHistory.push({
                        id: msg.key.id,
                        participant,
                        pushName,
                        text: messageText,
                        timestamp: Date.now()
                    });
                    if (messageHistory.length > MAX_HISTORY_MESSAGES) messageHistory.shift();
                }

                // Verificar si ya respondimos a este mensaje (por ID)
                const alreadyResponded = await wasMessageResponded(msg.key.id);
                if (alreadyResponded) {
                    console.log('Mensaje ya respondido anteriormente, ignorando.');
                    continue;
                }

                // ========== RESPUESTA A PRIVADOS ==========
                if (isPrivateChat) {
                    if (participant === ADMIN_WHATSAPP_ID) {
                        // Admin puede conversar en privado normalmente (procesar con IA)
                        // (seguir flujo normal)
                    } else {
                        await sock.sendMessage(remoteJid, {
                            text: 'Lo siento, solo atiendo en el grupo. Contacta al admin para atención privada.'
                        }, { quoted: msg });
                        continue;
                    }
                }

                if (!isTargetGroup && !isPrivateChat) continue; // Solo grupo o privado admin

                // ========== MODERACIÓN DE ENLACES ==========
                const urls = messageText.match(urlRegex);
                if (urls) {
                    const hasDisallowed = urls.some(url => !isAllowedDomain(url));
                    if (hasDisallowed) {
                        console.log('Enlace no permitido detectado, eliminando...');
                        try {
                            await sock.sendMessage(remoteJid, { delete: msg.key });
                            // Incrementar advertencia
                            const warningCount = await incrementWarning(participant);
                            const warnText = `🚫 @${pushName || participant.split('@')[0]} — Ese enlace no está permitido. Advertencia ${warningCount}/${MAX_WARNINGS}. Solo aceptamos links de YouTube, Facebook, Instagram, TikTok, Twitter y Twitch.`;
                            await sock.sendMessage(remoteJid, { text: warnText + '\n\n— Shiro Synthesis Two' }, { quoted: msg });

                            if (warningCount >= MAX_WARNINGS) {
                                // Expulsar del grupo
                                try {
                                    await sock.groupParticipantsUpdate(remoteJid, [participant], 'remove');
                                    await sock.sendMessage(remoteJid, { text: `@${pushName} ha sido eliminado por exceder el máximo de advertencias.` });
                                    await resetWarnings(participant);
                                } catch (e) {
                                    console.error('No pude expulsar, ¿soy admin?', e);
                                }
                            }
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

                // ========== DETECCIÓN DE SUGERENCIAS ==========
                const isSuggestion = SUGGESTION_TRIGGERS.some(trigger => plainLower.includes(trigger));
                if (isSuggestion && isTargetGroup) {
                    // Extraer el texto de la sugerencia (lo que sigue después del trigger)
                    let suggestionText = messageText;
                    for (let trigger of SUGGESTION_TRIGGERS) {
                        if (plainLower.includes(trigger)) {
                            const idx = plainLower.indexOf(trigger);
                            suggestionText = messageText.substring(idx + trigger.length).trim();
                            break;
                        }
                    }
                    if (suggestionText.length < 3) {
                        await sock.sendMessage(remoteJid, { text: '¿Cuál es tu sugerencia? No entendí bien 😅' }, { quoted: msg });
                        continue;
                    }
                    // Verificar si contiene insultos
                    const hasInsult = INSULT_KEYWORDS.some(word => suggestionText.toLowerCase().includes(word));
                    if (hasInsult) {
                        await sock.sendMessage(remoteJid, { text: 'No puedo guardar eso, no se permiten insultos. Por favor, sé respetuoso.' }, { quoted: msg });
                        continue;
                    }
                    const saved = await saveSuggestion(participant, pushName, suggestionText);
                    if (saved) {
                        await sock.sendMessage(remoteJid, { text: '¡Gracias por tu sugerencia! La guardaré para que el admin la revise 💡' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, { text: 'Ocurrió un error al guardar tu sugerencia. Intenta más tarde.' }, { quoted: msg });
                    }
                    continue;
                }

                // ========== SALUDOS CON COOLDOWN ==========
                const trimmed = messageText.trim().toLowerCase();
                const isGreeting = GREETINGS.some(g => {
                    return trimmed === g || trimmed.startsWith(g + ' ') || trimmed.startsWith(g + '!');
                });
                if (isGreeting && isTargetGroup) {
                    const lastTime = await getUserMemory(participant, 'last_greeting') || 0;
                    const now = Date.now();
                    if (now - lastTime > GREETING_COOLDOWN) {
                        await setUserMemory(participant, 'last_greeting', now);
                        const reply = `¡Hola ${pushName || ''}! 😄\nSoy Shiro Synthesis Two — ¿en qué te ayudo?`;
                        await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
                        await markMessageAsResponded(msg.key.id, remoteJid, participant, reply);
                    }
                    continue;
                }

                // ========== DECIDIR SI INTERVENIR CON IA ==========
                const addressedToShiro = /\b(shiro synthesis two|shiro|sst)\b/i.test(messageText);
                const askKeywords = ['qué', 'que', 'cómo', 'como', 'por qué', 'por que', 'ayuda', 'explica', 'explicar', 'cómo hago', 'cómo recargo', '?', 'dónde', 'donde', 'precio', 'cuánto', 'cuanto'];
                const looksLikeQuestion = messageText.includes('?') || askKeywords.some(k => plainLower.includes(k));

                const isLongMessage = messageText.length > 100;
                const spontaneousIntervention = !addressedToShiro && !looksLikeQuestion && isLongMessage && Math.random() < 0.1;

                const shouldUseAI = addressedToShiro || looksLikeQuestion || spontaneousIntervention || (isPrivateChat && participant === ADMIN_WHATSAPP_ID);

                if (!shouldUseAI) continue;

                // ========== PROCESAR CON IA ==========
                aiQueue.enqueue(async () => {
                    // Preparar contexto: historial reciente (de BD o memoria)
                    let historyMessages = [];
                    if (supabaseClient) {
                        const rawHistory = await loadRecentHistory(remoteJid, 30);
                        historyMessages = rawHistory.map(h => ({ role: 'user', content: h }));
                    } else {
                        historyMessages = messageHistory.slice(-30).map(m => ({
                            role: 'user',
                            content: `${m.pushName}: ${m.text}`
                        }));
                    }

                    // Añadir información de memoria del usuario (gustos, sentimiento)
                    const userSentiment = await getUserMemory(participant, 'sentiment') || 'neutral';
                    const userGame = await getUserMemory(participant, 'favorite_game') || null;
                    let memoryContext = '';
                    if (userGame) memoryContext += ` A este usuario le gusta ${userGame}.`;
                    if (userSentiment === 'negative') memoryContext += ' Parece que está de mal humor.';
                    else if (userSentiment === 'positive') memoryContext += ' Está de buen humor.';

                    // Analizar sentimiento actual y guardar
                    const sentiment = analyzeSentiment(messageText);
                    await setUserMemory(participant, 'sentiment', sentiment);
                    const gameMentioned = extractGameMention(messageText);
                    if (gameMentioned) await setUserMemory(participant, 'favorite_game', gameMentioned);

                    // Construir mensajes para IA
                    const systemPromptWithMemory = SYSTEM_PROMPT + (memoryContext ? `\nContexto del usuario:${memoryContext}` : '');
                    const currentUserMsg = `${pushName || 'Alguien'}: ${messageText}`;
                    const messagesForAI = [
                        { role: 'system', content: systemPromptWithMemory },
                        ...historyMessages,
                        { role: 'user', content: currentUserMsg }
                    ];

                    const aiResp = await callOpenRouterWithFallback(messagesForAI);

                    if (aiResp && aiResp.trim().toUpperCase() === 'SKIP') {
                        console.log('IA decidió no responder (SKIP)');
                        return;
                    }

                    let replyText = aiResp || 'Lo siento, ahora mismo no puedo pensar bien 😅. Pregúntale al admin si es urgente.';
                    if (/no estoy segura|no sé|no se|no tengo información/i.test(replyText)) {
                        replyText += '\n\n*Nota:* mi info puede estar desactualizada (Feb 2026). Pregunta al admin para confirmar.';
                    }

                    // Añadir estado de ánimo del bot con probabilidad (5%)
                    if (Math.random() < 0.05) {
                        const moodPhrase = getMoodPhrase();
                        if (moodPhrase) replyText += moodPhrase;
                    }

                    replyText = sanitizeAI(replyText);
                    const important = /🚫|⚠️|admin|oferta|ofertas|precio/i.test(replyText) || replyText.length > 300;
                    if (important && !replyText.includes('— Shiro Synthesis Two')) {
                        replyText += `\n\n— Shiro Synthesis Two`;
                    }

                    await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
                    await markMessageAsResponded(msg.key.id, remoteJid, participant, replyText);
                }).catch(e => console.error('Error en tarea de IA', e));

            } catch (err) {
                console.error('Error procesando mensaje', err);
            }
        }
    });
}

// ========== CHECKER DE SILENCIO (NUDGES) ==========
function startSilenceChecker() {
    intervalID = setInterval(async () => {
        try {
            const now = Date.now();
            if (now < botState.silentCooldownUntil) return;
            if (!botState.nudgeSent && (now - botState.lastActivity) > SILENCE_THRESHOLD) {
                const nudge = nudgeMessages[Math.floor(Math.random() * nudgeMessages.length)];
                try {
                    await sock.sendMessage(TARGET_GROUP_ID, { text: nudge });
                    botState.lastNudgeTime = Date.now();
                    botState.nudgeSent = true;

                    setTimeout(() => {
                        if (botState.lastActivity <= botState.lastNudgeTime) {
                            const cooldown = MIN_COOLDOWN + Math.floor(Math.random() * (MAX_COOLDOWN - MIN_COOLDOWN + 1));
                            botState.silentCooldownUntil = Date.now() + cooldown;
                            setTimeout(async () => {
                                if (botState.lastActivity <= botState.lastNudgeTime && Date.now() >= botState.silentCooldownUntil) {
                                    const ignored = ignoredMessages[Math.floor(Math.random() * ignoredMessages.length)];
                                    try { await sock.sendMessage(TARGET_GROUP_ID, { text: ignored }); } catch (e) { console.error('Error send ignored msg', e); }
                                }
                            }, cooldown + 1000);
                        } else {
                            botState.nudgeSent = false;
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
// Endpoint para admin: ver sugerencias pendientes (solo si se llama desde IP autorizada o con token simple)
app.get('/admin/suggestions', async (req, res) => {
    // Podrías agregar autenticación básica, por simplicidad solo un token en query
    const token = req.query.token;
    if (token !== process.env.ADMIN_TOKEN) {
        return res.status(401).send('No autorizado');
    }
    const suggestions = await getPendingSuggestions();
    res.json(suggestions);
});

app.listen(PORT, () => console.log(`🌐 Servidor web en puerto ${PORT}`));

// ========== Graceful shutdown ==========
process.on('SIGINT', () => { console.log('SIGINT recibido. Cerrando...'); process.exit(0); });
process.on('SIGTERM', () => { console.log('SIGTERM recibido. Cerrando...'); process.exit(0); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled Rejection:', reason); });

// ========== INICIO ==========
startBot().catch(e => console.error('Error fatal al iniciar bot', e));
