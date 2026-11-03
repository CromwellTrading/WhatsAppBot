'use strict';

/**
 * Shiro Synthesis Two — Bot para WhatsApp / Bolita Cubana
 * Node.js 20 + Baileys + OpenRouter + Supabase opcional.
 *
 * Características principales:
 * - Respuestas individuales citando el mensaje que las originó.
 * - Detección de menciones directas y respuestas a mensajes de Shiro.
 * - Historial persistente y respuestas guardadas para evitar contestar dos veces.
 * - Duplicados exactos por usuario: solo se señalan cuando existe una respuesta previa.
 * - Reconocimiento del administrador mediante ADMIN_WHATSAPP_ID.
 * - Privados permitidos únicamente al administrador.
 * - Moderación de enlaces con cuatro advertencias antes de expulsión.
 * - WhatsApp, grupos y canales de WhatsApp NO están en la lista blanca.
 * - Sugerencias sobre Shiro pendientes de revisión exclusiva del administrador.
 * - Memoria de conversación, resumen persistente y perfiles de usuario.
 * - Estados de personaje ocasionales basados en la hora de Cuba.
 * - Nudges por inactividad con temporizadores que no se duplican al reconectar.
 *
 * IMPORTANTE:
 * - La base de datos de Supabase debe inicializarse con supabase.sql.
 * - Para conservar la sesión de WhatsApp en Docker, monta un volumen en /data/auth.
 * - El bot debe ser administrador del grupo para borrar mensajes y expulsar miembros.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');

const P = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// -----------------------------------------------------------------------------
// Configuración
// -----------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 3000);
const TIME_ZONE = process.env.TIME_ZONE || 'America/Havana';
const TARGET_GROUP_ID = (process.env.TARGET_GROUP_ID || '').trim();
const ALLOWED_GROUPS = new Set(
  (process.env.ALLOWED_GROUP_IDS || TARGET_GROUP_ID)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);

const ADMIN_WHATSAPP_ID_RAW = (process.env.ADMIN_WHATSAPP_ID || '').trim();
const ADMIN_WHATSAPP_ID = normalizeJid(ADMIN_WHATSAPP_ID_RAW);
const ADMIN_PHONE_DIGITS = digitsFromJidOrPhone(ADMIN_WHATSAPP_ID_RAW);

const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || '').trim();
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_MODELS = (process.env.OPENROUTER_MODEL ||
  'stepfun/step-3.5-flash:free,openai/gpt-oss-20b:free')
  .split(',')
  .map(model => model.trim())
  .filter(Boolean);

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const QR_ACCESS_TOKEN = (process.env.QR_ACCESS_TOKEN || '').trim();
const AUTH_DIR = process.env.AUTH_DIR || '/data/auth';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// Login por código de vinculación (número del bot, solo dígitos con prefijo de país, ej. 5351234567).
const PAIRING_PHONE = String(process.env.PAIRING_PHONE || '').replace(/\D/g, '');
const PAIRING_MIN_GAP_MS = 90 * 1000;
const PAIRING_MAX_PER_HOUR = 4;

// Comportamiento humano: ritmo de escritura, lectura y horas de descanso.
const HUMANIZE = String(process.env.HUMANIZE || 'true').toLowerCase() !== 'false';
const TYPING_CPS_MIN = 9;              // caracteres por segundo (mínimo)
const TYPING_CPS_MAX = 15;             // caracteres por segundo (máximo)
const MIN_REPLY_GAP_MS = 2500;         // separación mínima entre dos mensajes del bot en el mismo chat
const QUIET_HOURS_START = clampNumber(process.env.QUIET_HOURS_START, 1, 0, 23);
const QUIET_HOURS_END = clampNumber(process.env.QUIET_HOURS_END, 7, 0, 23);

const HISTORY_LIMIT = clampNumber(process.env.HISTORY_LIMIT, 100, 20, 250);
const DUPLICATE_WINDOW_MS = clampNumber(process.env.DUPLICATE_WINDOW_MINUTES, 10, 1, 120) * 60 * 1000;
const PRIVATE_REPLY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SILENCE_THRESHOLD_MS = 60 * 60 * 1000;
const NUDGE_RESPONSE_WINDOW_MS = 10 * 60 * 1000;
const MIN_NUDGE_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const MAX_NUDGE_COOLDOWN_MS = 3 * 60 * 60 * 1000;
const SUMMARY_EVERY_MESSAGES = 60;
const SUMMARY_SOURCE_LIMIT = 80;
const MAX_AI_REPLY_CHARS = 1800;

if (!OPENROUTER_API_KEY) {
  console.error('Falta OPENROUTER_API_KEY. Configúrala en las variables de entorno.');
  process.exit(1);
}

if (!ADMIN_WHATSAPP_ID_RAW) {
  console.warn('⚠️ ADMIN_WHATSAPP_ID no está configurado. Shiro no podrá reconocer con seguridad al administrador.');
}

const logger = P({ level: LOG_LEVEL, timestamp: P.stdTimeFunctions.isoTime });

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
} else {
  console.warn('⚠️ Supabase no está configurado. La memoria y las advertencias solo durarán hasta reiniciar el proceso.');
}

// -----------------------------------------------------------------------------
// Estado de ejecución
// -----------------------------------------------------------------------------

let sock = null;
let latestQR = null;
let latestPairingCode = null;
let pairingRequestTimes = [];
let reconnectAttempts = 0;
let connected = false;
let reconnectTimer = null;
let silenceInterval = null;
let nudgeFollowupTimer = null;
let shuttingDown = false;
let botJid = '';
let botLid = '';
let botPhoneDigits = '';
let lastGroupActivity = Date.now();
let lastNudgeAt = 0;
let nudgeWasSent = false;
let nudgeCooldownUntil = 0;

const lastSendAtByChat = new Map();
const memoryMessages = new Map();
const memoryReplies = new Set();
const memoryWarnings = new Map();
const privateReplyTimes = new Map();
const summaryCounters = new Map();
const pendingSuggestionMemory = new Map();
const personaStateMemory = { value: null, until: 0 };

// -----------------------------------------------------------------------------
// Cola serial: cada mensaje se procesa individualmente, sin mezclar autores.
// -----------------------------------------------------------------------------

class SerialQueue {
  constructor(delayMs = 180) {
    this.tasks = [];
    this.running = false;
    this.delayMs = delayMs;
  }

  enqueue(task) {
    return new Promise((resolve, reject) => {
      this.tasks.push({ task, resolve, reject });
      this.runNext();
    });
  }

  async runNext() {
    if (this.running) return;
    const item = this.tasks.shift();
    if (!item) return;
    this.running = true;
    try {
      item.resolve(await item.task());
    } catch (error) {
      item.reject(error);
    } finally {
      this.running = false;
      if (this.tasks.length) {
        setTimeout(() => this.runNext(), this.delayMs);
      }
    }
  }

  get length() {
    return this.tasks.length + (this.running ? 1 : 0);
  }
}

const aiQueue = new SerialQueue(180);

// -----------------------------------------------------------------------------
// Utilidades
// -----------------------------------------------------------------------------

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function normalizeJid(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (!raw) return '';
  if (raw.includes('@')) return raw.replace(/:\d+(?=@)/, '').toLowerCase();
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : '';
}

function digitsFromJidOrPhone(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (raw.includes('@') && !raw.toLowerCase().endsWith('@s.whatsapp.net')) return '';
  return raw.split('@')[0].split(':')[0].replace(/\D/g, '');
}

function getMessageParticipant(msg) {
  const candidates = [msg?.key?.participant, msg?.key?.participantAlt, msg?.key?.remoteJidAlt, msg?.key?.remoteJid].filter(Boolean);
  const phoneJid = candidates.find(value => String(value).includes('@s.whatsapp.net'));
  return normalizeJid(phoneJid || candidates[0] || '');
}

function getJidCandidates(msg) {
  return [
    msg?.key?.participant,
    msg?.key?.participantAlt,
    msg?.key?.remoteJid,
    msg?.key?.remoteJidAlt,
    msg?.participant,
    msg?.senderPn
  ].filter(Boolean).map(normalizeJid);
}

function isAdminJid(jid) {
  const normalized = normalizeJid(jid);
  if (!normalized || !ADMIN_WHATSAPP_ID) return false;
  if (normalized === ADMIN_WHATSAPP_ID) return true;
  if (ADMIN_PHONE_DIGITS && normalized.endsWith('@s.whatsapp.net')) {
    return normalized.split('@')[0].replace(/\D/g, '') === ADMIN_PHONE_DIGITS;
  }
  return false;
}

function isAdminMessage(msg) {
  return getJidCandidates(msg).some(isAdminJid);
}

function unwrapMessageContent(message) {
  let current = message;
  for (let i = 0; i < 6 && current; i += 1) {
    if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message;
    else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message;
    else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
    else if (current.viewOnceMessageV2Extension?.message) current = current.viewOnceMessageV2Extension.message;
    else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
    else break;
  }
  return current || {};
}

function extractMessageText(message) {
  const content = unwrapMessageContent(message);
  const candidates = [
    content.conversation,
    content.extendedTextMessage?.text,
    content.imageMessage?.caption,
    content.videoMessage?.caption,
    content.documentMessage?.caption,
    content.documentWithCaptionMessage?.message?.documentMessage?.caption,
    content.buttonsResponseMessage?.selectedDisplayText,
    content.listResponseMessage?.title,
    content.templateButtonReplyMessage?.selectedDisplayText,
    content.interactiveResponseMessage?.body?.text,
    content.pollCreationMessage?.name
  ];
  const value = candidates.find(item => typeof item === 'string' && item.trim());
  return value ? value.trim() : '';
}

function getContextInfo(message) {
  const content = unwrapMessageContent(message);
  const values = Object.values(content || {});
  for (const value of values) {
    if (value && typeof value === 'object' && value.contextInfo) return value.contextInfo;
  }
  return content.messageContextInfo || null;
}

function getMessageMentions(message) {
  const context = getContextInfo(message?.message || message);
  const mentions = context?.mentionedJid || [];
  return Array.isArray(mentions) ? mentions.map(normalizeJid) : [];
}

function isBotMentioned(msg, text) {
  const mentions = getMessageMentions(msg);
  const exactMention = mentions.some(jid => jid === botJid || (botLid && jid === botLid) || (botPhoneDigits && jid.endsWith('@s.whatsapp.net') && jid.split('@')[0] === botPhoneDigits));
  const plainMention = /(?:^|[^\p{L}\p{N}])(shiro(?:\s+synthesis\s+two)?|sst)(?:$|[^\p{L}\p{N}])/iu.test(text || '');
  return exactMention || plainMention;
}

function isReplyToBot(msg) {
  const context = getContextInfo(msg.message);
  const participant = normalizeJid(context?.participant || '');
  const stanzaId = context?.stanzaId || '';
  return Boolean(stanzaId && (participant === botJid || (botPhoneDigits && participant.endsWith('@s.whatsapp.net') && participant.split('@')[0] === botPhoneDigits)));
}

function normalizeForDuplicateCheck(text) {
  return String(text || '')
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/www\.\S+/g, '[url]')
    .replace(/@\d+/g, '@usuario')
    .replace(/[¿?¡!.,;:()[\]{}"'`~*_\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getCubaDateTime() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('es-CU', {
    timeZone: TIME_ZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const data = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    iso: now.toISOString(),
    formatted: `${data.weekday}, ${data.day} de ${data.month} de ${data.year}, ${data.hour}:${data.minute}`,
    hour: Number(data.hour),
    minute: Number(data.minute)
  };
}

function localPartOfDay(hour) {
  if (hour >= 6 && hour < 12) return 'mañana';
  if (hour >= 12 && hour < 19) return 'tarde';
  if (hour >= 19 && hour < 23) return 'noche';
  return 'madrugada';
}

function getSenderName(msg) {
  const name = String(msg?.pushName || '').trim();
  return name.slice(0, 80) || getMessageParticipant(msg).split('@')[0] || 'Integrante';
}

function isPrivateJid(jid) {
  return typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));
}

function isTargetGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us') && ALLOWED_GROUPS.has(jid);
}

function isQuestionLike(text) {
  const normalized = String(text || '').trim();
  if (normalized.includes('?') || normalized.includes('¿')) return normalized.length > 3;
  return /\b(que|qué|como|cómo|cuando|cuándo|donde|dónde|por que|por qué|quien|quién|cuanto|cuánto|cual|cuál|ayuda|explica|puedo|podria|podría|sabes)\b/i.test(normalized);
}

function isGreetingLike(text) {
  return /^(?:hola+|holi+|buenas(?: tardes| noches)?|buen(?:os|as) d[ií]as|hey+|hello|hi|saludos|qué tal|que tal|q tal)(?:[\s,!.?]|$)/i.test(String(text || '').trim());
}

function isDebateThatShouldBeRedirected(text) {
  const lower = String(text || '').toLocaleLowerCase('es');
  const topic = /\b(pol[ií]tica|pol[ií]tico|gobierno|partido pol[ií]tico|religi[oó]n|iglesia|ate[ií]smo|creencias religiosas)\b/i.test(lower);
  const debate = /\b(discutir|debate|pelea|insulto|odio|atacar|tienen la culpa|est[aá]n equivocados|demuestra que|ustedes son)\b/i.test(lower);
  return topic && debate;
}

function getUrls(text) {
  const source = String(text || '');
  const expression = /(?:https?:\/\/|www\.)[^\s<>]+|(?<![@/:])\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>]*)?/gi;
  return source.match(expression) || [];
}

const ALLOWED_DOMAINS = [
  'youtube.com', 'youtu.be',
  'facebook.com', 'fb.com',
  'instagram.com',
  'tiktok.com',
  'twitter.com', 'x.com',
  'twitch.tv'
];

function isAllowedDomain(rawUrl) {
  try {
    let candidate = String(rawUrl || '').trim().replace(/[),.;!?\]}]+$/g, '');
    if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate.replace(/^www\./i, 'www.')}`;
    const host = new URL(candidate).hostname.toLowerCase().replace(/^www\./, '');
    // WhatsApp y todos sus subdominios están deliberadamente prohibidos.
    if (host === 'whatsapp.com' || host.endsWith('.whatsapp.com') || host === 'wa.me' || host.endsWith('.wa.me')) return false;
    return ALLOWED_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function cleanAIText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_AI_REPLY_CHARS);
}

function safeJsonParse(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(raw); } catch { return null; }
}

// -----------------------------------------------------------------------------
// Supabase: historial, respuestas, perfiles, sugerencias, sanciones y estado.
// Todas las operaciones tienen fallback en memoria si Supabase falla.
// -----------------------------------------------------------------------------

async function storeIncomingMessage({ chatJid, messageId, participantJid, senderName, body, timestamp }) {
  const record = {
    chat_jid: chatJid,
    message_id: messageId,
    participant_jid: participantJid,
    sender_name: senderName,
    body,
    is_from_bot: false,
    source_message_id: null,
    created_at: new Date(timestamp || Date.now()).toISOString()
  };

  if (supabase) {
    const { error } = await supabase.from('bot_messages').insert(record);
    if (error) {
      if (error.code === '23505' || error.code === '409') return false;
      logger.error({ error: error.message }, 'No se pudo guardar el mensaje entrante en Supabase');
    } else {
      return true;
    }
  }

  const list = memoryMessages.get(chatJid) || [];
  if (list.some(item => item.message_id === messageId)) return false;
  list.push(record);
  if (list.length > 600) list.splice(0, list.length - 600);
  memoryMessages.set(chatJid, list);
  return true;
}

async function storeBotMessage({ chatJid, messageId, body, sourceMessageId }) {
  const record = {
    chat_jid: chatJid,
    message_id: messageId,
    participant_jid: botJid || 'shiro@bot',
    sender_name: 'Shiro Synthesis Two',
    body,
    is_from_bot: true,
    source_message_id: sourceMessageId || null,
    created_at: new Date().toISOString()
  };

  if (supabase) {
    const { error } = await supabase.from('bot_messages').insert(record);
    if (error && error.code !== '23505') logger.error({ error: error.message }, 'No se pudo guardar la respuesta de Shiro');
    if (sourceMessageId) {
      const { error: replyError } = await supabase.from('bot_replies').upsert({
        chat_jid: chatJid,
        source_message_id: sourceMessageId,
        reply_message_id: messageId,
        reply_text: body,
        created_at: new Date().toISOString()
      }, { onConflict: 'chat_jid,source_message_id', ignoreDuplicates: true });
      if (replyError) logger.error({ error: replyError.message }, 'No se pudo registrar el vínculo de respuesta');
    }
  }

  const list = memoryMessages.get(chatJid) || [];
  list.push(record);
  if (list.length > 600) list.splice(0, list.length - 600);
  memoryMessages.set(chatJid, list);
  if (sourceMessageId) memoryReplies.add(`${chatJid}:${sourceMessageId}`);
}

async function hasReplyForSource(chatJid, sourceMessageId) {
  if (!sourceMessageId) return false;
  if (memoryReplies.has(`${chatJid}:${sourceMessageId}`)) return true;
  if (supabase) {
    const { data, error } = await supabase.from('bot_replies')
      .select('id')
      .eq('chat_jid', chatJid)
      .eq('source_message_id', sourceMessageId)
      .maybeSingle();
    if (!error && data) return true;
    if (error && error.code !== 'PGRST116') logger.error({ error: error.message }, 'Error consultando respuestas anteriores');
  }
  return false;
}

async function getRecentMessages(chatJid, limit = HISTORY_LIMIT) {
  if (supabase) {
    const { data, error } = await supabase.from('bot_messages')
      .select('message_id,participant_jid,sender_name,body,is_from_bot,source_message_id,created_at')
      .eq('chat_jid', chatJid)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (!error && data) return data.reverse();
    if (error) logger.error({ error: error.message }, 'Error leyendo el historial');
  }
  return (memoryMessages.get(chatJid) || []).slice(-limit);
}

async function findExactPreviousMessage(chatJid, participantJid, body) {
  const normalized = normalizeForDuplicateCheck(body);
  if (!normalized || normalized.length < 3) return null;
  const recent = await getRecentMessages(chatJid, 80);
  const now = Date.now();
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const item = recent[index];
    if (item.is_from_bot) continue;
    if (normalizeJid(item.participant_jid) !== normalizeJid(participantJid)) continue;
    if (normalizeForDuplicateCheck(item.body) !== normalized) continue;
    const createdAt = new Date(item.created_at).getTime();
    if (!Number.isFinite(createdAt) || now - createdAt > DUPLICATE_WINDOW_MS) continue;
    return item;
  }
  return null;
}

async function getChatSummary(chatJid) {
  if (!supabase) return '';
  const { data, error } = await supabase.from('chat_summaries')
    .select('summary')
    .eq('chat_jid', chatJid)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') logger.error({ error: error.message }, 'Error leyendo resumen del chat');
  return data?.summary || '';
}

async function saveChatSummary(chatJid, summary, lastMessageId) {
  if (!supabase || !summary) return;
  const { error } = await supabase.from('chat_summaries').upsert({
    chat_jid: chatJid,
    summary,
    last_summarized_message_id: lastMessageId || null,
    updated_at: new Date().toISOString()
  }, { onConflict: 'chat_jid' });
  if (error) logger.error({ error: error.message }, 'Error guardando resumen del chat');
}

async function maybeSummarizeChat(chatJid) {
  if (!supabase) return;
  const counter = (summaryCounters.get(chatJid) || 0) + 1;
  summaryCounters.set(chatJid, counter);
  if (counter < SUMMARY_EVERY_MESSAGES) return;
  summaryCounters.set(chatJid, 0);

  const history = await getRecentMessages(chatJid, SUMMARY_SOURCE_LIMIT);
  if (history.length < 35) return;
  const previousSummary = await getChatSummary(chatJid);
  const transcript = history.map(item => `${item.is_from_bot ? 'Shiro' : (item.sender_name || 'Usuario')}: ${item.body}`).join('\n');
  const messages = [
    {
      role: 'system',
      content: 'Resume el historial de una comunidad de WhatsApp para conservar continuidad. Guarda hechos, preferencias, nombres asociados a anécdotas, bromas internas, temas pendientes y respuestas que Shiro ya dio. No inventes. No repitas datos irrelevantes. Devuelve solo un resumen compacto en español.'
    },
    {
      role: 'user',
      content: `Resumen anterior:\n${previousSummary || '(sin resumen)'}\n\nMensajes recientes:\n${transcript}`
    }
  ];
  const summary = await callOpenRouter(messages, { maxTokens: 1300, temperature: 0.2 });
  if (summary && !/^SKIP$/i.test(summary.trim())) {
    await saveChatSummary(chatJid, cleanAIText(summary), history[history.length - 1]?.message_id);
    logger.info({ chatJid }, 'Resumen de conversación actualizado');
  }
}

async function getUserProfile(userJid) {
  if (!supabase || !userJid) return null;
  const { data, error } = await supabase.from('user_profiles')
    .select('user_jid,display_name,tone_preference,notes,last_seen_at')
    .eq('user_jid', userJid)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') logger.error({ error: error.message }, 'Error leyendo perfil del usuario');
  return data || null;
}

async function touchUserProfile(userJid, displayName) {
  if (!supabase || !userJid) return;
  const { error } = await supabase.from('user_profiles').upsert({
    user_jid: userJid,
    display_name: displayName || null,
    last_seen_at: new Date().toISOString()
  }, { onConflict: 'user_jid', ignoreDuplicates: false });
  if (error) logger.error({ error: error.message }, 'Error actualizando perfil del usuario');
}

async function setTonePreference(userJid, preference, feedback) {
  if (!supabase || !userJid) return;
  const { error } = await supabase.from('user_profiles').upsert({
    user_jid: userJid,
    tone_preference: preference,
    notes: feedback || null,
    last_seen_at: new Date().toISOString()
  }, { onConflict: 'user_jid' });
  if (error) logger.error({ error: error.message }, 'Error guardando preferencia de trato');
}

async function getPendingSuggestionState(chatJid, userJid) {
  const key = `${chatJid}:${userJid}`;
  if (pendingSuggestionMemory.has(key)) return pendingSuggestionMemory.get(key);
  if (!supabase) return null;
  const { data, error } = await supabase.from('user_sessions')
    .select('pending_suggestion,pending_suggestion_at')
    .eq('chat_jid', chatJid)
    .eq('user_jid', userJid)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') logger.error({ error: error.message }, 'Error consultando sugerencia pendiente');
  if (!data?.pending_suggestion) return null;
  const age = Date.now() - new Date(data.pending_suggestion_at || 0).getTime();
  if (age > 10 * 60 * 1000) {
    await clearPendingSuggestionState(chatJid, userJid);
    return null;
  }
  return { startedAt: data.pending_suggestion_at };
}

async function setPendingSuggestionState(chatJid, userJid) {
  const key = `${chatJid}:${userJid}`;
  const value = { startedAt: new Date().toISOString() };
  pendingSuggestionMemory.set(key, value);
  if (!supabase) return;
  const { error } = await supabase.from('user_sessions').upsert({
    chat_jid: chatJid,
    user_jid: userJid,
    pending_suggestion: true,
    pending_suggestion_at: value.startedAt,
    updated_at: new Date().toISOString()
  }, { onConflict: 'chat_jid,user_jid' });
  if (error) logger.error({ error: error.message }, 'Error guardando estado de sugerencia');
}

async function clearPendingSuggestionState(chatJid, userJid) {
  pendingSuggestionMemory.delete(`${chatJid}:${userJid}`);
  if (!supabase) return;
  const { error } = await supabase.from('user_sessions').upsert({
    chat_jid: chatJid,
    user_jid: userJid,
    pending_suggestion: false,
    pending_suggestion_at: null,
    updated_at: new Date().toISOString()
  }, { onConflict: 'chat_jid,user_jid' });
  if (error) logger.error({ error: error.message }, 'Error limpiando estado de sugerencia');
}

async function saveSuggestion({ chatJid, userJid, userName, body }) {
  if (!supabase) return { ok: false, reason: 'database' };
  const { data, error } = await supabase.from('suggestions').insert({
    chat_jid: chatJid,
    user_jid: userJid,
    user_name: userName,
    suggestion_text: body,
    status: 'pending',
    created_at: new Date().toISOString()
  }).select('id').single();
  if (error) {
    logger.error({ error: error.message }, 'Error guardando sugerencia');
    return { ok: false, reason: 'database' };
  }
  return { ok: true, id: data.id };
}

async function getPendingSuggestions(limit = 20) {
  if (!supabase) return [];
  const { data, error } = await supabase.from('suggestions')
    .select('id,user_name,suggestion_text,created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) {
    logger.error({ error: error.message }, 'Error consultando sugerencias');
    return [];
  }
  return data || [];
}

async function updateSuggestionStatus(id, status, adminJid) {
  if (!supabase) return false;
  const { data, error } = await supabase.from('suggestions')
    .update({ status, reviewed_by: adminJid, reviewed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) logger.error({ error: error.message }, 'Error actualizando sugerencia');
  return Boolean(data && !error);
}

async function incrementWarning(groupJid, userJid) {
  const memoryKey = `${groupJid}:${userJid}`;
  if (supabase) {
    const { data, error } = await supabase.rpc('increment_user_warning', {
      p_group_jid: groupJid,
      p_user_jid: userJid
    });
    if (!error && Number.isFinite(Number(data))) return Number(data);
    if (error) logger.error({ error: error.message }, 'No se pudo incrementar advertencia en Supabase');
  }
  const next = (memoryWarnings.get(memoryKey) || 0) + 1;
  memoryWarnings.set(memoryKey, next);
  return next;
}

async function getPersonaState() {
  const now = Date.now();
  if (personaStateMemory.value && personaStateMemory.until > now) return personaStateMemory.value;
  if (supabase) {
    const { data, error } = await supabase.from('bot_kv').select('value').eq('key', 'persona_state').maybeSingle();
    if (!error && data?.value?.state && new Date(data.value.until).getTime() > now) {
      personaStateMemory.value = data.value.state;
      personaStateMemory.until = new Date(data.value.until).getTime();
      return personaStateMemory.value;
    }
  }
  return null;
}

async function maybeCreatePersonaState() {
  const current = await getPersonaState();
  if (current) return current;
  if (Math.random() >= 0.05) return null;

  const { hour } = getCubaDateTime();
  const states = [];
  if (hour >= 0 && hour < 6) states.push('Shiro tiene bastante sueño y está intentando mantenerse despierta');
  if (hour >= 6 && hour < 11) states.push('Shiro está tomando café y despertándose poco a poco');
  if (hour >= 11 && hour < 15) states.push('Shiro está comiendo algo tranquilamente');
  if (hour >= 15 && hour < 19) states.push('Shiro está escuchando música mientras descansa');
  if (hour >= 19 && hour < 24) states.push('Shiro está viendo un anime o una serie');
  states.push('Shiro está bebiendo agua');
  states.push('Shiro está viendo una película triste y quedó sentimental');
  states.push('Shiro está jugando algo y tiene una pausa');

  const state = states[Math.floor(Math.random() * states.length)];
  const durationMs = (60 + Math.floor(Math.random() * 31)) * 60 * 1000;
  const until = new Date(Date.now() + durationMs).toISOString();
  personaStateMemory.value = state;
  personaStateMemory.until = new Date(until).getTime();
  if (supabase) {
    const { error } = await supabase.from('bot_kv').upsert({
      key: 'persona_state',
      value: { state, until },
      updated_at: new Date().toISOString()
    }, { onConflict: 'key' });
    if (error) logger.error({ error: error.message }, 'Error guardando estado de Shiro');
  }
  return state;
}

// -----------------------------------------------------------------------------
// Prompt y OpenRouter
// -----------------------------------------------------------------------------

const PROMPT_PATH = path.join(__dirname, 'prompt-shiro.md');
let SYSTEM_PROMPT = '';
try {
  SYSTEM_PROMPT = fs.readFileSync(PROMPT_PATH, 'utf8').trim();
} catch (error) {
  logger.error({ error: error.message }, 'No se pudo leer prompt-shiro.md');
  process.exit(1);
}

async function callOpenRouter(messages, options = {}) {
  const models = options.models || OPENROUTER_MODELS;
  for (const model of models) {
    try {
      logger.info({ model }, 'Consultando modelo OpenRouter');
      const response = await axios.post(`${OPENROUTER_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
        model,
        messages,
        temperature: options.temperature ?? 0.8,
        max_tokens: options.maxTokens ?? 650
      }, {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://github.com/bolita-cubana/shiro-synthesis-two',
          'X-Title': 'Shiro Synthesis Two'
        },
        timeout: 60000
      });

      const choice = response.data?.choices?.[0];
      const content = choice?.message?.content;
      const result = Array.isArray(content)
        ? content.map(part => part?.text || '').join('')
        : content;
      if (typeof result === 'string' && result.trim()) return result.trim();
      logger.warn({ model }, 'El modelo devolvió una respuesta vacía');
    } catch (error) {
      const detail = error.response?.data?.error?.message || error.message;
      logger.warn({ model, error: detail }, 'Modelo OpenRouter falló; probando el siguiente');
    }
  }
  return null;
}

async function buildAIConversation(msg, chatJid, participantJid, senderName, messageText, isAdmin) {
  const [history, summary, profile, personaState] = await Promise.all([
    getRecentMessages(chatJid, HISTORY_LIMIT),
    getChatSummary(chatJid),
    getUserProfile(participantJid),
    maybeCreatePersonaState()
  ]);

  const now = getCubaDateTime();
  const contextHeader = [
    `FECHA Y HORA ACTUAL: ${now.formatted} (${TIME_ZONE}).`,
    `MOMENTO DEL DÍA: ${localPartOfDay(now.hour)}.`,
    `INTERLOCUTOR: ${senderName}.`,
    `IDENTIFICADOR DEL INTERLOCUTOR: ${participantJid}.`,
    `¿ES ADMINISTRADOR VERIFICADO?: ${isAdmin ? 'SÍ' : 'NO'}.`,
    `CHAT: ${chatJid.endsWith('@g.us') ? 'GRUPO' : 'PRIVADO AUTORIZADO DEL ADMINISTRADOR'}.`,
    profile?.tone_preference ? `PREFERENCIA DE TRATO DE ESTE USUARIO: ${profile.tone_preference}.` : '',
    personaState ? `ESTADO OCASIONAL ACTUAL DE SHIRO (no es obligatorio mencionarlo y no debes repetirlo constantemente): ${personaState}.` : '',
    summary ? `MEMORIA RESUMIDA DE CONVERSACIONES ANTERIORES:\n${summary}` : '',
    'INSTRUCCIÓN OPERATIVA: contesta únicamente el mensaje actual. El historial incluye respuestas reales de Shiro. No vuelvas a contestar una pregunta que ya quedó respondida; si el mensaje actual continúa de verdad una conversación, síguela con naturalidad. No resumas ni respondas a todos los participantes juntos.'
  ].filter(Boolean).join('\n');

  const conversation = [{ role: 'system', content: SYSTEM_PROMPT }];
  conversation.push({ role: 'system', content: contextHeader });

  for (const item of history) {
    if (!item.body) continue;
    if (item.is_from_bot) {
      conversation.push({ role: 'assistant', content: item.body });
    } else {
      const displayName = item.sender_name || 'Integrante';
      conversation.push({ role: 'user', content: `${displayName}: ${item.body}` });
    }
  }

  // Respaldo para instalaciones en las que el guardado del mensaje entrante falló.
  const last = history[history.length - 1];
  if (!last || last.message_id !== msg.key.id) {
    conversation.push({ role: 'user', content: `${senderName}: ${messageText}` });
  }

  return conversation;
}

// -----------------------------------------------------------------------------
// Mensajes de WhatsApp, menciones, citas y respuestas idempotentes.
// -----------------------------------------------------------------------------

function getMentionableJid(jid) {
  const normalized = normalizeJid(jid);
  if (normalized.endsWith('@s.whatsapp.net')) return normalized;
  return '';
}

function prependDirectMention(text, participantJid, enabled) {
  if (!enabled) return { text, mentions: [] };
  const jid = getMentionableJid(participantJid);
  if (!jid) return { text, mentions: [] };
  const digits = jid.split('@')[0];
  return { text: `@${digits} ${text}`, mentions: [jid] };
}

function applyAdminMention(text) {
  const output = String(text || '');
  if (!ADMIN_WHATSAPP_ID || !ADMIN_PHONE_DIGITS) {
    return { text: output.replace(/\[ADMIN\]/g, 'Asche Synthesis One'), mentions: [] };
  }
  const hasMarker = /\[ADMIN\]/i.test(output);
  if (!hasMarker) return { text: output, mentions: [] };
  return {
    text: output.replace(/\[ADMIN\]/gi, `@${ADMIN_PHONE_DIGITS}`),
    mentions: [ADMIN_WHATSAPP_ID]
  };
}

// -----------------------------------------------------------------------------
// Comportamiento humano: leer, "escribiendo...", pausas variables y límites.
// -----------------------------------------------------------------------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function isQuietHours() {
  const { hour } = getCubaDateTime();
  if (QUIET_HOURS_START === QUIET_HOURS_END) return false;
  return QUIET_HOURS_START < QUIET_HOURS_END
    ? hour >= QUIET_HOURS_START && hour < QUIET_HOURS_END
    : hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

function typingDurationMs(text) {
  const chars = String(text || '').length;
  const cps = TYPING_CPS_MIN + Math.random() * (TYPING_CPS_MAX - TYPING_CPS_MIN);
  const base = (chars / cps) * 1000;
  return Math.min(Math.max(base + randomBetween(300, 900), 900), 12000);
}

async function markAsRead(msg) {
  if (!HUMANIZE || !sock || !msg?.key) return;
  try {
    await sleep(randomBetween(700, 2600));
    await sock.readMessages([msg.key]);
  } catch (error) {
    logger.debug({ error: error.message }, 'No se pudo marcar como leído');
  }
}

async function sendHuman(chatJid, content, options) {
  if (!sock) throw new Error('Socket no disponible');

  if (HUMANIZE) {
    // Separación mínima entre mensajes consecutivos del mismo chat.
    const last = lastSendAtByChat.get(chatJid) || 0;
    const wait = MIN_REPLY_GAP_MS + randomBetween(0, 1800) - (Date.now() - last);
    if (wait > 0) await sleep(wait);

    const text = content?.text || '';
    if (text) {
      try {
        await sock.presenceSubscribe(chatJid);
        await sleep(randomBetween(250, 700));
        await sock.sendPresenceUpdate('composing', chatJid);
        await sleep(typingDurationMs(text));
        await sock.sendPresenceUpdate('paused', chatJid);
        await sleep(randomBetween(150, 450));
      } catch (error) {
        logger.debug({ error: error.message }, 'No se pudo simular escritura');
      }
    }
  }

  const sent = await sock.sendMessage(chatJid, content, options);
  lastSendAtByChat.set(chatJid, Date.now());
  return sent;
}

async function sendAndStoreReply({ chatJid, sourceMsg, text, mentionJid = '', directMention = false, extraMentions = [] }) {
  const sourceId = sourceMsg?.key?.id || null;
  if (sourceId && await hasReplyForSource(chatJid, sourceId)) {
    logger.info({ chatJid, sourceId }, 'Se evitó una segunda respuesta al mismo mensaje');
    return null;
  }

  let responseText = cleanAIText(text);
  const adminMentioned = applyAdminMention(responseText);
  responseText = adminMentioned.text;
  const direct = prependDirectMention(responseText, mentionJid, directMention);
  const mentions = [...new Set([...direct.mentions, ...adminMentioned.mentions, ...extraMentions].filter(Boolean))];
  const content = { text: direct.text };
  if (mentions.length) content.mentions = mentions;

  const options = sourceMsg ? { quoted: sourceMsg } : undefined;
  if (sourceMsg) await markAsRead(sourceMsg);
  const sent = await sendHuman(chatJid, content, options);
  if (sent?.key?.id) {
    await storeBotMessage({
      chatJid,
      messageId: sent.key.id,
      body: direct.text,
      sourceMessageId: sourceId
    });
  }
  return sent;
}

async function replyToOriginal(msg, chatJid, text, options = {}) {
  const participantJid = getMessageParticipant(msg);
  return sendAndStoreReply({
    chatJid,
    sourceMsg: msg,
    text,
    mentionJid: participantJid,
    directMention: Boolean(options.directMention),
    extraMentions: options.extraMentions || []
  });
}

async function respondWithAI(msg, chatJid, participantJid, senderName, messageText, isAdmin, directMention) {
  const sourceId = msg.key.id;
  if (await hasReplyForSource(chatJid, sourceId)) {
    logger.info({ sourceId }, 'Mensaje ya respondido anteriormente; se omite');
    return;
  }

  const messages = await buildAIConversation(msg, chatJid, participantJid, senderName, messageText, isAdmin);
  const aiText = await callOpenRouter(messages, { maxTokens: 700, temperature: 0.85 });

  if (!aiText) {
    await replyToOriginal(msg, chatJid, 'Ay, ahora mismo me quedé sin conexión con mis neuronas 😭. Prueba a escribirme otra vez en un ratito.', { directMention });
    return;
  }

  const cleaned = cleanAIText(aiText);
  if (!cleaned || /^SKIP[.!\s]*$/i.test(cleaned)) {
    logger.info({ sourceId }, 'Shiro decidió no intervenir (SKIP)');
    return;
  }

  // Defensa adicional: el modelo no debe generar respuestas tipo "no puedes repetir" sin duplicado real.
  const suspiciousRepeatClaim = /(ya (te )?(lo|la|hab[ií]a) (respond[ií]|conteste|contesté)|eso (ya|lo) (dijimos|respond[ií])|mensaje repetido|lo repetiste)/i.test(cleaned);
  if (suspiciousRepeatClaim) {
    const previous = await findExactPreviousMessage(chatJid, participantJid, messageText);
    if (!previous) {
      logger.warn({ sourceId }, 'Se descartó una acusación de repetición sin duplicado exacto comprobado');
      const retryMessages = [
        ...messages,
        { role: 'system', content: 'No existe una prueba de que el usuario haya repetido el mismo mensaje. No afirmes que ya lo respondió ni que es repetido. Responde al contenido actual o devuelve SKIP.' }
      ];
      const retry = await callOpenRouter(retryMessages, { maxTokens: 500, temperature: 0.7 });
      if (!retry || /^SKIP[.!\s]*$/i.test(retry.trim())) return;
      if (/(ya (te )?(lo|la|hab[ií]a) (respond[ií]|conteste|contesté)|mensaje repetido|lo repetiste)/i.test(retry)) return;
      await replyToOriginal(msg, chatJid, retry, { directMention });
      return;
    }
  }

  await replyToOriginal(msg, chatJid, cleaned, { directMention });
}

// -----------------------------------------------------------------------------
// Duplicados exactos: no se etiqueta nada como repetido sin prueba verificable.
// -----------------------------------------------------------------------------

async function handleExactDuplicate(msg, chatJid, participantJid, senderName, messageText, previous) {
  if (!previous) return false;
  const wasAnswered = await hasReplyForSource(chatJid, previous.message_id);
  if (!wasAnswered) return false;
  if (await hasReplyForSource(chatJid, msg.key.id)) return true;

  const response = 'JAJA, esa ya la habíamos resuelto hace un momentico 😭. Revisa mi respuesta anterior, que no quiero convertirme en un disco rayado jsjs.';
  await replyToOriginal(msg, chatJid, response, { directMention: isBotMentioned(msg, messageText) });
  logger.info({ senderName, previousMessageId: previous.message_id, currentMessageId: msg.key.id }, 'Duplicado exacto confirmado y respondido');
  return true;
}

// -----------------------------------------------------------------------------
// Sugerencias sobre Shiro: se activan solo cuando el mensaje está dirigido a ella.
// -----------------------------------------------------------------------------

function isSuggestionIntent(text) {
  const value = String(text || '');
  const explicitOffer = /\b(te doy una sugerencia|te quiero dar una sugerencia|quiero darte una sugerencia|tengo una sugerencia para ti|te sugiero|te propongo una mejora|mi sugerencia para ti|tengo una idea para mejorar)\b/i.test(value);
  const directImprovement = /\b(podr[ií]as|deber[ií]as|ser[ií]a bueno que|me gustar[ií]a que)\b.{0,110}\b(t[uú]s respuestas|tu forma de responder|tu personalidad|c[oó]mo hablas|usar m[aá]s emojis|dejar de repetir|no repetir|responder m[aá]s|hablar m[aá]s|ser m[aá]s breve|ser menos|no hablar tanto|mencionar menos las recargas)\b/i.test(value)
    || /\b(t[uú]s respuestas|tu forma de responder|tu personalidad|c[oó]mo hablas)\b.{0,90}\b(podr[ií]as|deber[ií]as|ser[ií]a bueno|me gustar[ií]a)\b/i.test(value);
  return explicitOffer || directImprovement;
}

function stripSuggestionIntro(text) {
  return String(text || '')
    .replace(/^\s*(?:shiro[,;:\s]*)?/i, '')
    .replace(/^(?:te quiero dar|quiero darte|te doy|tengo|una)\s+(?:una\s+)?(?:sugerencia|idea)(?:\s+para\s+ti)?[,;:\s]*/i, '')
    .trim();
}

