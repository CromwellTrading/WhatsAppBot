# Dockerfile - Recomendado para Render (estabilidad y compatibilidad)
FROM node:20-bullseye-slim

ENV NODE_ENV=production
ENV PORT=3000
ENV AUTH_DIR=/usr/src/app/baileys_auth

# utilidades necesarias (git porque algunas dependencias pueden venir por git)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    tini \
  && rm -rf /var/lib/apt/lists/*

# usuario no-root
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser

WORKDIR /usr/src/app

# copiar package.json (cache de capas)
COPY package.json package-lock.json* ./

# instalar dependencias sin dev
RUN npm install --omit=dev --no-progress

# copiar código
COPY . .

# crear carpeta auth temporal
RUN mkdir -p ${AUTH_DIR} && chown -R appuser:appgroup /usr/src/app

EXPOSE 3000

USER appuser

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "mod-bot-baileys-full.js"]
