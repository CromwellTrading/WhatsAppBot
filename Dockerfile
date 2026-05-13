FROM node:18-alpine

# Instalar git (necesario para algunas dependencias)
RUN apk add --no-cache git

WORKDIR /app

COPY package*.json ./

# Usa --omit=dev (recomendado) o --only=production
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "sst-bot.js"]
