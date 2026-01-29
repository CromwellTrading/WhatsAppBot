// mod-bot-baileys-full.js - VERSIÓN CON LOGS COMPLETOS
const express = require('express');
const cron = require('node-cron');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

const {
  default: makeWASocket,
  DisconnectReason,
  useSingleFileAuthState,
  fetchLatestBaileysVersion,
  delay,
  proto
} = require('@adiwajshing/baileys');

const app = express();

// -------- CONFIGURACIÓN --------
const PORT = process.env.PORT || 3000;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ FALTAN VARIABLES: SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// -------- ALMACENAMIENTO EN MEMORIA PARA LOGS --------
let messageLogs = [];
let groupLogs = [];
let contactLogs = [];
const MAX_LOGS = 200;

// -------- LOGGER COMPLETO --------
const logger = {
  debug: (msg, obj) => {
    const logMsg = obj ? `[DEBUG] ${msg} ${JSON.stringify(obj)}` : `[DEBUG] ${msg}`;
    console.log(logMsg);
  },
  info: (msg, obj) => {
    const logMsg = obj ? `[INFO] ${msg} ${JSON.stringify(obj)}` : `[INFO] ${msg}`;
    console.log(logMsg);
  },
  warn: (msg, obj) => {
    const logMsg = obj ? `[WARN] ${msg} ${JSON.stringify(obj)}` : `[WARN] ${msg}`;
    console.warn(logMsg);
  },
  error: (msg, obj) => {
    const logMsg = obj ? `[ERROR] ${msg} ${JSON.stringify(obj)}` : `[ERROR] ${msg}`;
    console.error(logMsg);
  },
  trace: (msg) => console.log(`[TRACE] ${msg}`),
  child: () => logger
};

// -------- FUNCIONES UTILITARIAS --------
function addToLog(type, data) {
  const timestamp = new Date().toISOString();
  const logEntry = { type, timestamp, data };
  
  messageLogs.unshift(logEntry);
  if (messageLogs.length > MAX_LOGS) messageLogs.pop();
  
  // Log en consola para Render
  console.log(`[${timestamp}] [${type}]`, JSON.stringify(data, null, 2));
}

function extractMessageText(message) {
  if (!message) return '';
  
  try {
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.documentMessage?.caption) return message.documentMessage.caption;
    if (message.audioMessage) return '[AUDIO]';
    if (message.stickerMessage) return '[STICKER]';
    if (message.contactMessage) return '[CONTACTO]';
    if (message.locationMessage) return '[UBICACIÓN]';
    if (message.buttonsResponseMessage) return '[BOTÓN] ' + message.buttonsResponseMessage.selectedButtonId;
    if (message.listResponseMessage) return '[LISTA] ' + message.listResponseMessage.title;
    
    return '[SIN TEXTO]';
  } catch (e) {
    return '[ERROR EXTRACTING]';
  }
}

// -------- FUNCIONES SUPABASE --------
async function saveAuthToSupabase(authJSON) {
  try {
    const { error } = await supabase
      .from('wa_session_json')
      .upsert({
        key: 'baileys_auth',
        auth_json: authJSON,
        updated_at: new Date().toISOString()
      }, { onConflict: 'key' });
    
    return !error;
  } catch (e) {
    logger.warn('Error guardando auth:', e.message);
    return false;
  }
}

async function loadAuthFromSupabase() {
  try {
    const { data, error } = await supabase
      .from('wa_session_json')
      .select('auth_json')
      .eq('key', 'baileys_auth')
      .maybeSingle();
    
    if (error || !data?.auth_json) return null;
    return JSON.parse(data.auth_json);
  } catch (e) {
    return null;
  }
}

