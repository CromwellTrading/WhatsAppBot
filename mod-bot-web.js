const express = require('express');
const cron = require('node-cron');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Validar variables de entorno críticas
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ ERROR: Variables de entorno SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son requeridas');
  process.exit(1);
}

// --- CONFIGURACIÓN SUPABASE ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- CONFIGURACIÓN BOT ---
const GROUP_ID = process.env.GROUP_ID; 
const MAX_WARNINGS = 3;
const AUTO_MESSAGES = [
  "¡Hola grupo! Recuerden las reglas.",
  "Bot Guardián activo. Eviten enviar enlaces.",
  "Mensaje por hora: ¡Mantengamos el orden!",
  "🤖 Protegiendo el grupo 24/7."
];

// Configuración optimizada de Puppeteer
const puppeteerOptions = {
  headless: 'new', // Usar el nuevo headless
  executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--single-process' // Para reducir uso de memoria en Render
  ]
};

const client = new Client({
  authStrategy: new LocalAuth({ 
    clientId: "moderator-bot",
    dataPath: './wwebjs_auth' // Directorio explícito
  }),
  puppeteer: puppeteerOptions,
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
  }
});

let lastQr = null;
let clientReady = false;

// 1. EVENTOS DE CONEXIÓN
client.on('qr', (qr) => {
  lastQr = qr;
  clientReady = false;
  qrcodeTerminal.generate(qr, { small: true });
  console.log('⚠️ NUEVO QR GENERADO.');
});

client.on('ready', () => {
  lastQr = null;
  clientReady = true;
  console.log('🚀 BOT LISTO Y CONECTADO');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Error de autenticación:', msg);
});

client.on('disconnected', (reason) => {
  console.log('🔌 Cliente desconectado:', reason);
  clientReady = false;
});

// 2. LÓGICA DE MODERACIÓN MEJORADA
client.on('message_create', async (msg) => {
  try {
    // Ignorar mensajes del bot
    if (msg.fromMe) return;
    
    const chat = await msg.getChat();
    
    // Solo moderar grupos
    if (!chat.isGroup) return;
    
    // Logs informativos
    if (msg.body) {
      const contact = await msg.getContact();
      console.log(`📩 [${chat.name}] ${contact.pushname || contact.number}: ${msg.body.substring(0, 50)}`);
    }

    // Detectar enlaces (con mejor regex)
    const linkRegex = /(https?:\/\/[^\s]+|www\.[^\s]+\.[^\s]+)/gi;
    if (linkRegex.test(msg.body)) {
      const senderId = msg.author || msg.from;
      
      // Delay aleatorio para parecer humano
      const delay = Math.floor(Math.random() * (45000 - 20000) + 20000);
      
      setTimeout(async () => {
        try {
          // Intentar eliminar el mensaje
          const deleteResult = await msg.delete(true);
          if (!deleteResult) {
            console.log('⚠️ No se pudo eliminar el mensaje');
            return;
          }
          
          console.log(`🗑️ Mensaje eliminado de ${senderId}`);
          
          // Obtener contacto para mención
          const contact = await client.getContactById(senderId);
          const mention = `@${senderId.replace('@c.us', '')}`;
          
          // --- GESTIÓN DE ADVERTENCIAS ---
          let { data: userRow, error } = await supabase
            .from('warnings')
            .select('warn_count')
            .eq('user_id', senderId)
            .single();

          if (error && error.code !== 'PGRST116') { // PGRST116 = no encontrado
            console.error('Error al buscar advertencias:', error);
            return;
          }

          let currentWarns = (userRow ? userRow.warn_count : 0) + 1;
          console.log(`⚠️ Advertencia ${currentWarns}/${MAX_WARNINGS} para ${senderId}`);

          if (!userRow) {
            // Primera advertencia
            const { error: insertError } = await supabase
              .from('warnings')
              .insert([{ 
                user_id: senderId, 
                warn_count: 1,
                created_at: new Date().toISOString()
              }]);
            
            if (insertError) {
              console.error('Error al insertar advertencia:', insertError);
            }
          } else {
            // Actualizar advertencia existente
            const { error: updateError } = await supabase
              .from('warnings')
              .update({ 
                warn_count: currentWarns,
                updated_at: new Date().toISOString()
              })
              .eq('user_id', senderId);
            
            if (updateError) {
              console.error('Error al actualizar advertencia:', updateError);
            }
          }

          // Enviar advertencia o banear
          if (currentWarns < MAX_WARNINGS) {
            await chat.sendMessage(
              `⚠️ ${mention} ¡No se permiten enlaces! Advertencia ${currentWarns}/${MAX_WARNINGS}\n` +
              `La próxima será ban.`,
              { mentions: [contact] }
            );
          } else {
            await chat.sendMessage(
              `🚫 ${mention} Baneado por acumular ${MAX_WARNINGS} advertencias.`,
              { mentions: [contact] }
            );
            
            // Eliminar de la base de datos
            await supabase
              .from('warnings')
              .delete()
              .eq('user_id', senderId);
            
            // Expulsar del grupo con delay
            setTimeout(async () => {
              try {
                await chat.removeParticipants([senderId]);
                console.log(`👢 Usuario ${senderId} expulsado del grupo`);
              } catch (expulsionError) {
                console.error('Error al expulsar usuario:', expulsionError);
              }
            }, 3000);
          }
        } catch (e) { 
          console.error('Error en moderación:', e.message);
        }
      }, delay);
    }
  } catch (e) { 
    console.error('Error general en mensaje:', e.message);
  }
});

