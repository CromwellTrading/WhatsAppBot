FROM node:20-bullseye-slim

ENV NODE_ENV=production
ENV PORT=3000
# Limita la memoria de Node a ~460MB para dejar espacio al SO dentro del límite de 512MB de Render
ENV NODE_OPTIONS="--max-old-space-size=460"

WORKDIR /usr/src/app

# Instalar dependencias del sistema necesarias
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json ./

# Instalar solo dependencias de producción
RUN npm install --omit=dev --no-progress

COPY . .

EXPOSE 3000

CMD ["node", "mod-bot-baileys-full.js"]