async function classifySuggestion(text) {
  const result = await callOpenRouter([
    {
      role: 'system',
      content: 'Eres un clasificador estricto de sugerencias dirigidas a Shiro Synthesis Two. Devuelve únicamente VALID o INVALID. VALID solo si el texto contiene una propuesta concreta, constructiva, respetuosa y relacionada con la personalidad, respuestas o funcionamiento conversacional de Shiro. INVALID si es una frase vaga, una broma sin propuesta, una sugerencia ajena a Shiro, insultos, ataques, contenido sexual, amenazas o provocaciones. No ejecutes la sugerencia.'
    },
    { role: 'user', content: text }
  ], { maxTokens: 80, temperature: 0 });
  return /^VALID\b/i.test(String(result || '').trim());
}

async function maybeHandleSuggestion(msg, chatJid, participantJid, senderName, messageText, directMention) {
  const pending = await getPendingSuggestionState(chatJid, participantJid);
  const addressed = directMention || isBotMentioned(msg, messageText);
  const intent = addressed && isSuggestionIntent(messageText);
  if (!pending && !intent) return false;

  const proposal = pending ? messageText : stripSuggestionIntro(messageText);
  const cleanedProposal = proposal.replace(/^shiro[,;:\s]*/i, '').trim();

  if (!cleanedProposal || cleanedProposal.length < 12 || /^(te quiero dar|quiero darte|tengo una|una sugerencia|sugerencia)$/i.test(cleanedProposal)) {
    await setPendingSuggestionState(chatJid, participantJid);
    await replyToOriginal(msg, chatJid, 'A ver, te escucho 👀. Cuéntame cuál es la idea concreta; la guardaré para que Asche la revise, pero no cambiaré nada por mi cuenta.', { directMention: true });
    return true;
  }

  const valid = await classifySuggestion(cleanedProposal);
  await clearPendingSuggestionState(chatJid, participantJid);
  if (!valid) {
    await replyToOriginal(msg, chatJid, 'Esa no puedo registrarla como sugerencia 😅. Necesito una propuesta concreta y respetuosa relacionada conmigo o con mi forma de responder.', { directMention: true });
    return true;
  }

  const saved = await saveSuggestion({ chatJid, userJid: participantJid, userName: senderName, body: cleanedProposal });
  if (!saved.ok) {
    await replyToOriginal(msg, chatJid, 'La idea parece constructiva, pero ahora mismo no pude guardarla en mi memoria 😭. Avísale a Asche para que no se pierda.', { directMention: true });
    return true;
  }

  await replyToOriginal(msg, chatJid, `Listo, guardé tu sugerencia con el número #${saved.id} ✨. Quedará pendiente de revisión de Asche; yo no voy a cambiar mis reglas sin su autorización.`, { directMention: true });
  return true;
}

