FROM node:20-bullseye-slim

ENV NODE_ENV=production
ENV PORT=3000
ENV AUTH_DIR=/usr/src/app/baileys_auth

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    tini \
  && rm -rf /var/lib/apt/lists/*

RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser

WORKDIR /usr/src/app

COPY package.json package-lock.json* ./

# CAMBIO CRÍTICO: Usa npm install, NO npm ci
RUN npm install --omit=dev --no-progress

COPY . .

RUN mkdir -p ${AUTH_DIR} && chown -R appuser:appgroup /usr/src/app

EXPOSE 3000

USER appuser

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "mod-bot-baileys-full.js"]
