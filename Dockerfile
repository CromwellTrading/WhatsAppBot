FROM node:20-bullseye-slim

ENV NODE_ENV=production
ENV PORT=3000
# Mantenemos la optimización de memoria de Node
ENV NODE_OPTIONS="--max-old-space-size=460"

WORKDIR /usr/src/app

# CORRECCIÓN: Agregamos 'git' y 'python3' (a veces necesario para compilaciones)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    python3 \
    make \
    g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json ./

# Instalar dependencias
RUN npm install --omit=dev --no-progress

COPY . .

EXPOSE 3000

CMD ["node", "mod-bot-baileys-full.js"]
