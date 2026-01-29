FROM node:20-bullseye

ENV DEBIAN_FRONTEND=noninteractive
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
WORKDIR /usr/src/app

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
  unzip \
  && rm -rf /var/lib/apt/lists/*

# crear carpeta (efímera) usada por LocalAuth
RUN mkdir -p /usr/src/app/wwebjs_auth

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 3000

ENV CHROME_PATH=/usr/bin/chromium

CMD ["node", "mod-bot-web.js"]
