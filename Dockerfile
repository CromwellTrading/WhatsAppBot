# Dockerfile - Baileys (estable y simple)
FROM node:20-bullseye-slim

ENV NODE_ENV=production
ENV PORT=3000
ENV AUTH_DIR=/usr/src/app/baileys_auth

# instalar utilidades necesarias
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    tini \
  && rm -rf /var/lib/apt/lists/*

# crear usuario no-root
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser

WORKDIR /usr/src/app

# copiar package.json (mejor caché de capas)
COPY package.json package-lock.json* ./

# instalar dependencias (sin dev)
RUN npm install --omit=dev --no-progress

# copiar el resto del código
COPY . .

# crear carpeta para auth y dar permisos
RUN mkdir -p ${AUTH_DIR} && chown -R appuser:appgroup /usr/src/app

EXPOSE 3000

USER appuser

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "mod-bot-baileys-full.js"]
