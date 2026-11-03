# Shiro Synthesis Two — Bolita Cubana

Proyecto de bot de WhatsApp construido con Node.js 20, Baileys, OpenRouter y Supabase.

## Contenido

- `sst-bot.js`: aplicación completa del bot.
- `prompt-shiro.md`: personalidad y reglas conversacionales que carga el código.
- `supabase.sql`: tablas, índices, seguridad RLS y función atómica de advertencias.
- `Dockerfile` y `docker-compose.yml`: despliegue en Docker con volumen persistente para la sesión de WhatsApp.
- `.env.example`: variables necesarias.

## Antes de iniciar

1. Crea un proyecto en Supabase.
2. Abre **SQL Editor** en Supabase y ejecuta todo el contenido de `supabase.sql`.
3. Copia `.env.example` como `.env`.
4. Completa `OPENROUTER_API_KEY`, `TARGET_GROUP_ID`, `ADMIN_WHATSAPP_ID`, `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`.
5. Cambia `QR_ACCESS_TOKEN` por un token largo y privado.
6. Comprueba que Shiro esté agregada al grupo como administradora, con permiso para eliminar mensajes y participantes.

No publiques el archivo `.env` ni la `SUPABASE_SERVICE_ROLE_KEY`.

## Ejecutar con Docker (recomendado)

Desde la carpeta del proyecto:

```bash
cp .env.example .env
# Edita .env y completa tus valores
docker compose up -d --build
```

Consulta el estado:

```bash
curl http://localhost:3000/health
```

Abre el QR en el navegador (sustituye el token por el valor de `QR_ACCESS_TOKEN`):

```text
http://localhost:3000/qr?token=TU_TOKEN
```

Escanea el QR desde WhatsApp → Dispositivos vinculados. El volumen Docker `shiro_auth` conserva los datos de autenticación al reiniciar el contenedor.

Para ver los registros:

```bash
docker compose logs -f shiro
```

Para actualizar el código:

```bash
docker compose down
docker compose up -d --build
```

No elimines el volumen `shiro_auth` al actualizar. Si lo eliminas, perderás la sesión y tendrás que vincular WhatsApp otra vez.

## Ejecutar sin Docker

Requiere Node.js 20:

```bash
cp .env.example .env
npm install
npm start
```

En ejecución directa, `AUTH_DIR` debe apuntar a una carpeta persistente. La sesión de WhatsApp se guarda en esa carpeta.

## Variables importantes

| Variable | Función |
|---|---|
| `OPENROUTER_API_KEY` | Clave de OpenRouter. |
| `OPENROUTER_MODEL` | Modelos en orden de preferencia, separados por comas. |
| `TARGET_GROUP_ID` | ID del grupo principal (`...@g.us`). |
| `ALLOWED_GROUP_IDS` | Grupos autorizados adicionales, separados por comas. Si queda vacío, se usa `TARGET_GROUP_ID`. |
| `ADMIN_WHATSAPP_ID` | Número o JID real del administrador. Usa prefijo internacional. |
| `SUPABASE_URL` | URL del proyecto Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave de servicio, solo en el servidor. |
| `TIME_ZONE` | Zona horaria para fechas y nudges. Por defecto `America/Havana`. |
| `AUTH_DIR` | Carpeta persistente de la sesión. En Docker, `/data/auth`. |
| `QR_ACCESS_TOKEN` | Protege la página del QR. |
| `HISTORY_LIMIT` | Cantidad de mensajes recientes que se envían como contexto. |
| `DUPLICATE_WINDOW_MINUTES` | Ventana para reconocer mensajes exactamente iguales del mismo usuario. |

## Cómo funciona la prevención de repeticiones

1. Cada mensaje entrante se registra usando el ID que entrega WhatsApp. Si Baileys vuelve a notificar ese mismo ID, se ignora.
2. Cada respuesta de Shiro se vincula al ID del mensaje original. Si ya existe una respuesta para ese ID, el bot no envía otra.
3. El duplicado de contenido se considera únicamente cuando coincide el texto normalizado, el mismo usuario y la ventana de tiempo configurada.
4. Shiro solo dice que ya respondió cuando encuentra una respuesta registrada para el mensaje idéntico anterior.
5. El historial incluye mensajes de usuarios y respuestas de Shiro, para que el modelo pueda continuar conversaciones y no responder preguntas antiguas.

No se marca como repetido un mensaje solo por tratar el mismo tema.

