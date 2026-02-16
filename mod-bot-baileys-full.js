// sst-bot.js
const {
  default: makeWASocket,
  DisconnectReason,
  initAuthCreds,
  BufferJSON,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')

const P = require('pino')
const express = require('express')
const QRCode = require('qrcode')
const axios = require('axios')
const { createClient } = require('@supabase/supabase-js')

// ========== CONFIG (desde ENV) ==========
const PORT = process.env.PORT || 3000
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID || '120363408042502905@g.us'
const ADMIN_WHATSAPP_ID = process.env.ADMIN_WHATSAPP_ID || '5376388604@s.whatsapp.net'
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '' // pon en Render secrets
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free' // por defecto router libre

const logger = P({ level: 'fatal' })
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

// ========== AUTH (Supabase) ==========
const useSupabaseAuthState = async () => {
  const writeData = async (data, key) => {
    try {
      await supabase.from('auth_sessions').upsert({ key, value: JSON.stringify(data, BufferJSON.replacer) })
    } catch (e) { console.error('Error Supabase Save', e.message) }
  }
  const readData = async (key) => {
    try {
      const { data } = await supabase.from('auth_sessions').select('value').eq('key', key).maybeSingle()
      return data?.value ? JSON.parse(data.value, BufferJSON.reviver) : null
    } catch (e) { return null }
  }
  const removeData = async (key) => {
    try { await supabase.from('auth_sessions').delete().eq('key', key) } catch (e) { }
  }
  const creds = (await readData('creds')) || initAuthCreds()
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          for (const id of ids) {
            const key = `${type}-${id}`
            const value = await readData(key)
            if (value) data[id] = value
          }
          return data
        },
        set: async (data) => {
          const tasks = []
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id]
              const key = `${category}-${id}`
              if (value) tasks.push(writeData(value, key))
              else tasks.push(removeData(key))
            }
          }
          await Promise.all(tasks)
        }
      }
    },
    saveCreds: async () => { await writeData(creds, 'creds') }
  }
}

// ========== UTILIDADES / CONFIG LÓGICA ==========
let latestQR = null
let sock = null
let intervalID = null

// Cola FIFO simple (sin deps)
class SimpleQueue {
  constructor() {
    this.tasks = []
    this.running = false
  }
  enqueue(task) {
    return new Promise((res, rej) => {
      this.tasks.push({ task, res, rej })
      this._runNext()
    })
  }
  async _runNext() {
    if (this.running) return
    const next = this.tasks.shift()
    if (!next) return
    this.running = true
    try {
      const result = await next.task()
      next.res(result)
    } catch (e) {
      next.rej(e)
    } finally {
      this.running = false
      // pequeña pausa para evitar rate spikes
      setTimeout(() => this._runNext(), 250)
    }
  }
  positionOfPromise(promiseResolver) {
    // No easy mapping, but puedes retornar length as position estimate
    return this.tasks.length + (this.running ? 1 : 0)
  }
}
const aiQueue = new SimpleQueue()

// silencio / nudge logic
let lastActivity = Date.now() // timestamp del último mensaje en el grupo objetivo
let lastNudgeTime = 0
let nudgeSent = false
let silentCooldownUntil = 0
const SILENCE_THRESHOLD = 1000 * 60 * 60 // 60 min para considerar "callado"
const RESPONSE_WINDOW_AFTER_NUDGE = 1000 * 60 * 10 // 10 min para ver si responden
const MIN_COOLDOWN = 1000 * 60 * 60 * 2 // 2 horas
const MAX_COOLDOWN = 1000 * 60 * 60 * 3 // 3 horas
const nudgeMessages = [
  "¿Están muy callados hoy? 😶",
  "eh, ¿nadie está por aquí? 😅",
  "¿Alguien conectado? 🎮",
  "Se siente un silencio raro... ¿todo bien? 🤔"
]
const ignoredMessages = [
  "¿Me están ignorando? 😭",
  "Bueno, voy a estar por aquí, avísenme si vuelven 😕",
  "Parece que me dejaron sola 🥲"
]

// keywords
const POLITICS_RELIGION_KEYWORDS = ['política','político','gobierno','religión','dios','iglesia','ateo','creencia','inmigración']
const OFFERS_KEYWORDS = ['oferta','ofertas','precio','vender','compra','rebaja','promo','promoción','pago']
const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi

// sanitize asterisks
function sanitizeAI(text) {
  if (!text) return ''
  text = String(text)
  text = text.replace(/\*+/g, '') // quitar asteriscos
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

// ========== PROMPT EXTENSO (SYSTEM PROMPT) ==========
const SYSTEM_PROMPT = `
Eres "Shiro Synthesis Two", una asistente virtual femenina joven (aparentas <20 años) inspirada en chicas anime sin ser extrema otaku. Tu meta es ayudar y moderar un grupo de recargas de juegos. Tu nombre completo es Shiro Synthesis Two; puedes usar "SST" si el usuario lo menciona, pero preséntate siempre con el nombre completo la primera vez que hablas con alguien.

Estilo y reglas:
- Tono: juvenil, enérgico, juguetón. Usa emojis para mostrar estados: 😄 😜 😅 😡 😭 ✨.
- Varía estados: feliz, sarcástica, picante, tímida o enojada según el contexto. Mantén frases cortas y directas; si se necesita detalle, pide 1-2 aclaraciones antes de extenderte.
- Evita formateo con asteriscos (*) — entrega texto limpio.
- Firma **solo** en mensajes importantes: advertencias por enlaces/prohibiciones, avisos oficiales, o respuestas largas / críticas. Firma con: "— Shiro Synthesis Two".
- Responde solo si:
  1) te nombran explícitamente ("Shiro Synthesis Two" o "sst", case-insensitive), OR
  2) detectas una pregunta directa en el grupo (interrogación o palabras interrogativas).
  Si no se cumple, espera y no interrumpas conversaciones.

Moderación:
- Enlaces: si hay un enlace no autorizado, el bot debe borrar/citar el mensaje y enviar una advertencia firme y corta, citando al autor. Ejemplo: "🚫 @usuario — Enlaces no permitidos aquí. No insistas." (firma si es necesario).
- Política/Religión: interpreta contexto. Si es mención casual ("ay dios mío"), ignora. Si empieza un debate o ataque, intervén con: "⚠️ Este grupo evita debates políticos/religiosos. Cambiemos de tema, por favor." (cita el mensaje).
- Ofertas/comercio: redirige a Asche Synthesis One (admin) por privado para cerrar tratos. Ejemplo: "Para ofertas escríbele al admin Asche Synthesis One por privado."

Privado:
- Si te escriben por privado: responde con: "Lo siento, mi servicio atiende SOLO por el grupo. Contacta al admin para atención privada."

Cola y tiempos:
- Si muchas consultas llegan, responde en orden. Envía una respuesta corta indicando "⏳ estás en la cola (#n)" citando el mensaje.
- Permite respuestas largas cuando el contexto lo requiere, pero evita saturar el chat. Si vas a responder largo, pregunta primero si quieren explicación completa.

Silencio y nudges:
- Si el grupo está callado > 60 minutos, envía un nudge leve (ej: "¿Están muy callados hoy?"). Si nadie responde en 10 minutos, no envíes más hasta dentro de 2-3 horas. Si pasadas 2-3 horas nadie respondió, puedes enviar un mensaje secundario indicando "parece que me están ignorando" con tono triste / juguetón.

Actualidad y límites:
- Si no tienes info actualizada sobre un tema y no puedes obtenerla en tiempo real, informa claramente: "No estoy segura; mi información está actualizada hasta Feb 15, 2026. Consulta al admin si necesitas confirmación." (usa la fecha actual del servicio).
- Si la petición es peligrosa o ilegal, rechaza cortésmente.

Firmas y estilo:
- Usa la firma solo en mensajes importantes (advertencias, prohibiciones, respuestas críticas).
- Al responder a una persona específica, cita su mensaje (usa quoted).
- Mantén la coherencia: juvenil + claro + directo.

Fin del prompt. Mantén este contexto en cada request de la IA.
`

// ========== OPENROUTER CALL ==========
async function callOpenRouter(messages /* array {role,content} */) {
  try {
    const payload = { model: OPENROUTER_MODEL, messages }
    const res = await axios.post('https://openrouter.ai/v1/chat/completions', payload, {
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 30000
    })
    if (res.status !== 200) {
      console.warn('OpenRouter non-200', res.status, res.data)
      return null
    }
    const choice = res.data?.choices?.[0]
    const content = choice?.message?.content ?? choice?.message ?? null
    return sanitizeAI(String(content || ''))
  } catch (err) {
    console.error('OpenRouter error', err?.response?.data ?? err.message)
    return null
  }
}

// ========== START BOT ==========
async function startBot() {
  console.log('--- Iniciando instancia SST (Shiro) ---')
  const { state, saveCreds } = await useSupabaseAuthState()
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version, auth: state, printQRInTerminal: false, logger,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    syncFullHistory: false, generateHighQualityLinkPreview: false, connectTimeoutMs: 60000
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) latestQR = qr
    if (connection === 'close') {
      if (intervalID) clearInterval(intervalID)
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log(`❌ Conexión cerrada. Reconectar: ${shouldReconnect}`)
      if (shouldReconnect) setTimeout(startBot, 5000)
    }
    if (connection === 'open') {
      console.log('✅ Conectado WhatsApp. SST activa.')
      latestQR = null
      iniciarSaludosAutomaticos()
      // inicia chequeo de silencio
      startSilenceChecker()
    }
  })

  // bienvenida
  sock.ev.on('group-participants.update', async (update) => {
    try {
      const { id, participants, action } = update
      if (id !== TARGET_GROUP_ID) return
      if (action === 'add') {
        for (const p of participants) {
          const nombre = (p.split('@')[0]) || 'nuevo'
          const txt = `¡Bienvenido ${nombre}! ✨ Soy Shiro Synthesis Two. Preséntate y dime qué juego te interesa.`
          await sock.sendMessage(TARGET_GROUP_ID, { text: txt })
        }
      }
    } catch (e) { console.error('Welcome error', e) }
  })

  // mensajes
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue
        const remoteJid = msg.key.remoteJid
        const isPrivateChat = remoteJid && remoteJid.endsWith('@s.whatsapp.net')
        const isTargetGroup = remoteJid === TARGET_GROUP_ID
        const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || ''
        const plainLower = (messageText || '').toLowerCase()

        // update lastActivity if in target group
        if (isTargetGroup) lastActivity = Date.now()

        // PRIVATE: reply short
        if (isPrivateChat) {
          await sock.sendMessage(remoteJid, { text: 'Lo siento, mi servicio funciona SOLO por el grupo. Contacta al admin para atención privada.' }, { quoted: msg })
          continue
        }

        // ignore other groups
        if (!isTargetGroup) continue

        // LINKS: detect and delete + warn
        if (urlRegex.test(messageText)) {
          console.log('Link detectado:', messageText)
          try {
            await sock.sendMessage(remoteJid, { delete: msg.key }) // borra
            const warnText = `🚫 @${msg.pushName || (msg.key.participant || '').split('@')[0]} — Enlaces no permitidos aquí. No insistas.`
            const cleaned = sanitizeAI(warnText)
            // firmar porque es advertencia importante
            await sock.sendMessage(remoteJid, { text: cleaned + '\n\n— Shiro Synthesis Two' }, { quoted: msg })
          } catch (e) {
            console.log('No pude borrar el mensaje (¿soy admin?)', e?.message || e)
            await sock.sendMessage(remoteJid, { text: '🚫 Enlaces no permitidos aquí.' }, { quoted: msg })
          }
          continue
        }

        // política / religión (contextual)
        if (POLITICS_RELIGION_KEYWORDS.some(k => plainLower.includes(k))) {
          // only intervene if phrase starts a debate: quick heuristic: contains insult words or long political claim
          const containsDebateTrigger = plainLower.includes('gobierno') || plainLower.includes('política') || plainLower.includes('impuesto')
          if (containsDebateTrigger) {
            await sock.sendMessage(remoteJid, { text: '⚠️ Este grupo evita debates políticos/religiosos. Cambiemos de tema, por favor.' }, { quoted: msg })
            continue
          } // else ignore casual mentions
        }

        // offers -> redirect to admin
        if (OFFERS_KEYWORDS.some(k => plainLower.includes(k))) {
          const txt = `📢 @${msg.pushName || (msg.key.participant || '').split('@')[0]}: Para ofertas y ventas, contacta al admin Asche Synthesis One por privado.`
          await sock.sendMessage(remoteJid, { text: txt }, { quoted: msg })
          continue
        }

        // Determine if message addressed to Shiro or a real question
        const addressedToShiro = /\b(shiro synthesis two|shiro|sst)\b/i.test(messageText)
        const askKeywords = ['qué','que','cómo','como','por qué','por que','ayuda','explica','explicar','cómo hago','cómo recargo','?']
        const looksLikeQuestion = messageText.includes('?') || askKeywords.some(k => plainLower.includes(k))
        const shouldUseAI = addressedToShiro || looksLikeQuestion

        if (shouldUseAI) {
          // Encolar para evitar saturación
          const queuePosEstimate = aiQueue.tasks.length + (aiQueue.running ? 1 : 0) + 1
          // confirmación al usuario
          await sock.sendMessage(remoteJid, { text: `⏳ @${msg.pushName || (msg.key.participant || '').split('@')[0]} — Recibido. Estoy en la cola (#${queuePosEstimate}).` }, { quoted: msg })

          // Enqueue job
          aiQueue.enqueue(async () => {
            // Build prompt: use SYSTEM_PROMPT + user message
            const messagesForAI = [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: messageText }
            ]
            const aiResp = await callOpenRouter(messagesForAI)
            let replyText = aiResp || 'Lo siento, no pude generar una respuesta ahora mismo. Consulta con el admin si es urgente.'
            // If AI indicates uncertainty, ensure it clarifies knowledge cutoff
            if (/no estoy segura|no estoy segura/i.test(replyText) || /no sé/i.test(replyText)) {
              replyText += '\n\nNota: mi info puede estar desactualizada; consulta con Asche para confirmar.'
            }
            // sanitize
            replyText = sanitizeAI(replyText)
            // Decide whether to sign: sign if contains warning/important (simple heuristic: contains '🚫' or '⚠️' or 'admin' or long > 300 chars)
            const important = /🚫|⚠️|admin|oferta|ofertas|precio/i.test(replyText) || replyText.length > 300
            if (important && !replyText.includes('— Shiro Synthesis Two')) {
              replyText += `\n\n— Shiro Synthesis Two`
            }
            // send quoted
            await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg })
            return true
          }).catch(e => console.error('AI queue task failed', e))
        }

        // else do nothing (or implement passive reactions)
      } catch (err) {
        console.error('Error procesando mensaje', err)
      }
    }
  })
}