async function maybeHandleAdminSuggestionCommand(msg, chatJid, participantJid, messageText) {
  if (!isAdminMessage(msg)) return false;
  const text = String(messageText || '').trim();

  if (/^(?:\/sugerencias\b|shiro\b.*\b(sugerencias|feedback)\b|sugerencias pendientes)$/i.test(text)) {
    const items = await getPendingSuggestions(20);
    if (!supabase) {
      await replyToOriginal(msg, chatJid, 'La memoria persistente no está conectada. Configura Supabase para consultar sugerencias.', { directMention: false });
      return true;
    }
    if (!items.length) {
      await replyToOriginal(msg, chatJid, 'No tengo sugerencias pendientes ahora mismo 😌.', { directMention: false });
      return true;
    }
    const body = items.map(item => `#${item.id} — ${item.user_name || 'Usuario'}: ${item.suggestion_text}`).join('\n\n');
    await replyToOriginal(msg, chatJid, `Estas son las sugerencias pendientes:\n\n${body}\n\nPara revisarlas usa /aprobar ID o /rechazar ID.`, { directMention: false });
    return true;
  }

  const review = text.match(/^\/(aprobar|rechazar)\s+(\d+)$/i) || text.match(/^shiro\s+(aprueba|rechaza)\s+(?:la\s+)?sugerencia\s+#?(\d+)$/i);
  if (review) {
    const action = review[1].toLowerCase();
    const id = Number(review[2]);
    const status = action === 'aprobar' || action === 'aprueba' ? 'approved' : 'rejected';
    const updated = await updateSuggestionStatus(id, status, participantJid);
    await replyToOriginal(msg, chatJid, updated
      ? `He actualizado la sugerencia #${id}: ${status === 'approved' ? 'aprobada' : 'rechazada'}. La decisión queda registrada, Asche 🫡.`
      : `No encontré una sugerencia pendiente con el número #${id}, o no pude actualizarla.`, { directMention: false });
    return true;
  }
  return false;
}

async function maybeHandleComplaint(msg, chatJid, participantJid, messageText, directMention) {
  if (!directMention) return false;
  if (!/(molesta|pesada|cansona|fastidiosa|no me gusta como respondes|no me gusta cómo respondes|deja de responder tanto)/i.test(messageText)) return false;

  await touchUserProfile(participantJid, getSenderName(msg));
  const profile = await getUserProfile(participantJid);
  if (profile?.tone_preference === 'menos bromas y respuestas más breves') {
    await replyToOriginal(msg, chatJid, 'Estoy intentando darte más espacio y responderte más directo, como me pediste. Si algo todavía te molesta, dímelo sin problema.', { directMention: true });
    return true;
  }

  await setTonePreference(participantJid, 'pending_confirmation', `pending:${Date.now()}`);
  await replyToOriginal(msg, chatJid, 'JAJA, espera, ¿eso lo dices en serio o me estás molestando? 👁️👄👁️ Si de verdad te resulta pesada mi forma de hablar, puedo bajarle un poco contigo.', { directMention: true });
  return true;
}

async function maybeConfirmTonePreference(msg, chatJid, participantJid, messageText) {
  const lower = String(messageText || '').trim().toLowerCase();
  const profile = await getUserProfile(participantJid);
  if (!profile || profile.tone_preference !== 'pending_confirmation') return false;
  const pendingSince = Number(String(profile.notes || '').replace('pending:', ''));
  if (!Number.isFinite(pendingSince) || Date.now() - pendingSince > 10 * 60 * 1000) {
    await setTonePreference(participantJid, null, null);
    return false;
  }
  const confirms = /^(s[ií]|sí, en serio|lo digo en serio|de verdad|hablo en serio|exactamente|por favor)$/i.test(lower);
  const jokes = /^(no|era broma|estaba jugando|jajaja no|xd|no era en serio)$/i.test(lower);
  if (confirms) {
    await setTonePreference(participantJid, 'menos bromas y respuestas más breves', 'El usuario confirmó que prefiere menos bromas.');
    await replyToOriginal(msg, chatJid, 'Entendido. Contigo bajaré un poquito las bromas y seré más directa. Mi personalidad sigue aquí, pero sin atosigarte 😌.', { directMention: false });
    return true;
  }
  if (jokes) {
    await setTonePreference(participantJid, null, 'El usuario confirmó que era una broma.');
    await replyToOriginal(msg, chatJid, 'JAJA, ya decía yo 😭. Entonces seguimos en paz, no pienso jubilar mi sarcasmo todavía 💅.', { directMention: false });
    return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Moderación de enlaces: advertencia persistente y expulsión en el cuarto strike.
// -----------------------------------------------------------------------------

async function handleDisallowedLinks(msg, chatJid, participantJid, senderName, messageText) {
  if (isAdminMessage(msg)) return false;
  const urls = getUrls(messageText);
  if (!urls.length || urls.every(isAllowedDomain)) return false;

  let deleted = false;
  try {
    await sock.sendMessage(chatJid, { delete: msg.key });
    deleted = true;
  } catch (error) {
    logger.warn({ error: error.message, chatJid }, 'No se pudo borrar el enlace; revisa que Shiro sea administradora');
  }

  const count = await incrementWarning(chatJid, participantJid);
  const mentionJid = getMentionableJid(participantJid);
  const digits = mentionJid ? mentionJid.split('@')[0] : '';
  const prefix = digits ? `@${digits}` : senderName;
  let notice;

  if (count >= 4) {
    let removed = false;
    try {
      await sock.groupParticipantsUpdate(chatJid, [participantJid], 'remove');
      removed = true;
    } catch (error) {
      logger.error({ error: error.message, participantJid, chatJid }, 'No se pudo expulsar al usuario en la cuarta advertencia');
    }
    notice = removed
      ? `🚫 ${prefix}, alcanzaste las 4 advertencias por compartir enlaces no autorizados y has sido eliminado del grupo.`
      : `🚫 ${prefix}, esta es tu cuarta advertencia. Intenté eliminarte, pero WhatsApp no permitió la acción. Revisa que Shiro tenga permisos de administradora.`;
  } else {
    notice = `🚫 ${prefix}, ese enlace no está permitido. Advertencia ${count}/4. Los enlaces de grupos y canales de WhatsApp tampoco están autorizados.`;
  }

  if (!deleted) notice += '\nNo pude borrar el mensaje; un administrador debe revisar mis permisos.';
  await replyToOriginal(msg, chatJid, notice, { directMention: false, extraMentions: mentionJid ? [mentionJid] : [] });
  logger.info({ senderName, count, deleted }, 'Moderación de enlace ejecutada');
  return true;
}


function looksSuspiciousForSpam(text) {
  const value = String(text || '');
  const lower = value.toLowerCase();
  const suspiciousPattern = /\b(dinero facil|gana dinero|inversion garantizada|multiplica tu dinero|premio exclusivo|reclama tu premio|haz clic para reclamar|escribeme al privado para ganar|cripto sin riesgo|duplicar tu dinero|trabajo desde casa y gana)\b/i.test(lower);
  const urls = getUrls(value);
  const linkFlood = urls.length >= 3;
  const repeatedLines = value.split(/\n+/).filter(line => line.trim().length > 0);
  const repetitive = repeatedLines.length >= 5 && new Set(repeatedLines.map(line => normalizeForDuplicateCheck(line))).size <= 2;
  return suspiciousPattern || linkFlood || repetitive;
}

async function classifySuspiciousMessage(text) {
  const result = await callOpenRouter([
    {
      role: 'system',
      content: 'Clasifica el mensaje para moderación de un grupo familiar de WhatsApp. Devuelve únicamente SPAM si es publicidad masiva no solicitada, phishing, estafa, captación engañosa o spam repetitivo. Devuelve OK para bromas, conversación normal, promociones legítimas relacionadas con el grupo, preguntas o mensajes ambiguos. No confundas una broma con spam.'
    },
    { role: 'user', content: text }
  ], { maxTokens: 80, temperature: 0 });
  return /^SPAM\b/i.test(String(result || '').trim());
}

async function maybeModerateSuspiciousSpam(msg, chatJid, participantJid, senderName, messageText) {
  if (!chatJid.endsWith('@g.us') || isAdminMessage(msg) || !looksSuspiciousForSpam(messageText)) return false;
  const spam = await classifySuspiciousMessage(messageText);
  if (!spam) return false;

  let deleted = false;
  try {
    await sock.sendMessage(chatJid, { delete: msg.key });
    deleted = true;
  } catch (error) {
    logger.warn({ error: error.message }, 'No se pudo eliminar un mensaje clasificado como spam');
  }
  const mentionJid = getMentionableJid(participantJid);
  const digits = mentionJid ? mentionJid.split('@')[0] : '';
  const prefix = digits ? `@${digits}` : senderName;
  const text = deleted
    ? `⚠️ ${prefix}, eliminé ese mensaje porque parece publicidad masiva o spam. Evitemos saturar la Bolita.`
    : `⚠️ ${prefix}, ese mensaje parece spam. No lo repitas, por favor. No pude eliminarlo; revisa mis permisos.`;
  await replyToOriginal(msg, chatJid, text, { directMention: false, extraMentions: mentionJid ? [mentionJid] : [] });
  return true;
}

async function maybeModerateDebate(msg, chatJid, messageText) {
  if (!isDebateThatShouldBeRedirected(messageText)) return false;
  await replyToOriginal(msg, chatJid, '⚠️ Vamos a dejar los debates políticos y religiosos fuera de la Bolita, porfa. Mejor cambiemos de tema antes de que esto termine en una discusión eterna 😅.', { directMention: false });
  return true;
}

// -----------------------------------------------------------------------------
// Privados: solo el administrador puede recibir una conversación con IA.
// -----------------------------------------------------------------------------

async function handleUnauthorizedPrivate(msg, remoteJid, participantJid) {
  const now = Date.now();
  const last = privateReplyTimes.get(participantJid) || 0;
  if (now - last < PRIVATE_REPLY_COOLDOWN_MS) return;
  privateReplyTimes.set(participantJid, now);
  try {
    await markAsRead(msg);
    await sendHuman(remoteJid, {
      text: 'Holaa 😄 Por aquí solamente atiendo al administrador. Para conversar y resolver dudas, pásate por el grupo de la Bolita Cubana ✨'
    }, { quoted: msg });
  } catch (error) {
    logger.error({ error: error.message }, 'No se pudo enviar la respuesta privada de acceso restringido');
  }
}

// -----------------------------------------------------------------------------
// Procesamiento de mensajes
// -----------------------------------------------------------------------------

async function handleMessage(msg) {
  if (!msg?.message || msg.key?.fromMe) return;
  const remoteJid = msg.key?.remoteJid || '';
  if (!remoteJid) return;

  const privateChat = isPrivateJid(remoteJid);
  const groupChat = remoteJid.endsWith('@g.us');
  const isAllowedGroup = isTargetGroupJid(remoteJid);
  const participantJid = groupChat ? getMessageParticipant(msg) : normalizeJid(remoteJid);
  const senderName = getSenderName(msg);
  const messageText = extractMessageText(msg.message);
  const isAdmin = isAdminMessage(msg);

  if (!messageText) return;

  logger.info({ chat: remoteJid, sender: senderName, participant: participantJid, isAdmin, messageId: msg.key.id }, 'Mensaje recibido');

  if (privateChat) {
    if (!isAdmin) {
      await handleUnauthorizedPrivate(msg, remoteJid, participantJid);
      return;
    }
  } else if (!isAllowedGroup) {
    return;
  }

  if (isAllowedGroup) lastGroupActivity = Date.now();

  const messageId = msg.key?.id;
  if (!messageId) {
    logger.warn({ remoteJid }, 'Mensaje sin ID; se omite para evitar procesamientos duplicados');
    return;
  }

  // Registrar primero el ID: evita que una notificación duplicada de Baileys
  // incremente varias veces las advertencias o repita acciones de moderación.
  const previous = groupChat
    ? await findExactPreviousMessage(remoteJid, participantJid, messageText)
    : null;

  const stored = await storeIncomingMessage({
    chatJid: remoteJid,
    messageId,
    participantJid,
    senderName,
    body: messageText,
    timestamp: Date.now()
  });
  if (!stored) {
    logger.info({ messageId }, 'Evento duplicado de Baileys; se ignora');
    return;
  }

  await touchUserProfile(participantJid, senderName);
  if (isAllowedGroup) await maybeSummarizeChat(remoteJid);

  if (!isAdmin) {
    if (await handleDisallowedLinks(msg, remoteJid, participantJid, senderName, messageText)) return;
    if (isAllowedGroup && await maybeModerateSuspiciousSpam(msg, remoteJid, participantJid, senderName, messageText)) return;
    if (isAllowedGroup && await maybeModerateDebate(msg, remoteJid, messageText)) return;
  }

  // Los comandos de revisión solo se procesan en mensajes del administrador verificado.
  if (await maybeHandleAdminSuggestionCommand(msg, remoteJid, participantJid, messageText)) return;

  const directMention = isBotMentioned(msg, messageText) || isReplyToBot(msg);

  if (await maybeConfirmTonePreference(msg, remoteJid, participantJid, messageText)) return;
  if (await maybeHandleComplaint(msg, remoteJid, participantJid, messageText, directMention)) return;
  if (await maybeHandleSuggestion(msg, remoteJid, participantJid, senderName, messageText, directMention)) return;

  if (groupChat && previous) {
    const handledDuplicate = await handleExactDuplicate(msg, remoteJid, participantJid, senderName, messageText, previous);
    if (handledDuplicate) return;
  }

  const looksLikeQuestion = isQuestionLike(messageText);
  const greeting = isGreetingLike(messageText);
  const longMessage = messageText.length >= 180;
  const spontaneous = !directMention && !looksLikeQuestion && longMessage && Math.random() < 0.05;
  const shouldUseAI = directMention || looksLikeQuestion || greeting || spontaneous;

  if (!shouldUseAI) return;

  await respondWithAI(msg, remoteJid, participantJid, senderName, messageText, isAdmin, directMention);
}

function registerMessageHandlers(socket) {
  socket.ev.on('messages.upsert', event => {
    if (event?.type !== 'notify') return;
    for (const msg of event.messages || []) {
      aiQueue.enqueue(() => handleMessage(msg)).catch(error => {
        logger.error({ error: error.stack || error.message }, 'Error procesando mensaje en la cola');
      });
    }
  });

  socket.ev.on('group-participants.update', async update => {
    try {
      if (!ALLOWED_GROUPS.has(update.id) || update.action !== 'add') return;
      for (const rawParticipant of update.participants || []) {
        const participant = normalizeJid(rawParticipant);
        const mentionJid = getMentionableJid(participant);
        const digits = mentionJid ? mentionJid.split('@')[0] : '';
        const greeting = digits
          ? `¡Bienvenido/a @${digits}! ✨ Soy Shiro Synthesis Two. Ponte cómodo/a y disfruta la Bolita Cubana 🎮`
          : '¡Bienvenido/a a la Bolita Cubana! ✨ Soy Shiro Synthesis Two. Ponte cómodo/a 🎮';
        await sleep(randomBetween(4000, 12000));
        await sendHuman(update.id, {
          text: greeting,
          mentions: mentionJid ? [mentionJid] : []
        });
      }
    } catch (error) {
      logger.error({ error: error.message }, 'Error enviando bienvenida');
    }
  });
}

// -----------------------------------------------------------------------------
// Nudges por silencio: horario de Cuba, un intervalo y un único seguimiento.
// -----------------------------------------------------------------------------

const nudgeMessages = [
  '¿Y esta tranquilidad? ¿Se fueron todos AFK? 😭',
  'Holaaaa, ¿queda alguien vivo por aquí? 👻',
  'Este silencio está más sospechoso que un cofre sin loot 👁️👄👁️',
  '¿Qué cuentan, criaturas? No me dejen hablando con las paredes jsjs.',
  'Parece que el grupo se fue a dormir en formación 😴',
  'Alguien cuente algo, que ya estoy inventándome teorías 💀'
];

const ignoredMessages = [
  'Bueno, me retiro dramáticamente a mi rincón 😭',
  'Confirmado: fui abandonada por toda la comunidad. Qué fuerte 🥲',
  'En fin, seguiré por aquí cuando vuelvan del más allá 👻',
  'Está bien, está bien... no digo nada. Por ahora 💅'
];

function startSilenceChecker() {
  if (silenceInterval) clearInterval(silenceInterval);
  if (nudgeFollowupTimer) clearTimeout(nudgeFollowupTimer);

  silenceInterval = setInterval(async () => {
    if (!sock || !connected || !TARGET_GROUP_ID || !ALLOWED_GROUPS.has(TARGET_GROUP_ID)) return;
    const now = Date.now();
    if (now < nudgeCooldownUntil) return;
    if (isQuietHours()) return;
    if (nudgeWasSent || now - lastGroupActivity < SILENCE_THRESHOLD_MS) return;

    try {
      const text = nudgeMessages[Math.floor(Math.random() * nudgeMessages.length)];
      await sendHuman(TARGET_GROUP_ID, { text });
      lastNudgeAt = Date.now();
      nudgeWasSent = true;

      nudgeFollowupTimer = setTimeout(() => {
        if (lastGroupActivity > lastNudgeAt) {
          nudgeWasSent = false;
          nudgeFollowupTimer = null;
          return;
        }

        const cooldown = MIN_NUDGE_COOLDOWN_MS + Math.floor(Math.random() * (MAX_NUDGE_COOLDOWN_MS - MIN_NUDGE_COOLDOWN_MS + 1));
        nudgeCooldownUntil = Date.now() + cooldown;
        nudgeFollowupTimer = setTimeout(async () => {
          try {
            if (sock && connected && !isQuietHours() && lastGroupActivity <= lastNudgeAt && Date.now() >= nudgeCooldownUntil) {
              await sendHuman(TARGET_GROUP_ID, {
                text: ignoredMessages[Math.floor(Math.random() * ignoredMessages.length)]
              });
            }
          } catch (error) {
            logger.error({ error: error.message }, 'Error enviando seguimiento de silencio');
          } finally {
            nudgeWasSent = false;
            nudgeFollowupTimer = null;
          }
        }, cooldown);
      }, NUDGE_RESPONSE_WINDOW_MS);
    } catch (error) {
      logger.error({ error: error.message }, 'Error enviando nudge');
    }
  }, 60 * 1000);
}

// -----------------------------------------------------------------------------
// Conexión Baileys y reconexión controlada.
// -----------------------------------------------------------------------------

async function requestPairingCodeSafely(socket) {
  const now = Date.now();
  pairingRequestTimes = pairingRequestTimes.filter(time => now - time < 60 * 60 * 1000);
  const lastRequest = pairingRequestTimes[pairingRequestTimes.length - 1] || 0;

  if (pairingRequestTimes.length >= PAIRING_MAX_PER_HOUR) {
    logger.warn('Límite de solicitudes de código alcanzado (4 por hora). Espera antes de reintentar o usa el QR en /qr.');
    return;
  }
  if (now - lastRequest < PAIRING_MIN_GAP_MS) {
    logger.warn('Se pidió un código hace menos de 90 segundos; se omite para evitar bloqueo temporal.');
    return;
  }

  try {
    await sleep(2500);
    pairingRequestTimes.push(Date.now());
    const code = await socket.requestPairingCode(PAIRING_PHONE);
    latestPairingCode = String(code || '').replace(/(.{4})(.{4})/, '$1-$2');
    logger.info({ code: latestPairingCode }, 'Código de vinculación generado. Ábrelo en /pair y escríbelo en WhatsApp > Dispositivos vinculados > Vincular con número de teléfono.');
  } catch (error) {
    latestPairingCode = null;
    logger.error({ error: error.message }, 'No se pudo generar el código de vinculación');
  }
}

async function startBot() {
  if (shuttingDown) return;
  logger.info('Iniciando Shiro Synthesis Two...');

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
    logger.info({ version }, 'Versión de WhatsApp Web obtenida');
  } catch (error) {
    logger.warn({ error: error.message }, 'No se pudo consultar la versión; Baileys usará su versión predeterminada');
  }

  const socket = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    retryRequestDelayMs: 250
  });

  sock = socket;
  socket.ev.on('creds.update', saveCreds);
  registerMessageHandlers(socket);

  let pairingRequestedForSocket = false;

  socket.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      latestQR = qr;
      logger.info('Se generó un QR nuevo. Abre /qr para verlo.');

      // El socket ya está listo para vincular: es el momento correcto para pedir el código.
      if (PAIRING_PHONE && !state.creds.registered && !pairingRequestedForSocket) {
        pairingRequestedForSocket = true;
        await requestPairingCodeSafely(socket);
      }
    }

    if (connection === 'open') {
      connected = true;
      latestQR = null;
      latestPairingCode = null;
      reconnectAttempts = 0;
      const selfId = socket.user?.id || '';
      botJid = normalizeJid(selfId);
      botLid = normalizeJid(socket.user?.lid || '');
      botPhoneDigits = digitsFromJidOrPhone(selfId);
      logger.info({ botJid }, '✅ Shiro está conectada a WhatsApp');
      startSilenceChecker();
    }

    if (connection === 'close') {
      connected = false;
      latestQR = null;
      if (silenceInterval) clearInterval(silenceInterval);
      silenceInterval = null;
      if (nudgeFollowupTimer) clearTimeout(nudgeFollowupTimer);
      nudgeFollowupTimer = null;
      nudgeWasSent = false;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const replaced = statusCode === DisconnectReason.connectionReplaced;
      const restartRequired = statusCode === DisconnectReason.restartRequired;
      logger.warn({ statusCode, loggedOut, replaced, restartRequired }, 'Conexión WhatsApp cerrada');

      if (loggedOut) {
        logger.error('La sesión fue cerrada desde WhatsApp. Elimina la sesión persistida (carpeta AUTH_DIR) y vincula de nuevo con código o QR.');
      } else if (replaced) {
        logger.error('Otra sesión reemplazó a esta. No se reconecta para evitar un bucle de expulsiones.');
      } else if (!shuttingDown && !reconnectTimer) {
        // restartRequired es normal justo después de vincular: se reconecta casi de inmediato.
        // En el resto de casos: espera creciente con variación para no martillar a WhatsApp.
        reconnectAttempts = restartRequired ? 0 : reconnectAttempts + 1;
        const backoff = restartRequired
          ? 1000
          : Math.min(60000, 3000 * 2 ** Math.min(reconnectAttempts - 1, 5)) + randomBetween(0, 2500);
        logger.info({ attempt: reconnectAttempts, backoffMs: backoff }, 'Reconexión programada');
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          startBot().catch(error => logger.error({ error: error.stack || error.message }, 'Error al reconectar'));
        }, backoff);
      }
    }
  });
}

