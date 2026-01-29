FROM node:18-alpine

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

# Instalar solo lo necesario
RUN apk add --no-cache tini

COPY package*.json ./
RUN npm ci --only=production

COPY . .

USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "mod-bot-baileys-full.js"]
