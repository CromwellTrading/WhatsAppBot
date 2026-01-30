const {
  default: makeWASocket,
  DisconnectReason,
  Browsers,
  initAuthCreds,
  BufferJSON,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')

const P = require('pino')
const express = require('express')
const QRCode = require('qrcode')
const { createClient } = require('@supabase/supabase-js')

/* ================= CONFIGURACIÓN ================= */

const PORT = process.env.PORT || 3000
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY 

// Usamos un logger mínimo para ahorrar memoria en Render
const logger = P({ level: 'error' })

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
})

/* ================= ADAPTADOR DE AUTENTICACIÓN (SUPABASE) ================= */

const useSupabaseAuthState = async () => {
  const writeData = async (data, key) => {
    try {
      await supabase
        .from('auth_sessions')
        .upsert({ key, value: JSON.stringify(data, BufferJSON.replacer) })
    } catch (e) { 
      console.error('Error al guardar en Supabase:', e.message) 
    }
  }

  const readData = async (key) => {
    try {
      const { data } = await supabase
        .from('auth_sessions')
        .select('value')
        .eq('key', key)
        .maybeSingle()
      return data?.value ? JSON.parse(data.value, BufferJSON.reviver) : null
    } catch (e) { return null }
  }

  const removeData = async (key) => {
    try {
      await supabase.from('auth_sessions').delete().eq('key', key)
    } catch (e) { }
  }

  // Cargamos las credenciales base
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
    saveCreds: async () => {
      await writeData(creds, 'creds')
    }
  }
}

/* ================= LÓGICA DEL BOT ================= */

let latestQR = null
let sock = null

async function startBot() {
  console.log('--- Iniciando instancia del Bot ---')
  
  const { state, saveCreds } = await useSupabaseAuthState()
  
  // Obtenemos la versión más reciente de WhatsApp Web para evitar bloqueos
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger,
    // Browser configurado como Chrome en Ubuntu para mayor compatibilidad en Render
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    syncFullHistory: false, // ¡IMPORTANTE! Ahorra mucha memoria RAM
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
  })

  // Guardar credenciales cada vez que se actualizan
  sock.ev.on('creds.update', saveCreds)

  // Manejo de conexión
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      latestQR = qr
      console.log('⚠️ NUEVO QR GENERADO: Accede a la URL de Render /qr para escanear.')
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      
      console.log(`❌ Conexión cerrada. Razón: ${statusCode}. Reconectando: ${shouldReconnect}`)
      
      if (shouldReconnect) {
        // Delay de 5 segundos antes de reintentar para no saturar el servidor
        setTimeout(startBot, 5000)
      } else {
        console.log('🚫 Sesión finalizada. Debes borrar la tabla en Supabase y volver a escanear.')
      }
    }

    if (connection === 'open') {
      console.log('✅ ¡CONEXIÓN EXITOSA! WhatsApp está activo.')
      latestQR = null
    }
  })

  // Escuchar mensajes para obtener IDs de grupos y procesar enlaces
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return 

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue
      
      const remoteJid = msg.key.remoteJid
      const messageText = msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text || 
                          ''

      // LOGS EN CONSOLA: Aquí verás los IDs de los grupos para tu prueba
      console.log('------------------------------------')
      console.log(`📩 MENSAJE RECIBIDO`)
      console.log(`🆔 ID JID: ${remoteJid}`)
      console.log(`👤 DE: ${msg.pushName || 'Desconocido'}`)
      console.log(`📝 TEXTO: ${messageText}`)
      console.log('------------------------------------')
      
      // Filtro para solo procesar si hay un enlace (ahorro de recursos)
      if (messageText.includes('http')) {
        console.log(`🔗 Enlace detectado en ${remoteJid}. Procesando...`)
        // Aquí puedes añadir tu lógica de posteo automático
      }
    }
  })
}

// Iniciar el proceso
startBot()

/* ================= SERVIDOR WEB (EXPRESS) ================= */

const app = express()

app.get('/', (req, res) => {
  res.send('Servidor del Bot funcionando correctamente ✅')
})

app.get('/qr', async (req, res) => {
  if (sock?.authState?.creds?.me?.id) {
    return res.send('<h3>El bot ya está vinculado y funcionando.</h3>')
  }
  
  if (!latestQR) {
    return res.send('<h3>Generando código QR... por favor refresca en 10 segundos.</h3>')
  }
  
  try {
    const qrImage = await QRCode.toDataURL(latestQR)
    res.send(`
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; font-family:sans-serif; background:#f0f2f5;">
        <div style="background:white; padding:20px; border-radius:15px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align:center;">
          <h2 style="color:#128c7e;">Escanea con WhatsApp</h2>
          <img src="${qrImage}" style="width:300px; height:300px; border:1px solid #ddd;"/>
          <p style="margin-top:15px; color:#555;">El código se actualizará automáticamente si expira.</p>
        </div>
      </div>
    `)
  } catch (err) {
    res.status(500).send('Error al generar la imagen del QR')
  }
})

app.listen(PORT, () => {
  console.log(`🌐 Servidor HTTP activo en el puerto ${PORT}`)
})
