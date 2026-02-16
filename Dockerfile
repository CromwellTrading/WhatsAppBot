# Dockerfile (producción)
FROM node:20-bullseye-slim

ENV NODE_ENV=production
ENV PORT=3000
ENV NODE_OPTIONS="--max-old-space-size=460"

WORKDIR /usr/src/app

# Dependencias básicas (git/python para builds nativas)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    python3 \
    make \
    g++ \
 && rm -rf /var/lib/apt/lists/*

# Copiamos package.json y package-lock.json (si existe) primero para cachear npm install
COPY package.json package-lock.json* ./

# Instalar dependencias (production)
RUN npm install --omit=dev --no-progress --no-audit

# Copiamos el resto del código
COPY . .

EXPOSE 3000

CMD ["node", "sst-bot.js"]