## Menciones

- Si alguien escribe «Shiro», «SST» o menciona la cuenta de WhatsApp de Shiro, se procesa como mención directa.
- La respuesta se cita al mensaje original.
- Las tareas se ejecutan en una cola serial, de una en una, para que una respuesta no mezcle mensajes de varios usuarios.

## Privados

Solo el número configurado en `ADMIN_WHATSAPP_ID` puede conversar con Shiro por privado. Los demás reciben una respuesta de redirección al grupo, con un cooldown para evitar que el bot les escriba en cada mensaje.

Para que Shiro reconozca al administrador, configura el número completo con prefijo internacional, por ejemplo `535XXXXXXXX@s.whatsapp.net`.

## Enlaces y advertencias

La lista blanca permite YouTube, Facebook, Instagram, TikTok, X/Twitter y Twitch. WhatsApp y sus subdominios (incluidos `chat.whatsapp.com` y `wa.me`) están bloqueados.

- Primer enlace no autorizado: advertencia 1/4.
- Segundo: 2/4.
- Tercero: 3/4.
- Cuarto: intento de expulsión automática.

Shiro necesita ser administradora del grupo con permiso para eliminar mensajes y participantes. Si WhatsApp no permite borrar o expulsar, el bot lo registra en los logs y no afirma que la acción se completó.

Las advertencias se guardan en Supabase y no se reinician al reiniciar el bot.

## Sugerencias sobre Shiro

La captura solo se activa cuando el usuario se dirige a Shiro y plantea una sugerencia relacionada con ella. El contenido pasa por un clasificador y, si es constructivo, queda como `pending`.

Solo el administrador verificado puede consultar y revisar sugerencias:

```text
/sugerencias
/aprobar 12
/rechazar 12
```

También se aceptan expresiones como «Shiro, muéstrame las sugerencias» y «Shiro, aprueba sugerencia #12».

El bot no cambia su prompt por guardar una sugerencia. La aprobación queda registrada para que el administrador decida qué cambio aplicar al proyecto.

## Modelos de OpenRouter

La configuración inicial usa `stepfun/step-3.5-flash:free` y `openai/gpt-oss-20b:free` como alternativa. Las variantes gratuitas pueden tener límites de solicitudes y disponibilidad por proveedor. Comprueba los modelos activos en tu panel de OpenRouter antes de cambiar la lista.

`openrouter/aurora-alpha` no está incluido por defecto porque su coste/condiciones pueden depender del proveedor que lo sirva. Puedes añadirlo manualmente a `OPENROUTER_MODEL` si confirmas sus condiciones en tu panel.

## Notas operativas importantes

- No se ha añadido búsqueda de noticias, APIs de videojuegos ni enlaces a tiendas de recargas.
- El modelo puede decidir responder `SKIP` cuando una conversación no requiere su participación.
- Los nudges usan `America/Havana`, se activan tras 60 minutos sin mensajes y no crean intervalos duplicados durante reconexiones.
- No se ha configurado horario comercial automático de apertura/cierre porque no proporcionaste un horario de atención. No se inventa uno.
- Si el servicio de Supabase no está configurado, el bot puede funcionar, pero la memoria persistente, las sugerencias y las advertencias se mantendrán solo en memoria y se perderán al reiniciar.
- El proyecto ha pasado comprobación sintáctica de Node (`npm run check`). Eso no sustituye una prueba real con tu número, grupo, permisos, credenciales y proyecto Supabase.

## Solución de problemas

**Shiro no contesta después de unas respuestas**

Revisa `docker compose logs -f shiro`. La cola serial procesa cada mensaje sin bloquearse por los mensajes anteriores. Comprueba si OpenRouter está rechazando el modelo por límite gratuito o si se desconectó WhatsApp.

**No reconoce al administrador**

Copia el JID/número correcto a `ADMIN_WHATSAPP_ID`, usando el prefijo internacional. Evita espacios y nombres de contacto.

**No puede eliminar enlaces o expulsar miembros**

Haz a Shiro administradora del grupo y habilita permiso para eliminar mensajes/participantes.

**Pierde la sesión al reiniciar**

No elimines el volumen Docker `shiro_auth`. En un proveedor de hosting, configura un disco persistente y monta `/data/auth`.

**No aparece el QR**

Mira los logs y abre `/qr?token=TU_TOKEN`. Si el teléfono ya está vinculado, `/health` mostrará `connected: true`.