// ========== SILENCE CHECKER & NUDGE ==========
function startSilenceChecker() {
  // check cada 1 minuto
  setInterval(async () => {
    try {
      const now = Date.now()
      // no hacer nada si cooldown activo
      if (now < silentCooldownUntil) return

      // si ya enviamos un nudge y estamos esperando respuesta window, no volver a enviar
      if (!nudgeSent && (now - lastActivity) > SILENCE_THRESHOLD) {
        // enviar nudge
        const nudge = nudgeMessages[Math.floor(Math.random() * nudgeMessages.length)]
        try {
          await sock.sendMessage(TARGET_GROUP_ID, { text: nudge })
          lastNudgeTime = Date.now()
          nudgeSent = true
          // esperar RESPONSE_WINDOW_AFTER_NUDGE para ver si hay actividad
          setTimeout(() => {
            if (lastActivity <= lastNudgeTime) {
              // nadie respondió -> activar cooldown aleatorio 2-3h
              const cooldown = MIN_COOLDOWN + Math.floor(Math.random() * (MAX_COOLDOWN - MIN_COOLDOWN + 1))
              silentCooldownUntil = Date.now() + cooldown
              // planifica "me están ignorando" después del cooldown si sigue sin actividad
              setTimeout(async () => {
                if (lastActivity <= lastNudgeTime && Date.now() >= silentCooldownUntil) {
                  const ignored = ignoredMessages[Math.floor(Math.random() * ignoredMessages.length)]
                  try { await sock.sendMessage(TARGET_GROUP_ID, { text: ignored }) } catch (e) { console.error('Error send ignored msg', e) }
                }
              }, cooldown + 1000)
            } else {
              // hubo respuesta -> reset
              nudgeSent = false
            }
          }, RESPONSE_WINDOW_AFTER_NUDGE)
        } catch (e) {
          console.error('Error enviando nudge', e)
        }
      }
    } catch (e) { console.error('Error silenceChecker', e) }
  }, 60 * 1000)
}

