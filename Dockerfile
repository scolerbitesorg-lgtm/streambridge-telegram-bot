FROM node:20-bookworm-slim

# Install ffmpeg, ffprobe, and SSL certificates for HLS/MP4 downloading & Telegram MTProto
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user required by Hugging Face Spaces (UID 1000)
RUN useradd -m -u 1000 user || true
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    NODE_ENV=production \
    PORT=7860

WORKDIR $HOME/app

# Copy package manifests first
COPY --chown=user:user package*.json ./

# Install all dependencies (including tsx and vite for building)
RUN npm install --include=dev

# Copy full application source
COPY --chown=user:user . .

# Build the React status dashboard
RUN npm run build

EXPOSE 7860

# Start the 24/7 Telegram Bot + Express Status Server
CMD ["npx", "tsx", "server.ts"]
