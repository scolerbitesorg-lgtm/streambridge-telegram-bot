FROM node:22-bookworm-slim

# Install ffmpeg, ffprobe, and SSL certificates for HLS/MP4 downloading & Telegram MTProto
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package manifests first
COPY package*.json ./

# Install all dependencies (including devDependencies like tsx and vite)
RUN npm install --include=dev --legacy-peer-deps

# Copy full application source
COPY . .

# Build the React status dashboard before setting NODE_ENV=production
RUN npm run build

# Set runtime environment variables after build completes
ENV NODE_ENV=production \
    PORT=10000

# Ensure full read/write permissions for bot-config.json and temp downloads
RUN chmod -R 777 /app

EXPOSE 10000

# Start the 24/7 Telegram Bot + Express Status Server
CMD ["npx", "tsx", "server.ts"]
