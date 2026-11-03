# Producción — Node.js 20
FROM node:20-bullseye-slim

ENV NODE_ENV=production
ENV PORT=3000
ENV NODE_OPTIONS="--max-old-space-size=460"
ENV AUTH_DIR=/data/auth

WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    make \
    g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-progress --no-audit

COPY . .

RUN mkdir -p /data/auth && chown -R node:node /data
USER node

VOLUME ["/data/auth"]
EXPOSE 3000

CMD ["node", "sst-bot.js"]
