const {
  default: makeWASocket,
  DisconnectReason,
  Browsers,
  initAuthCreds,
  BufferJSON
} = require('@whiskeysockets/baileys')

const P = require('pino')
const express = require('express')
const QRCode = require('qrcode')
const { createClient } = require('@supabase/supabase-js')

/* ================= CONFIGURACIÓN ================= */

const PORT = process.env.PORT || 3000
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY // Usa la Service Role Key si es posible para evitar RLS

// Logger optimizado para no saturar memoria (solo errores y advertencias importantes)
const logger = P({ level: 'warn' })

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false } // Ahorra memoria no persistiendo sesión de supabase
})

/* ================= AUTH ADAPTER (MEMORIA + DB) ================= */
// Esto reemplaza al sistema de archivos. Lee/Escribe directo en Supabase.

const useSupabaseAuthState = async () => {
  // 1. Cargar credenciales principales (creds.json)
  const writeData = async (data, key) => {
    const { error } = await supabase
      .from('auth_sessions')
      .upsert({ key, value: JSON.stringify(data, BufferJSON.replacer) })
    
    if (error) logger.error({ error }, 'Error guardando auth en Supabase')
  }

  const readData = async (key) => {
    const { data, error } = await supabase
      .from('auth_sessions')
      .select('value')
      .eq('key', key)
      .maybeSingle()
    
    if (error) logger.error({ error }, 'Error leyendo auth de Supabase')
    if (data && data.value) {
      return JSON.parse(data.value, BufferJSON.reviver)
    }
    return null
  }

  const removeData = async (key) => {
    await supabase.from('auth_sessions').delete().eq('key', key)
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
              if (value) {
                tasks.push(writeData(value, key))
              } else {
                tasks.push(removeData(key))
              }
            }
          }
          await Promise.all(tasks)
        }
      }
    },
    saveCreds: async () => {
      await writeData(creds, 'creds')
    }
  }
}

/* ================= BAILEYS LOGIC ================= */

let latestQR = null
let sock = null

async function startBot() {
  logger.info('Iniciando Bot...')
  
  const { state, saveCreds } = await useSupabaseAuthState()

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // Desactivado para logs limpios en Render
    logger,
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: false, // ¡CRUCIAL! Ahorra RAM al no descargar chats antiguos
    generateHighQualityLinkPreview: false, // Ahorra RAM
  })

  // Evento de Credenciales
  sock.ev.on('creds.update', saveCreds)

  // Evento de Conexión
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      latestQR = qr
      logger.warn('Escanea el QR (disponible en /qr)')
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      logger.warn({ reason: lastDisconnect?.error }, 'Conexión cerrada. Reconectando: ' + shouldReconnect)
      
      if (shouldReconnect) {
        startBot()
      } else {
        logger.error('Sesión cerrada (Log out). Borra la tabla en Supabase para reiniciar.')
      }
    }

    if (connection === 'open') {
      logger.info('✅ WhatsApp Conectado y listo')
      latestQR = null
    }
  })

  // ============================================================
  // LÓGICA DE MENSAJES Y OBTENCIÓN DE ID DE GRUPO
  // ============================================================
  
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return // Solo notificaciones nuevas

    for (const msg of messages) {
      if (!msg.message) continue
      
      // Evitar procesar mensajes propios
      if (msg.key.fromMe) return 

      const remoteJid = msg.key.remoteJid
      const messageContent = msg.message?.conversation || 
                             msg.message?.extendedTextMessage?.text || 
                             'Tipo de mensaje desconocido/media'

      // --- LOG PARA OBTENER EL ID DEL GRUPO ---
      // Esto imprimirá en los logs de Render cada mensaje entrante
      console.log('------------------------------------------------')
      console.log('📩 NUEVO MENSAJE RECIBIDO')
      console.log(`📌 GRUPO/CHAT ID: ${remoteJid}`)
      console.log(`👤 REMITENTE: ${msg.key.participant || msg.key.remoteJid}`)
      console.log(`📝 CONTENIDO: ${messageContent}`)
      console.log('------------------------------------------------')

      // --- FILTRO DE MEMORIA ---
      // Solo continuamos si detectamos que es un enlace (http) para ahorrar CPU
      if (!messageContent.includes('http')) return

      // --- TU LÓGICA AQUÍ ---
      // Ejemplo: responder si hay enlace
      // await sock.sendMessage(remoteJid, { text: 'Enlace detectado' })
    }
  })
}

startBot()

/* ================= SERVER (Express) ================= */

const app = express()

app.get('/', (req, res) => {
  res.send('WhatsApp Bot Activo 🤖')
})

app.get('/qr', async (req, res) => {
  if (sock?.authState?.creds?.me?.id) return res.send('Ya estás conectado ✅')
  if (!latestQR) return res.send('Esperando QR o recarga la página en 5 segundos...')
  
  try {
    const img = await QRCode.toDataURL(latestQR)
    res.send(`<div style="display:flex;justify-content:center;align-items:center;height:100vh;"><img src="${img}" /></div>`)
  } catch (err) {
    res.send('Error generando QR')
  }
})

app.listen(PORT, () => {
  console.log(`Servidor HTTP corriendo en puerto ${PORT}`)
})
