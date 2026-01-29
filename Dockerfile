# Dockerfile - Baileys (ligero)
FROM node:20-alpine

# variables de entorno por defecto
ENV NODE_ENV=production
ENV PORT=3000
ENV AUTH_DIR=/usr/src/app/baileys_auth

# instalar utilidades necesarias (si alguna falla en alpine, quítalas)
RUN apk add --no-cache bash tini

# crear usuario no root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /usr/src/app

# copiar package.json y lock para aprovechar cache de capa
COPY package.json package-lock.json* ./

# instalar dependencias (solo prod)
RUN npm ci --only=production --no-progress || npm install --production --no-progress

# copiar el código
COPY . .

# crear carpeta para auth y darle permisos
RUN mkdir -p ${AUTH_DIR} && chown -R appuser:appgroup /usr/src/app

# exponer puerto
EXPOSE 3000

# usamos tini para pid1 y manejos de signals
USER appuser

# comando por defecto
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "mod-bot-baileys-full.js"]
