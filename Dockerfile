# Dockerfile - para Render (incluye chromium)
FROM node:20-bullseye

ENV DEBIAN_FRONTEND=noninteractive
# evitar que puppeteer descargue su chromium (usaremos el del sistema)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# instalar chromium y deps mínimos para puppeteer
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
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# copiar package.json primero para cache
COPY package.json package-lock.json* ./

# instalar dependencias (puppeteer no descargará chromium por la var de entorno)
RUN npm install --production

# copiar el resto del código
COPY . .

# Exponer puerto (ajusta si usas otro)
EXPOSE 3000

# Ruta del chromium del sistema (usada por mod-bot-web.js si está definida)
ENV CHROME_PATH=/usr/bin/chromium

# Iniciar
CMD ["node", "mod-bot-web.js"]
