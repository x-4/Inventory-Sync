FROM node:20-slim AS runner

LABEL maintainer="Cloud Engineering"
LABEL service="inventory-sync-gateway"
LABEL version="2.5.0"

WORKDIR /app

# Install system tools and download tunnel binary (supports x86_64 and aarch64)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates wget && \
    ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then CF_ARCH="amd64"; \
    elif [ "$ARCH" = "aarch64" ]; then CF_ARCH="arm64"; \
    else CF_ARCH="amd64"; fi && \
    curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" && \
    chmod 755 /usr/local/bin/cloudflared && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --only=production --ignore-scripts 2>/dev/null || npm install --omit=dev

# Copy source and entrypoint
COPY src/ ./src/
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Create and authorize workspace directories for non-privileged user
RUN mkdir -p /app/bin && chown -R node:node /app

# Switch to non-privileged user
USER node

ENV NODE_ENV=production
# Only essential variables: service credential UUID and tunnel token TOKEN
ENV UUID=""
ENV TOKEN=""

EXPOSE 3000

# Health check probe
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

ENTRYPOINT ["./entrypoint.sh"]