// -------- BOT PRINCIPAL --------
async function startBot() {
  logger.info('🚀 Iniciando bot con logs completos...');
  
  const savedAuth = await loadAuthFromSupabase();
  let authState;
  
  if (savedAuth) {
    authState = { state: savedAuth, saveState: async () => {} };
    logger.info('✅ Auth cargado desde Supabase');
  } else {
    authState = { state: {}, saveState: async () => {} };
    logger.info('🆕 Auth nuevo creado');
  }
  
  const { version } = await fetchLatestBaileysVersion();
  
  // Crear socket con configuración completa
  const sock = makeWASocket({
    version,
    auth: authState.state,
    printQRInTerminal: true,
    logger,
    syncFullHistory: false,
    fireInitQueries: true, // Habilitado para obtener lista de chats
    markOnlineOnConnect: false,
    emitOwnEvents: true // Emitir eventos propios
  });
  
  let isConnected = false;
  let qrCode = null;
  
  // -------- MANEJADOR DE CONEXIÓN --------
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    addToLog('CONNECTION', {
      connection,
      lastDisconnect: lastDisconnect?.error?.message,
      qr: qr ? '[QR GENERATED]' : null
    });
    
    if (qr) {
      qrCode = qr;
      logger.info('📱 QR generado - Visita /qr para escanear');
    }
    
    if (connection === 'open') {
      isConnected = true;
      logger.info('✅ CONECTADO A WHATSAPP');
      
      // Guardar auth
      if (sock.authState) {
        await saveAuthToSupabase(sock.authState);
      }
      
      // Obtener y loguear información del usuario
      if (sock.user) {
        addToLog('USER_INFO', {
          id: sock.user.id,
          name: sock.user.name,
          phone: sock.user.phone
        });
        
        logger.info(`👤 Usuario conectado: ${sock.user.name} (${sock.user.id})`);
      }
    }
    
    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      logger.warn(`❌ Desconectado (${statusCode}) - Reconectando: ${shouldReconnect}`);
      
      if (shouldReconnect) {
        await delay(5000);
        startBot();
      }
    }
  });
  
  // -------- MANEJADOR DE CREDENCIALES --------
  sock.ev.on('creds.update', async (creds) => {
    authState.state = creds;
    await saveAuthToSupabase(creds);
    addToLog('CREDS_UPDATE', { updated: true });
  });
  
  // -------- MANEJADOR DE MENSAJES --------
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      for (const msg of messages) {
        const jid = msg.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');
        const fromMe = msg.key.fromMe;
        const participant = msg.key.participant || jid;
        const messageType = Object.keys(msg.message || {})[0] || 'unknown';
        const text = extractMessageText(msg.message);
        
        // Log detallado del mensaje
        const messageLog = {
          timestamp: new Date().toISOString(),
          jid,
          isGroup,
          fromMe,
          participant: participant.replace(/:[0-9]+$/, ''), // Limpiar puerto
          messageType,
          text: text.substring(0, 500),
          fullMessage: msg // Guardar mensaje completo
        };
        
        addToLog('MESSAGE', messageLog);
        
        // Log específico para grupos
        if (isGroup) {
          // Extraer información del grupo
          const groupId = jid;
          const groupName = msg.pushName || 'Sin nombre';
          
          addToLog('GROUP_MESSAGE', {
            groupId,
            groupName,
            participant,
            fromMe,
            text: text.substring(0, 200)
          });
          
          // Almacenar grupos únicos
          if (!groupLogs.some(g => g.id === groupId)) {
            groupLogs.unshift({
              id: groupId,
              name: groupName,
              lastMessage: new Date().toISOString(),
              participantCount: 0
            });
            
            if (groupLogs.length > 50) groupLogs.pop();
            
            logger.info(`👥 NUEVO GRUPO DETECTADO: ${groupName}`);
            logger.info(`   ID: ${groupId}`);
            logger.info(`   Para usar este grupo, establece: GROUP_ID=${groupId}`);
          }
        }
        
        // Log para mensajes propios
        if (fromMe) {
          addToLog('OWN_MESSAGE', {
            to: jid,
            isGroup,
            text: text.substring(0, 200)
          });
        }
        
        // Procesar comandos de administración (solo si es grupo y tenemos ID)
        const GROUP_ID = process.env.GROUP_ID;
        if (GROUP_ID && isGroup && jid === GROUP_ID) {
          await processGroupMessage(sock, msg, jid, participant, text);
        }
      }
    } catch (error) {
      addToLog('MESSAGE_ERROR', { error: error.message });
    }
  });
  
  // -------- MANEJADOR DE CHATS --------
  sock.ev.on('chats.set', ({ chats }) => {
    addToLog('CHATS_SET', { count: chats?.length || 0 });
    
    if (chats) {
      // Log primeros 10 chats
      chats.slice(0, 10).forEach(chat => {
        logger.info(`💬 CHAT: ${chat.name || 'Sin nombre'} | ID: ${chat.id} | ${chat.unreadCount || 0} no leídos`);
      });
    }
  });
  
  sock.ev.on('chats.upsert', (chats) => {
    chats.forEach(chat => {
      addToLog('CHAT_UPSERT', {
        id: chat.id,
        name: chat.name,
        unreadCount: chat.unreadCount,
        isGroup: chat.id.endsWith('@g.us')
      });
    });
  });
  
  sock.ev.on('chats.update', (updates) => {
    updates.forEach(update => {
      if (update.unreadCount) {
        addToLog('CHAT_UPDATE', {
          id: update.id,
          unreadCount: update.unreadCount
        });
      }
    });
  });
  
  // -------- MANEJADOR DE CONTACTOS --------
  sock.ev.on('contacts.set', ({ contacts }) => {
    addToLog('CONTACTS_SET', { count: contacts?.length || 0 });
    
    if (contacts) {
      // Almacenar algunos contactos
      contacts.slice(0, 20).forEach(contact => {
        contactLogs.unshift({
          id: contact.id,
          name: contact.name,
          notify: contact.notify
        });
      });
      if (contactLogs.length > 100) contactLogs.splice(100);
    }
  });
  
  sock.ev.on('contacts.upsert', (contacts) => {
    contacts.forEach(contact => {
      addToLog('CONTACT_UPSERT', {
        id: contact.id,
        name: contact.name
      });
    });
  });
  
  sock.ev.on('contacts.update', (updates) => {
    updates.forEach(update => {
      addToLog('CONTACT_UPDATE', update);
    });
  });
  
  // -------- MANEJADOR DE GRUPOS --------
  sock.ev.on('groups.set', ({ groups }) => {
    addToLog('GROUPS_SET', { count: groups?.length || 0 });
    
    if (groups) {
      groups.forEach(group => {
        logger.info(`👥 GRUPO: ${group.subject || 'Sin nombre'} | ID: ${group.id} | Participantes: ${group.participants?.length || 0}`);
        
        // Agregar a lista de grupos
        if (!groupLogs.some(g => g.id === group.id)) {
          groupLogs.unshift({
            id: group.id,
            name: group.subject,
            participants: group.participants?.length || 0,
            isAdmin: group.isAdmin
          });
        }
      });
    }
  });
  
  sock.ev.on('groups.upsert', (groups) => {
    groups.forEach(group => {
      addToLog('GROUP_UPSERT', {
        id: group.id,
        name: group.subject,
        participants: group.participants?.length
      });
    });
  });
  
  sock.ev.on('groups.update', (updates) => {
    updates.forEach(update => {
      addToLog('GROUP_UPDATE', update);
    });
  });
  
  // -------- MANEJADOR DE PRESENCIA --------
  sock.ev.on('presence.update', ({ id, presences }) => {
    addToLog('PRESENCE', { id, presences });
  });
  
  // -------- FUNCIÓN DE PROCESAMIENTO DE GRUPOS --------
  async function processGroupMessage(sock, msg, jid, participant, text) {
    try {
      const hasLink = /https?:\/\/|www\.|bit\.ly|t\.me|wa\.me/i.test(text);
      
      if (hasLink) {
        // Eliminar mensaje con enlace
        await sock.sendMessage(jid, { delete: msg.key });
        logger.info(`🗑️ Enlace eliminado de ${participant}`);
        
        // Enviar advertencia
        await sock.sendMessage(jid, { 
          text: `⚠️ ${participant.split('@')[0]}, los enlaces no están permitidos sin autorización.` 
        });
      }
    } catch (error) {
      addToLog('PROCESS_ERROR', { error: error.message });
    }
  }
  
  // -------- ENDPOINTS WEB --------
  app.get('/', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>WhatsApp Bot - Logs Completos</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          .card { background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 10px 0; }
          .connected { color: green; font-weight: bold; }
          .disconnected { color: red; font-weight: bold; }
          pre { background: #333; color: #fff; padding: 10px; border-radius: 5px; overflow: auto; }
        </style>
      </head>
      <body>
        <h1>🤖 WhatsApp Bot - Monitor Completo</h1>
        <div class="card">
          <p>Estado: <span class="${isConnected ? 'connected' : 'disconnected'}">
            ${isConnected ? '✅ CONECTADO' : '❌ DESCONECTADO'}
          </span></p>
          <p>Mensajes registrados: ${messageLogs.length}</p>
          <p>Grupos detectados: ${groupLogs.length}</p>
        </div>
        
        <h2>📊 Enlaces útiles:</h2>
        <ul>
          <li><a href="/qr" target="_blank">📱 Escanear QR</a></li>
          <li><a href="/logs" target="_blank">📝 Ver logs completos</a></li>
          <li><a href="/groups" target="_blank">👥 Ver grupos detectados</a></li>
          <li><a href="/messages" target="_blank">💬 Ver últimos mensajes</a></li>
          <li><a href="/contacts" target="_blank">👤 Ver contactos</a></li>
          <li><a href="/status" target="_blank">⚙️ Estado del sistema</a></li>
          <li><a href="/help" target="_blank">❓ Ayuda y comandos</a></li>
        </ul>
        
        <h2>🔧 Configuración de grupo:</h2>
        <div class="card">
          <p>Para configurar un grupo, copia el ID del grupo de los logs y establece la variable de entorno:</p>
          <pre>GROUP_ID=XXXXXXXXXX@g.us</pre>
          <p>Luego reinicia la aplicación en Render.</p>
        </div>
      </body>
      </html>
    `);
  });
  
  app.get('/qr', async (req, res) => {
    if (isConnected) {
      return res.send(`
        <html>
        <body style="text-align: center; padding: 50px;">
          <h2>✅ Ya estás conectado</h2>
          <p>Usuario: ${sock.user?.name || 'No disponible'}</p>
          <p>ID: ${sock.user?.id || 'No disponible'}</p>
          <p><a href="/">Volver al inicio</a></p>
        </body>
        </html>
      `);
    }
    
    if (!qrCode) {
      return res.send(`
        <html>
        <body style="text-align: center; padding: 50px;">
          <h2>⏳ Generando QR...</h2>
          <p>Esperando código QR. Refresca en 5 segundos.</p>
          <script>setTimeout(() => location.reload(), 5000);</script>
        </body>
        </html>
      `);
    }
    
    try {
      const qrImage = await QRCode.toDataURL(qrCode);
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Escanear QR</title>
          <style>
            body { text-align: center; font-family: Arial; padding: 20px; }
            .instructions { margin: 20px 0; text-align: left; display: inline-block; }
          </style>
        </head>
        <body>
          <h2>📱 Escanea este QR con WhatsApp</h2>
          <div class="instructions">
            <p>1. Abre WhatsApp en tu teléfono</p>
            <p>2. Toca ⋮ → Dispositivos vinculados → Vincular un dispositivo</p>
            <p>3. Escanea este código QR</p>
            <p>4. Revisa los logs para ver los grupos disponibles</p>
          </div>
          <img src="${qrImage}" width="300" height="300" />
          <p><small>Refresca automáticamente cada 10 segundos</small></p>
          <script>setTimeout(() => location.reload(), 10000);</script>
        </body>
        </html>
      `);
    } catch (error) {
      res.send('Error generando QR: ' + error.message);
    }
  });
  
  app.get('/logs', (req, res) => {
    res.json({
      totalLogs: messageLogs.length,
      logs: messageLogs.slice(0, 100)
    });
  });
  
  app.get('/groups', (req, res) => {
    res.json({
      totalGroups: groupLogs.length,
      groups: groupLogs,
      usageHint: 'Para usar un grupo, copia el ID y establece la variable de entorno GROUP_ID en Render'
    });
  });
  
  app.get('/messages', (req, res) => {
    const messages = messageLogs
      .filter(log => log.type === 'MESSAGE')
      .map(log => log.data)
      .slice(0, 50);
    
    res.json({
      totalMessages: messages.length,
      messages
    });
  });
  
  app.get('/contacts', (req, res) => {
    res.json({
      totalContacts: contactLogs.length,
      contacts: contactLogs.slice(0, 50)
    });
  });
  
  app.get('/status', (req, res) => {
    res.json({
      connected: isConnected,
      user: sock.user || null,
      timestamp: new Date().toISOString(),
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      logs: {
        messages: messageLogs.length,
        groups: groupLogs.length,
        contacts: contactLogs.length
      }
    });
  });
  
  app.get('/help', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Ayuda - WhatsApp Bot</title>
        <style>
          body { font-family: Arial; margin: 20px; }
          .command { background: #f0f0f0; padding: 10px; margin: 5px 0; border-radius: 5px; }
        </style>
      </head>
      <body>
        <h1>❓ Ayuda y Comandos</h1>
        
        <h2>📱 Cómo encontrar el ID del grupo:</h2>
        <ol>
          <li>Conecta el bot escaneando el QR en <a href="/qr">/qr</a></li>
          <li>Agrega el bot a tu grupo de WhatsApp</li>
          <li>Envía un mensaje en el grupo</li>
          <li>Revisa los logs en Render (Dashboard → Logs)</li>
          <li>Busca "GRUPO DETECTADO" o "GROUP_MESSAGE"</li>
          <li>Copia el ID que aparece (ej: 1234567890@g.us)</li>
          <li>Configura la variable de entorno GROUP_ID en Render</li>
          <li>Reinicia la aplicación</li>
        </ol>
        
        <h2>🌐 Endpoints disponibles:</h2>
        <div class="command">/ - Página principal con información</div>
        <div class="command">/qr - Escanear código QR</div>
        <div class="command">/logs - Ver logs en JSON</div>
        <div class="command">/groups - Ver grupos detectados</div>
        <div class="command">/messages - Ver últimos mensajes</div>
        <div class="command">/status - Ver estado del sistema</div>
        <div class="command">/contacts - Ver contactos</div>
        
        <h2>🔧 Comandos del bot (en WhatsApp):</h2>
        <div class="command">El bot automáticamente eliminará enlaces en el grupo configurado</div>
        <div class="command">No responde a comandos por ahora (solo monitorea)</div>
        
        <p><a href="/">← Volver al inicio</a></p>
      </body>
      </html>
    `);
  });
  
  // -------- CRON PARA LIMPIEZA --------
  cron.schedule('0 */6 * * *', () => {
    // Limpiar logs antiguos
    const oneHourAgo = new Date(Date.now() - 3600000);
    messageLogs = messageLogs.filter(log => new Date(log.timestamp) > oneHourAgo);
    logger.info('🧹 Logs antiguos limpiados');
  });
  
  // Iniciar servidor
  app.listen(PORT, () => {
    logger.info(`🌐 Servidor iniciado en puerto ${PORT}`);
    logger.info('📝 Todos los logs aparecerán en la consola de Render');
    logger.info('👥 Agrega este número a un grupo y envía un mensaje para ver el ID');
  });
}

// -------- MANEJO DE ERRORES GLOBALES --------
process.on('uncaughtException', (error) => {
  console.error('⚠️ ERROR NO CAPTURADO:', error.message);
  console.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.warn('⚠️ PROMESA RECHAZADA:', reason);
});

// Iniciar aplicación
startBot().catch(error => {
  console.error('💥 ERROR INICIAL:', error);
  process.exit(1);
});
