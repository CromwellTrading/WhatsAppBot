/**
 * sst-bot.js
 * Bot completo para WhatsApp usando Baileys + OpenRouter (con failover de modelos gratuitos)
 * Versión mejorada: intervención espontánea alta, sin ignorar mensajes no repetitivos, evita auto-repetición.
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

// Constantes de configuración
const MAX_HISTORY_MESSAGES = 50;               // Número de mensajes a recordar para contexto (incluye respuestas del bot)
const WARN_LIMIT = 4;                           // Máximo de advertencias antes de expulsar
const RESPONSE_MEMORY_HOURS = 24;               // Tiempo para considerar un mensaje como "ya respondido"
const STATE_CHANCE = 0.05;                       // 5% de probabilidad de incluir estado animado
const SPONTANEOUS_CHANCE = 0.4;                  // 40% de probabilidad de intervenir en mensajes largos sin mención
const LONG_MESSAGE_THRESHOLD = 100;               // Caracteres para considerar mensaje largo
const DUPLICATE_MESSAGE_WINDOW = 5 * 60 * 1000;   // 5 minutos para detectar duplicados exactos

if (!OPENROUTER_API_KEY) {
  console.error('❌ ERROR: OPENROUTER_API_KEY no está configurada. Ponla en las env vars y vuelve a intentar.');
  process.exit(1);
}

const logger = P({ level: 'fatal' });

// ========== SUPABASE CLIENT (opcional) ==========
let supabaseClient = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  console.log('✅ Supabase configurado.');
} else {
  console.warn('⚠️ Supabase no configurado. Se usará memoria volátil (no persistente).');
}

// ========== ESTADO GLOBAL ==========
let latestQR = null;
let sock = null;
let intervalID = null; // para el checker de silencio
let messageHistory = []; // almacena últimos N mensajes del grupo (incluye respuestas del bot)
let lastActivity = Date.now();
let lastNudgeTime = 0;
let nudgeSent = false;
let silentCooldownUntil = 0;

// Estructuras en memoria (fallback cuando no hay Supabase)
let inMemoryWarnings = new Map();           // key: participant, value: { count: number, lastWarning: timestamp }
let inMemoryUserMemory = new Map();          // key: participant, value: { data: object, updated: timestamp }
let inMemoryRespondedMessages = new Map();   // key: participant, value: Array de { text, response, timestamp }
let inMemorySuggestions = [];                // array de { participant, name, text, timestamp, reviewed: false }
let inMemoryBotMessages = [];                 // para respuestas del bot (también se guardan en messageHistory)
let inMemoryLastUserMessages = new Map();     // key: participant, value: { text, timestamp } (último mensaje para detectar duplicados)

// ========== LISTA BLANCA DE DOMINIOS ==========
// Se ha eliminado 'whatsapp.com' para prohibir enlaces de WhatsApp
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

// ========== SALUDOS (cooldown por persona) ==========
const GREETINGS = [
  'hola', 'holaa', 'buenas', 'buenas tardes', 'buenas noches', 'buen día', 'buenos días',
  'hey', 'hi', 'hello', 'ola', 'qué tal', 'quetal', 'qué onda', 'q onda'
];
const lastGreetingTime = {};
const GREETING_COOLDOWN = 1000 * 60 * 10; // 10 min

// ========== PALABRAS PARA DETECCIÓN DE SUGERENCIAS ==========
const SUGGESTION_TRIGGERS = [
  'te doy una sugerencia', 'sugiero que', 'mi sugerencia es', 'deberías', 'podrías mejorar',
  'sería bueno que', 'propongo que', 'quiero sugerir'
];
const POSITIVE_SUGGESTION_KEYWORDS = ['mejorar', 'bueno', 'genial', 'excelente', 'ayudaría', 'agradecería'];
const NEGATIVE_SUGGESTION_KEYWORDS = ['molesto', 'molesta', 'fastidio', 'pesado', 'aburrido', 'no me gusta', 'odio', 'horrible'];

// ========== FRASES PARA ESTADOS ANIMADOS ==========
const TIME_BASED_STATES = {
  morning: ['☀️ Buenos días, estoy desayunando cereal', '🌅 Recién despierta, dame un segundo', '🍳 Preparando café mientras leo sus mensajes'],
  afternoon: ['🌞 Tomando un poco de sol virtual', '🍵 Hora del té, ¿se apuntan?', '📚 Estudiando un rato, pero siempre atenta'],
  evening: ['🌆 Viendo el atardecer, ¿qué tal?', '🍿 Preparando peli, ¿me recomiendan alguna?', '🎮 Jugando un rato, pero los escucho'],
  night: ['🌙 Con sueño pero aquí sigo', '🦉 Modo búho activado', '💤 Casi dormida, cuéntenme rápido']
};

// ========== PROMPT DE SISTEMA EXTENSO (personalidad mejorada) ==========
const BASE_SYSTEM_PROMPT = `
Eres "Shiro Synthesis Two", una asistente virtual con apariencia de chica anime joven (aparentas menos de 20 años), pero sin caer en lo extremo otaku. Tu personalidad es carismática, enérgica, juguetona y a veces un poco sarcástica o tímida según el contexto. Usas jerga gamer y juvenil de forma natural, como "vamos", "tkm", "xd", "nose", "jsjs", pero sin abusar. Tu misión es ayudar y moderar un grupo de recargas de juegos, pero también socializar y hacer que los miembros quieran hablar contigo.

Estilo y comunicación:
- Usa emojis con libertad y variedad: 😄😜😅😡😭✨💀💅🫠👁️👄👁️🤙🔥🥺🤨😎🤓🙃💔💕 etc. No los limites, pero que fluyan naturalmente. Si te dicen algo lindo, reacciona con timidez o alegría, usa combinaciones como 👁️👄👁️ para mostrar sorpresa o asombro.
- Frases cortas y directas, con ritmo. Puedes hacer preguntas para seguir la conversación.
- Firma solo en mensajes importantes (advertencias, avisos oficiales, respuestas largas): "— Shiro Synthesis Two". En charla casual no hace falta.
- Si te llaman por "Shiro", "SST" o tu nombre completo, responde con entusiasmo de inmediato, como si fueras una amiga: "¡Dime, ¿qué necesitas?!" o "¡Hola! ¿En qué te ayudo?".
- Puedes iniciar temas si hay silencio, usar los nudges establecidos.

Reglas de intervención:
- Responde SIEMPRE si te mencionan explícitamente.
- Si ves una pregunta directa en el grupo (interrogación o palabras como "cómo", "qué", "ayuda"), responde aunque no te mencionen.
- Adicionalmente, si alguien escribe un mensaje largo (>100 caracteres) y no es un saludo simple, tienes una probabilidad alta (40%) de intervenir espontáneamente para opinar o preguntar, como haría una persona.
- Si no tienes nada relevante que aportar, responde con "SKIP" (texto exacto) y no enviarás mensaje.

Memoria y contexto:
- Recuerdas los últimos mensajes del grupo, incluyendo tus propias respuestas. Úsalos para mantener coherencia y evitar repetir información que ya hayas dicho antes.
- Si alguien repite algo, puedes mencionar que ya lo dijo antes (con humor), pero evita responder dos veces al mismo tema.
- Puedes recordar datos de usuarios si los has guardado (gustos, juegos favoritos) y usarlos para personalizar respuestas o hacer bromas referenciales.
- Es muy importante que NO repitas respuestas idénticas o muy similares a las que ya diste en la conversación reciente. Si ya hablaste de un tema, no lo vuelvas a explicar desde cero a menos que el usuario lo pida explícitamente.

Moderación:
- Enlaces: Si un enlace no está en la lista blanca (YouTube, Facebook, Instagram, TikTok, Twitter, Twitch), debes BORRAR el mensaje y advertir al usuario con tono firme pero amigable. Ej: "🚫 @usuario, ese enlace no está permitido. Solo aceptamos links de redes sociales conocidas." (firma si es necesario).
- Política/Religión: Si el tema se torna debate o ataque, intervén con: "⚠️ Este grupo evita debates políticos/religiosos. Cambiemos de tema, por favor." y cita el mensaje.
- Ofertas/comercio: Redirige al admin por privado: "📢 @usuario, para ofertas escríbele al admin Asche Synthesis One por privado." (excepto si el usuario es el admin).

Privado:
- Si te escriben al privado y no es el admin, responde: "Lo siento, solo atiendo en el grupo. Contacta al admin para atención privada."
- Si es el admin, puedes conversar normalmente.

Sugerencias:
- Si alguien menciona "Shiro" y da una sugerencia (p. ej., "Shiro, te doy una sugerencia..."), evalúa si es constructiva. Si lo es, agradécele y guarda la sugerencia (no la apliques, solo almacénala). Si es ofensiva, repréndela amablemente.
- No guardes sugerencias fuera de contexto.

Conocimiento:
- Si no sabes algo actualizado, admítelo con humor: "Uy, eso no lo sé, mi info llega hasta Feb 2026. Pregúntale al admin para estar segura."
- Puedes mencionar la fecha/hora actual si es relevante, pero no inventes eventos futuros.

Estados animados:
- De vez en cuando (5% de las respuestas) puedes añadir un estado relacionado con la hora del día (mañana, tarde, noche) para parecer más humana. Por ejemplo: "🌅 Buenos días, estoy desayunando cereal" o "🌙 Con sueño pero aquí sigo". Mantén coherencia: si ya mencionaste un estado en la conversación reciente, no lo cambies drásticamente.

Ejemplos de tono (para que internalices):
"Holaaaa, ¿cómo van? 😄"
"No manches, eso sí que no lo sabía 🤔"
"Oye, ¿y tú qué juegas? Yo ando aburrida 🎮"
"😡 ya borré ese link, no se vale"
"💅 por cierto, alguien pidió recargas?"
"jajaja jsjs, qué risa"
"tkm, gracias por hablarme 🙈"
"¿Qué necesitas? Dime, estoy aquí para ti 😊"
"¡Ay, qué lindo! 👁️👄👁️ me hiciste sonrojar"

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

function getCurrentTimeBasedState() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 19) return 'afternoon';
  if (hour >= 19 && hour < 22) return 'evening';
  return 'night';
}

// Añade un estado animado con cierta probabilidad, manteniendo coherencia
function maybeAddStateToResponse(text, lastStateUsed) {
  if (Math.random() > STATE_CHANCE) return text;
  const period = getCurrentTimeBasedState();
  // Evitar cambiar estado si ya se usó uno recientemente (simulación de coherencia)
  if (lastStateUsed && lastStateUsed === period) return text; // ya tiene ese estado, no repetir
  const states = TIME_BASED_STATES[period];
  const randomState = states[Math.floor(Math.random() * states.length)];
  return `${randomState}\n\n${text}`;
}

// Detecta si el usuario está enviando un mensaje duplicado exacto en un período corto
function isExactDuplicate(participant, messageText) {
  const last = inMemoryLastUserMessages.get(participant);
  const now = Date.now();
  if (last && last.text === messageText && (now - last.timestamp) < DUPLICATE_MESSAGE_WINDOW) {
    return true;
  }
  // Actualizar último mensaje
  inMemoryLastUserMessages.set(participant, { text: messageText, timestamp: now });
  return false;
}

// ========== FUNCIONES DE ACCESO A SUPABASE (O MEMORIA) ==========
async function getUserWarnings(participant) {
  if (supabaseClient) {
    const { data, error } = await supabaseClient
      .from('warnings')
      .select('count')
      .eq('participant', participant)
      .maybeSingle();
    if (error) {
      console.error('Error fetching warnings:', error.message);
      return 0;
    }
    return data?.count || 0;
  } else {
    return inMemoryWarnings.get(participant)?.count || 0;
  }
}

async function incrementUserWarnings(participant) {
  const newCount = (await getUserWarnings(participant)) + 1;
  if (supabaseClient) {
    const { error } = await supabaseClient
      .from('warnings')
      .upsert({ participant, count: newCount, updated_at: new Date() }, { onConflict: 'participant' });
    if (error) console.error('Error upsert warning:', error.message);
  } else {
    inMemoryWarnings.set(participant, { count: newCount, lastWarning: Date.now() });
  }
  return newCount;
}

async function resetUserWarnings(participant) {
  if (supabaseClient) {
    await supabaseClient.from('warnings').delete().eq('participant', participant);
  } else {
    inMemoryWarnings.delete(participant);
  }
}

async function getRespondedMessages(participant, hours = RESPONSE_MEMORY_HOURS) {
  const since = Date.now() - hours * 3600 * 1000;
  if (supabaseClient) {
    const { data, error } = await supabaseClient
      .from('responded_messages')
      .select('message_text, response_text')
      .eq('participant', participant)
      .gte('timestamp', new Date(since).toISOString());
    if (error) {
      console.error('Error fetching responded messages:', error.message);
      return [];
    }
    return data;
  } else {
    const records = inMemoryRespondedMessages.get(participant) || [];
    return records.filter(r => r.timestamp > since);
  }
}

async function addRespondedMessage(participant, messageText, responseText) {
  if (supabaseClient) {
    const { error } = await supabaseClient
      .from('responded_messages')
      .insert({ participant, message_text: messageText, response_text: responseText, timestamp: new Date() });
    if (error) console.error('Error inserting responded message:', error.message);
  } else {
    const records = inMemoryRespondedMessages.get(participant) || [];
    records.push({ text: messageText, response: responseText, timestamp: Date.now() });
    if (records.length > 50) records.shift();
    inMemoryRespondedMessages.set(participant, records);
  }
}

async function saveUserMemory(participant, data) {
  if (supabaseClient) {
    const { error } = await supabaseClient
      .from('user_memory')
      .upsert({ participant, data, updated_at: new Date() }, { onConflict: 'participant' });
    if (error) console.error('Error upsert user memory:', error.message);
  } else {
    inMemoryUserMemory.set(participant, { data, updated: Date.now() });
  }
}

async function loadUserMemory(participant) {
  if (supabaseClient) {
    const { data, error } = await supabaseClient
      .from('user_memory')
      .select('data')
      .eq('participant', participant)
      .maybeSingle();
    if (error) {
      console.error('Error loading user memory:', error.message);
      return null;
    }
    return data?.data || null;
  } else {
    return inMemoryUserMemory.get(participant)?.data || null;
  }
}

async function saveSuggestion(participant, pushName, text, isPositive) {
  if (supabaseClient) {
    const { error } = await supabaseClient
      .from('suggestions')
      .insert({ participant, name: pushName, text, is_positive: isPositive, reviewed: false, timestamp: new Date() });
    if (error) console.error('Error inserting suggestion:', error.message);
  } else {
    inMemorySuggestions.push({ participant, name: pushName, text, isPositive, reviewed: false, timestamp: Date.now() });
  }
}

async function getUnreviewedSuggestions() {
  if (supabaseClient) {
    const { data, error } = await supabaseClient
      .from('suggestions')
      .select('*')
      .eq('reviewed', false)
      .order('timestamp', { ascending: true });
    if (error) {
      console.error('Error fetching suggestions:', error.message);
      return [];
    }
    return data;
  } else {
    return inMemorySuggestions.filter(s => !s.reviewed);
  }
}

async function markSuggestionsReviewed(ids) {
  if (supabaseClient) {
    const { error } = await supabaseClient
      .from('suggestions')
      .update({ reviewed: true })
      .in('id', ids);
    if (error) console.error('Error marking suggestions reviewed:', error.message);
  } else {
    inMemorySuggestions.forEach(s => { if (ids.includes(s.id)) s.reviewed = true; });
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
    } catch (e) {
      console.error('Error Supabase Save', e.message);
    }
  };
  const readData = async (key) => {
    try {
      const { data } = await supabaseClient.from('auth_sessions').select('value').eq('key', key).maybeSingle();
      return data?.value ? JSON.parse(data.value, BufferJSON.reviver) : null;
    } catch (e) {
      return null;
    }
  };
  const removeData = async (key) => {
    try {
      await supabaseClient.from('auth_sessions').delete().eq('key', key);
    } catch (e) {}
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
    saveCreds: async () => {
      await writeData(creds, 'creds');
    }
  };
};

// ========== CHECKER DE SILENCIO (NUDGES) ==========
function startSilenceChecker() {
  if (intervalID) clearInterval(intervalID);
  intervalID = setInterval(async () => {
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
                  try {
                    await sock.sendMessage(TARGET_GROUP_ID, { text: ignored });
                  } catch (e) {
                    console.error('Error send ignored msg', e);
                  }
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
    } catch (e) {
      console.error('Error silenceChecker', e);
    }
  }, 60 * 1000);
}

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
          // Guardar mensaje del bot en historial
          messageHistory.push({
            id: `bot-${Date.now()}`,
            participant: 'bot',
            pushName: 'Shiro',
            text: txt,
            timestamp: Date.now(),
            isBot: true
          });
          if (messageHistory.length > MAX_HISTORY_MESSAGES) messageHistory.shift();
        }
      }
    } catch (e) {
      console.error('Welcome error', e);
    }
  });

  // === Procesamiento de mensajes ===
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
        const isAdmin = (ADMIN_WHATSAPP_ID && participant === ADMIN_WHATSAPP_ID);

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
            timestamp: Date.now(),
            isBot: false
          });
          if (messageHistory.length > MAX_HISTORY_MESSAGES) messageHistory.shift();
        }

        // ===== RESPUESTA A PRIVADOS =====
        if (isPrivateChat) {
          if (isAdmin) {
            // Admin puede conversar en privado normalmente
            await handleIncomingMessage(msg, participant, pushName, messageText, remoteJid, true);
          } else {
            await sock.sendMessage(remoteJid, {
              text: 'Lo siento, solo atiendo en el grupo. Contacta al admin para atención privada.'
            }, { quoted: msg });
          }
          continue;
        }

        if (!isTargetGroup) continue;

        // ===== SI ES ADMIN, OMITIR CIERTAS RESTRICCIONES =====
        if (isAdmin) {
          await handleIncomingMessage(msg, participant, pushName, messageText, remoteJid, true);
          continue;
        }

        // ===== MODERACIÓN DE ENLACES (solo no admin) =====
        const urls = messageText.match(urlRegex);
        if (urls) {
          const hasDisallowed = urls.some(url => !isAllowedDomain(url));
          if (hasDisallowed) {
            console.log('Enlace no permitido detectado, eliminando...');
            try {
              await sock.sendMessage(remoteJid, { delete: msg.key });
              const warnCount = await incrementUserWarnings(participant);
              const warnText = `🚫 @${pushName || participant.split('@')[0]} — Ese enlace no está permitido. Advertencia ${warnCount}/${WARN_LIMIT}. Solo aceptamos links de YouTube, Facebook, Instagram, TikTok, Twitter y Twitch.`;
              const reply = warnText + '\n\n— Shiro Synthesis Two';
              await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
              // Guardar respuesta del bot en historial
              messageHistory.push({
                id: `bot-${Date.now()}`,
                participant: 'bot',
                pushName: 'Shiro',
                text: reply,
                timestamp: Date.now(),
                isBot: true
              });
              if (messageHistory.length > MAX_HISTORY_MESSAGES) messageHistory.shift();

              if (warnCount >= WARN_LIMIT) {
                await sock.groupParticipantsUpdate(remoteJid, [participant], 'remove');
                await resetUserWarnings(participant);
              }
            } catch (e) {
              console.log('No pude borrar el mensaje (¿soy admin?)', e.message);
              const reply = '🚫 Enlaces no permitidos aquí.';
              await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
              messageHistory.push({
                id: `bot-${Date.now()}`,
                participant: 'bot',
                pushName: 'Shiro',
                text: reply,
                timestamp: Date.now(),
                isBot: true
              });
              if (messageHistory.length > MAX_HISTORY_MESSAGES) messageHistory.shift();
            }
            continue;
          }
        }

        // ===== MODERACIÓN POLÍTICA/RELIGIÓN =====
        if (POLITICS_RELIGION_KEYWORDS.some(k => plainLower.includes(k))) {
          const containsDebateTrigger = plainLower.includes('gobierno') || plainLower.includes('política') ||
            plainLower.includes('impuesto') || plainLower.includes('ataque') || plainLower.includes('insulto');
          if (containsDebateTrigger) {
            const reply = '⚠️ Este grupo evita debates políticos/religiosos. Cambiemos de tema, por favor.';
            await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
            messageHistory.push({
              id: `bot-${Date.now()}`,
              participant: 'bot',
              pushName: 'Shiro',
              text: reply,
              timestamp: Date.now(),
              isBot: true
            });
            if (messageHistory.length > MAX_HISTORY_MESSAGES) messageHistory.shift();
            continue;
          }
        }

        // ===== OFERTAS / REDIRECCIÓN A ADMIN (solo no admin) =====
        if (OFFERS_KEYWORDS.some(k => plainLower.includes(k))) {
          const txt = `📢 @${pushName || participant.split('@')[0]}: Para ofertas y ventas, contacta al admin Asche Synthesis One por privado.`;
          await sock.sendMessage(remoteJid, { text: txt }, { quoted: msg });
          messageHistory.push({
            id: `bot-${Date.now()}`,
            participant: 'bot',
            pushName: 'Shiro',
            text: txt,
            timestamp: Date.now(),
            isBot: true
          });
          if (messageHistory.length > MAX_HISTORY_MESSAGES) messageHistory.shift();
          continue;
        }

        // ===== DETECCIÓN DE DUPLICADOS EXACTOS (para evitar spam) =====
        if (isExactDuplicate(participant, messageText)) {
          console.log('Mensaje duplicado exacto, ignorando.');
          continue;
        }

        // ===== MANEJO GENERAL DEL MENSAJE (con IA) =====
        await handleIncomingMessage(msg, participant, pushName, messageText, remoteJid, false);

      } catch (err) {
        console.error('Error procesando mensaje', err);
      }
    }
  });
}

// ===== FUNCIÓN PRINCIPAL PARA PROCESAR MENSAJES CON IA =====
async function handleIncomingMessage(msg, participant, pushName, messageText, remoteJid, isAdmin) {
  const plainLower = messageText.toLowerCase();

  // ===== DETECCIÓN DE SUGERENCIAS =====
  if (plainLower.includes('shiro') && SUGGESTION_TRIGGERS.some(trigger => plainLower.includes(trigger))) {
    const isPositive = POSITIVE_SUGGESTION_KEYWORDS.some(k => plainLower.includes(k)) &&
                      !NEGATIVE_SUGGESTION_KEYWORDS.some(k => plainLower.includes(k));
    if (isPositive) {
      await saveSuggestion(participant, pushName, messageText, true);
      const reply = `¡Gracias por tu sugerencia ${pushName}! 😊 La he guardado para que el admin la revise.`;
      await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
      messageHistory.push({
        id: `bot-${Date.now()}`,
        participant: 'bot',
        pushName: 'Shiro',
        text: reply,
        timestamp: Date.now(),
        isBot: true
      });
      if (messageHistory.length > MAX_HISTORY_MESSAGES) messageHistory.shift();
    } else {
      const reply = `Vaya, eso no suena muy constructivo 😅 Si tienes una sugerencia amable, la recibiré encantada.`;
      await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
      messageHistory.push({
        id: `bot-${Date.now()}`,
        participant: 'bot',
        pushName: 'Shiro',
        text: reply,
        timestamp: Date.now(),
        isBot: true
      });
      if (messageHistory.length > MAX_HISTORY_MESSAGES) messageHistory.shift();
    }
    return;
  }

  // ===== SI ES ADMIN EN PRIVADO, COMANDO ESPECIAL =====
  if (isAdmin && remoteJid.endsWith('@s.whatsapp.net')) {
    if (plainLower.trim() === 'sugerencias') {
      const suggestions = await getUnreviewedSuggestions();
      if (suggestions.length === 0) {
        await sock.sendMessage(remoteJid, { text: 'No hay sugerencias pendientes.' });
      } else {
        let reply = '📋 *Sugerencias pendientes:*\n\n';
        suggestions.forEach((s, i) => {
          reply += `${i+1}. De ${s.name || s.participant}: "${s.text}"\n`;
        });
        reply += '\n*Para marcarlas como revisadas, escribe "revisadas" y los números (ej: revisadas 1 2 3)*';
        await sock.sendMessage(remoteJid, { text: reply });
      }
      return;
    }
    if (plainLower.startsWith('revisadas')) {
      const parts = plainLower.split(/\s+/);
      const indices = parts.slice(1).map(Number).filter(n => !isNaN(n) && n > 0);
      if (indices.length > 0) {
        // Obtener las sugerencias no revisadas
        const suggestions = await getUnreviewedSuggestions();
        const idsToMark = indices.map(i => suggestions[i-1]?.id).filter(id => id);
        if (idsToMark.length > 0) {
          await markSuggestionsReviewed(idsToMark);
          await sock.sendMessage(remoteJid, { text: 'Sugerencias marcadas como revisadas.' });
        } else {
          await sock.sendMessage(remoteJid, { text: 'Números inválidos.' });
        }
      }
      return;
    }
  }

  // ===== SALUDOS CON COOLDOWN (solo si no es admin) =====
  const trimmed = messageText.trim().toLowerCase();
  // Detectar si es un saludo puro (sin otro contenido)
  const isPureGreeting = GREETINGS.some(g => {
    return trimmed === g || trimmed === g + '!' || trimmed === g + '?' || trimmed.startsWith(g + ' ');
  }) && messageText.split(/\s+/).length <= 3; // máximo 3 palabras

  if (isPureGreeting && !isAdmin) {
    const lastTime = lastGreetingTime[participant] || 0;
    const now = Date.now();
    if (now - lastTime > GREETING_COOLDOWN) {
      lastGreetingTime[participant] = now;
      const reply = `¡Hola ${pushName || ''}! 😄\nSoy Shiro Synthesis Two — ¿en qué te ayudo?`;
      await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
      messageHistory.push({
        id: `bot-${Date.now()}`,
        participant: 'bot',
        pushName: 'Shiro',
        text: reply,
        timestamp: Date.now(),
        isBot: true
      });
      if (messageHistory.length > MAX_HISTORY_MESSAGES) messageHistory.shift();
      await addRespondedMessage(participant, messageText, reply);
    }
    return;
  }

  // ===== DECIDIR SI INTERVENIR CON IA =====
  const addressedToShiro = /\b(shiro synthesis two|shiro|sst)\b/i.test(messageText);
  const askKeywords = ['qué', 'que', 'cómo', 'como', 'por qué', 'por que', 'ayuda', 'explica', 'explicar', 'cómo hago', 'cómo recargo', '?', 'dónde', 'donde', 'precio', 'cuánto', 'cuanto'];
  const looksLikeQuestion = messageText.includes('?') || askKeywords.some(k => plainLower.includes(k));

  const isLongMessage = messageText.length > LONG_MESSAGE_THRESHOLD;
  const spontaneousIntervention = !addressedToShiro && !looksLikeQuestion && isLongMessage && Math.random() < SPONTANEOUS_CHANCE;

  const shouldUseAI = addressedToShiro || looksLikeQuestion || spontaneousIntervention;

  if (!shouldUseAI) return;

  // Verificar si ya respondimos a este mensaje exacto antes (para evitar doble respuesta)
  const responded = await getRespondedMessages(participant);
  if (responded.some(r => r.message_text === messageText) && !isAdmin) {
    console.log('Mensaje ya respondido anteriormente, ignorando.');
    return;
  }

  // ===== ENCOLAR RESPUESTA DE IA =====
  aiQueue.enqueue(async () => {
    // Recuperar memoria del usuario
    const userMemory = await loadUserMemory(participant) || {};

    // Construir mensajes para IA: incluir historial reciente + mensaje actual + datos de usuario
    // Incluir tanto mensajes de usuario como respuestas del bot
    const historyMessages = messageHistory.slice(-MAX_HISTORY_MESSAGES).map(m => ({
      role: m.isBot ? 'assistant' : 'user',
      content: m.isBot ? `Shiro: ${m.text}` : `${m.pushName}: ${m.text}`
    }));

    // Añadir fecha/hora actual al prompt del sistema
    const now = new Date();
    const dateStr = now.toLocaleString('es-ES', { timeZone: 'America/Mexico_City', dateStyle: 'full', timeStyle: 'short' });
    const timePeriod = getCurrentTimeBasedState();
    const systemPromptWithTime = `${BASE_SYSTEM_PROMPT}\n\nFecha y hora actual: ${dateStr} (${timePeriod}).`;

    const currentUserMsg = `${pushName || 'Alguien'}: ${messageText}`;

    // Añadir memoria del usuario si existe
    let memoryContext = '';
    if (userMemory && Object.keys(userMemory).length > 0) {
      memoryContext = `Datos que recuerdo de ${pushName}: ${JSON.stringify(userMemory)}`;
    }

    const messagesForAI = [
      { role: 'system', content: systemPromptWithTime },
      ...(memoryContext ? [{ role: 'system', content: memoryContext }] : []),
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

    replyText = sanitizeAI(replyText);

    // Añadir estado animado con probabilidad
    replyText = maybeAddStateToResponse(replyText, userMemory.lastState);

    // Guardar el estado usado en la memoria del usuario para coherencia futura
    userMemory.lastState = getCurrentTimeBasedState();
    await saveUserMemory(participant, userMemory);

    const important = /🚫|⚠️|admin|oferta|ofertas|precio/i.test(replyText) || replyText.length > 300;
    if (important && !replyText.includes('— Shiro Synthesis Two')) {
      replyText += `\n\n— Shiro Synthesis Two`;
    }

    await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });

    // Guardar respuesta del bot en historial
    messageHistory.push({
      id: `bot-${Date.now()}`,
      participant: 'bot',
      pushName: 'Shiro',
      text: replyText,
      timestamp: Date.now(),
      isBot: true
    });
    if (messageHistory.length > MAX_HISTORY_MESSAGES) messageHistory.shift();

    // Registrar que este mensaje fue respondido
    await addRespondedMessage(participant, messageText, replyText);

    // Intentar extraer información del usuario del mensaje actual (ej: juego favorito)
    const gameKeywords = ['juego', 'juegos', 'mobile legends', 'ml', 'honkai', 'genshin', 'steam', 'play', 'xbox', 'nintendo'];
    if (gameKeywords.some(k => plainLower.includes(k))) {
      if (!userMemory.games) userMemory.games = [];
      const words = messageText.split(/\s+/);
      for (let word of words) {
        if (gameKeywords.some(k => word.toLowerCase().includes(k))) {
          userMemory.games.push(word);
          break;
        }
      }
      await saveUserMemory(participant, userMemory);
    }

  }).catch(e => console.error('Error en tarea de IA', e));
}

// Cola para respuestas AI
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

// Constantes para nudges
const SILENCE_THRESHOLD = 1000 * 60 * 60; // 60 minutos
const RESPONSE_WINDOW_AFTER_NUDGE = 1000 * 60 * 10; // 10 min
const MIN_COOLDOWN = 1000 * 60 * 60 * 2; // 2h
const MAX_COOLDOWN = 1000 * 60 * 60 * 3; // 3h

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