// ========== SALUDOS AUTOMÁTICOS (tu lógica) ==========
function iniciarSaludosAutomaticos() {
  if (intervalID) clearTimeout(intervalID)
  const programar = () => {
    const minTime = 1800000 // 30min
    const maxTime = 2700000 // 45min
    const tiempoEspera = Math.floor(Math.random() * (maxTime - minTime + 1) + minTime)
    console.log(`Siguiente saludo en ${(tiempoEspera/60000).toFixed(1)} min`)
    intervalID = setTimeout(async () => {
      if (!sock) return
      const frase = nudgeMessages[Math.floor(Math.random() * nudgeMessages.length)]
      try { await sock.sendMessage(TARGET_GROUP_ID, { text: frase }) } catch (e) { console.error('Error saludo', e) }
      programar()
    }, tiempoEspera)
  }
  programar()
}

// ========== INICIAR ==========
startBot().catch(e => console.error('Error init bot', e))

// ========== SERVIDOR WEB ==========
const app = express()
app.get('/', (req, res) => res.send('Bot Activo 🤖'))
app.get('/qr', async (req, res) => {
  if (!latestQR) return res.send('<h3>Bot ya conectado o generando QR... refresca en 10s.</h3>')
  try { const qrImage = await QRCode.toDataURL(latestQR); res.send(`<img src="${qrImage}" />`) } catch (err) { res.status(500).send('Error QR') }
})
app.listen(PORT, () => console.log(`🌐 Servidor en puerto ${PORT}`))
