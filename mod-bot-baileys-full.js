const {
  default: makeWASocket,
  DisconnectReason,
  Browsers,
  initAuthCreds,
  BufferJSON,
  fetchLatestBaileysVersion,
  useMultiFileAuthState // No lo usaremos, pero es parte de la lib
} = require('@whiskeysockets/baileys')

const P = require('pino')
const express = require('express')
const QRCode = require('qrcode')
const { createClient } = require('@supabase/supabase-js')

/* ================= CONFIGURACIÓN ================= */

const PORT = process.env.PORT || 3000
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY 

// Pega aquí el ID que conseguiste o úsalo desde ENV
const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID || '120363408042502905@g.us'

// Logger nivel 'fatal' para que no llene la consola de basura (SessionErrors, etc)
const logger = P({ level: 'fatal' })

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
})

/* ================= ADAPTADOR DE AUTENTICACIÓN (SUPABASE) ================= */
// ... (Esta parte es idéntica a la tuya, la resumo para ahorrar espacio) ...
const useSupabaseAuthState = async () => {
  const writeData = async (data, key) => {
    try {
      await supabase
        .from('auth_sessions')
        .upsert({ key, value: JSON.stringify(data, BufferJSON.replacer) })
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

/* ================= LÓGICA DEL BOT ================= */

let latestQR = null
let sock = null
let intervalID = null // Para controlar el saludo automático

// Frases aleatorias para parecer humano
const saludos = [
  "Hola a todos, ¿cómo va el día?",
  "Buenas, ¿qué tal todo por aquí?",
  "Saludos grupo, espero que estén bien.",
  "Hola, pasaba a saludar.",
  "¿Todo en orden por aquí? Saludos.",
  "Buenas tardes/noches a todos."
]

async function startBot() {
  console.log('--- Iniciando instancia del Bot ---')
  
  const { state, saveCreds } = await useSupabaseAuthState()
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60000,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) latestQR = qr
    
    if (connection === 'close') {
      // Limpiamos el intervalo si se desconecta para no duplicar
      if (intervalID) clearInterval(intervalID)
      
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log(`❌ Conexión cerrada. Reconectando: ${shouldReconnect}`)
      
      if (shouldReconnect) setTimeout(startBot, 5000)
    }

    if (connection === 'open') {
      console.log('✅ ¡CONEXIÓN EXITOSA! WhatsApp está activo.')
      latestQR = null
      
      // Iniciamos el ciclo de saludos automáticos
      iniciarSaludosAutomaticos()
    }
  })

  // === PROCESAMIENTO DE MENSAJES ===
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return 

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue
      
      const remoteJid = msg.key.remoteJid

      // 1. FILTRO DE MEMORIA: Si no es el grupo objetivo, ignorar
      if (remoteJid !== TARGET_GROUP_ID) return

      const messageText = msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text || ''

      // 2. DETECTOR DE ENLACES
      // Regex busca http://, https:// o www.
      const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi;
      
      if (urlRegex.test(messageText)) {
        console.log(`🚨 Enlace detectado de ${msg.pushName}: ${messageText}`)
        
        try {
          // Primero borramos el mensaje (clave para borrar: remoteJid, fromMe, id)
          await sock.sendMessage(remoteJid, { delete: msg.key })
          console.log('🗑️ Mensaje eliminado correctamente.')
          
          // Opcional: Advertencia
          // await sock.sendMessage(remoteJid, { text: '🚫 Prohibidos los enlaces.' })
        } catch (error) {
          console.log('⚠️ No pude borrar el mensaje. ¿Soy Admin del grupo?')
        }
      }
    }
  })
}

// === FUNCIÓN SALUDO AUTOMÁTICO ===
function iniciarSaludosAutomaticos() {
  if (intervalID) clearInterval(intervalID)

  console.log('⏰ Sistema de saludos automáticos activado.')

  // Función interna que se llama a sí misma para variar el tiempo
  const programarSiguienteSaludo = () => {
    // Tiempo aleatorio entre 30 y 45 minutos (en milisegundos)
    // 30 min = 1,800,000 ms
    // 45 min = 2,700,000 ms
    const minTime = 1800000 
    const maxTime = 2700000
    const tiempoEspera = Math.floor(Math.random() * (maxTime - minTime + 1) + minTime)
    
    console.log(`⏳ Próximo saludo en ${(tiempoEspera / 60000).toFixed(1)} minutos`)

    intervalID = setTimeout(async () => {
      if (!sock) return

      const frase = saludos[Math.floor(Math.random() * saludos.length)]
      
      try {
        await sock.sendMessage(TARGET_GROUP_ID, { text: frase })
        console.log(`🤖 Saludo enviado: "${frase}"`)
      } catch (e) {
        console.error('Error enviando saludo automático', e)
      }

      // Reprogramar el siguiente
      programarSiguienteSaludo()

    }, tiempoEspera)
  }

  programarSiguienteSaludo()
}

startBot()

/* ================= SERVIDOR WEB ================= */
const app = express()
app.get('/', (req, res) => res.send('Bot Activo 🤖'))
app.get('/qr', async (req, res) => {
  if (!latestQR) return res.send('<h3>Bot ya conectado o generando QR... refresca en 10s.</h3>')
  try {
    const qrImage = await QRCode.toDataURL(latestQR)
    res.send(`<img src="${qrImage}" />`)
  } catch (err) { res.status(500).send('Error QR') }
})
app.listen(PORT, () => console.log(`🌐 Servidor en puerto ${PORT}`))