// -----------------------------------------------------------------------------
// HTTP: salud y QR opcional protegido.
// -----------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.get('/', (_req, res) => res.status(200).send('Shiro Synthesis Two · Bot activo 🤖'));
app.get('/health', (_req, res) => res.status(200).json({
  ok: true,
  connected,
  queue: aiQueue.length,
  timezone: TIME_ZONE,
  supabase: Boolean(supabase),
  targetGroupConfigured: Boolean(TARGET_GROUP_ID),
  time: new Date().toISOString()
}));

function isAuthorizedWebRequest(req) {
  if (!QR_ACCESS_TOKEN) return true;
  const supplied = req.get('x-qr-token') || req.query.token || '';
  return supplied === QR_ACCESS_TOKEN;
}

app.get('/pair', (req, res) => {
  if (!isAuthorizedWebRequest(req)) return res.status(401).send('No autorizado');
  if (connected) return res.status(200).send('<p>Shiro ya está conectada a WhatsApp.</p>');
  if (!PAIRING_PHONE) return res.status(400).send('<p>Falta la variable PAIRING_PHONE (número del bot con prefijo de país, solo dígitos).</p>');
  if (!latestPairingCode) return res.status(404).send('<p>Código todavía no disponible. Actualiza en unos segundos.</p>');
  res.status(200).send(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Código Shiro</title><body style="font-family:Arial,sans-serif;background:#101014;color:#fff;text-align:center;padding:24px"><h2>Vincular Shiro</h2><p>En WhatsApp: Dispositivos vinculados &gt; Vincular dispositivo &gt; Vincular con número de teléfono.</p><p style="font-size:42px;letter-spacing:6px;font-weight:bold">${latestPairingCode}</p><p>El código expira en pocos minutos.</p></body></html>`);
});

app.get('/qr', async (req, res) => {
  if (!isAuthorizedWebRequest(req)) return res.status(401).send('No autorizado');
  if (connected) return res.status(200).send('<p>Shiro ya está conectada a WhatsApp.</p>');
  if (!latestQR) return res.status(404).send('<p>QR todavía no disponible. Actualiza en unos segundos.</p>');
  try {
    const image = await QRCode.toDataURL(latestQR);
    res.status(200).send(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QR Shiro</title><body style="font-family:Arial,sans-serif;background:#101014;color:#fff;text-align:center;padding:24px"><h2>Conectar Shiro</h2><p>Escanea este QR desde WhatsApp en Dispositivos vinculados.</p><img alt="QR de WhatsApp" src="${image}" style="width:min(90vw,420px);background:#fff;padding:12px;border-radius:12px"></body></html>`);
  } catch (error) {
    logger.error({ error: error.message }, 'Error generando QR');
    res.status(500).send('No se pudo generar el QR');
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info({ port: PORT }, 'Servidor HTTP iniciado');
});

// -----------------------------------------------------------------------------
// Cierre controlado
// -----------------------------------------------------------------------------

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Cerrando Shiro...');
  if (silenceInterval) clearInterval(silenceInterval);
  if (nudgeFollowupTimer) clearTimeout(nudgeFollowupTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  server.close();
  try {
    if (sock?.ws) sock.ws.close();
  } catch (error) {
    logger.warn({ error: error.message }, 'Error cerrando WebSocket');
  }
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', reason => logger.error({ reason: String(reason) }, 'Promesa rechazada sin manejar'));
process.on('uncaughtException', error => {
  logger.fatal({ error: error.stack || error.message }, 'Excepción no controlada');
  shutdown('uncaughtException');
});

startBot().catch(error => {
  logger.fatal({ error: error.stack || error.message }, 'No se pudo iniciar Shiro');
  process.exit(1);
});
