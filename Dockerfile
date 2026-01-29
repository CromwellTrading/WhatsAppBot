# Usa bullseye para mejor compatibilidad con Chromium
FROM node:20-bullseye

ENV DEBIAN_FRONTEND=noninteractive
# Evitar que puppeteer descargue su propio chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Instalar chromium y dependencias del sistema
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

# Copiamos archivos de dependencias
COPY package*.json ./

# Instalación limpia y sin dependencias de desarrollo
RUN npm ci --omit=dev

# Copiar el resto del código
COPY . .

# Exponer el puerto de Express
EXPOSE 3000

# Definir la ruta de Chromium instalada en el sistema
ENV CHROME_PATH=/usr/bin/chromium

# Iniciar la aplicación
CMD ["node", "mod-bot-web.js"]
