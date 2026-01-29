FROM node:20-bullseye-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Instalar solo lo esencial
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgbm1 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    wget \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

WORKDIR /usr/src/app

# Copiar package.json primero para mejor cacheo
COPY package*.json ./

# Instalar dependencias de producción
RUN npm ci --only=production --no-audit --no-fund

# Copiar código fuente
COPY . .

# Crear directorio para sesiones
RUN mkdir -p wwebjs_auth && chmod 755 wwebjs_auth

# Variables de entorno
ENV CHROME_PATH=/usr/bin/chromium
ENV NODE_ENV=production
ENV PORT=3000

# Exponer puerto
EXPOSE 3000

# Usar usuario no root para seguridad
USER node

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Iniciar aplicación
CMD ["node", "mod-bot-web.js"]