// 3. AUTO POST MEJORADO
cron.schedule('0 * * * *', async () => {
  if (!clientReady || !GROUP_ID) {
    console.log('⏸️ Auto-mensaje omitido: Bot no listo o sin GROUP_ID');
    return;
  }
  
  try {
    const chat = await client.getChatById(GROUP_ID);
    const randomMessage = AUTO_MESSAGES[Math.floor(Math.random() * AUTO_MESSAGES.length)];
    await chat.sendMessage(randomMessage);
    console.log(`🤖 Auto-mensaje enviado: "${randomMessage.substring(0, 30)}..."`);
  } catch (error) {
    console.error('Error enviando auto-mensaje:', error.message);
  }
});

// RUTAS WEB MEJORADAS
app.get('/qr', async (req, res) => {
  try {
    if (lastQr) {
      res.setHeader('Content-Type', 'image/png');
      await QRCode.toFileStream(res, lastQr, {
        width: 300,
        margin: 2,
        errorCorrectionLevel: 'H'
      });
    } else if (clientReady) {
      res.send('<html><body><h2>✅ Bot ya está conectado</h2><p>No necesita QR</p></body></html>');
    } else {
      res.send(`
        <html>
          <head>
            <meta http-equiv="refresh" content="10">
            <title>QR Code</title>
          </head>
          <body>
            <h2>⏳ Generando QR...</h2>
            <p>Actualizando automáticamente cada 10 segundos</p>
          </body>
        </html>
      `);
    }
  } catch (error) {
    res.status(500).send('Error generando QR');
  }
});

app.get('/status', (req, res) => {
  res.json({
    status: clientReady ? 'connected' : 'disconnected',
    qr_required: !clientReady && !!lastQr,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

app.get('/', (req, res) => {
  res.send(`
    <html>
      <body>
        <h1>🤖 Bot Guardián Online</h1>
        <p>Estado: ${clientReady ? '✅ Conectado' : '❌ Desconectado'}</p>
        <ul>
          <li><a href="/qr">Ver QR Code</a></li>
          <li><a href="/status">Estado del Bot</a></li>
        </ul>
      </body>
    </html>
  `);
});

// Manejo de errores global
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Iniciar servidor y bot
app.listen(PORT, () => {
  console.log(`🌐 Servidor web en puerto ${PORT}`);
  console.log(`📱 Inicializando bot de WhatsApp...`);
  client.initialize().catch(err => {
    console.error('Error inicializando cliente:', err);
  });
});
