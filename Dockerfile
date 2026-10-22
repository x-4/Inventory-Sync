FROM node:20-slim AS runner

LABEL maintainer="Enterprise Cloud Engineering"
LABEL service="enterprise-inventory-sync"
LABEL version="2.4.0"

WORKDIR /app

# 安装必要的系统工具并拉取边缘网关二进制 (支持 x86_64 与 aarch64 架构)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates wget && \
    ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then CF_ARCH="amd64"; \
    elif [ "$ARCH" = "aarch64" ]; then CF_ARCH="arm64"; \
    else CF_ARCH="amd64"; fi && \
    curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" && \
    chmod 755 /usr/local/bin/cloudflared && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 安装生产依赖
COPY package.json package-lock.json* ./
RUN npm ci --only=production --ignore-scripts 2>/dev/null || npm install --omit=dev

# 复制源码与启动网关脚本
COPY src/ ./src/
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# 预先创建并授权工作区与状态缓存目录，确保非特权用户 node 拥有完整读写权
RUN mkdir -p /app/bin && chown -R node:node /app

# 切换为非特权用户 node
USER node

ENV NODE_ENV=production
# 仅保留必需项：服务标识 UUID 与边缘专线接入令牌 TOKEN (其余参数由运行时上下文自适应推导)
ENV UUID=""
ENV TOKEN=""

EXPOSE 3000

# 生产级健康检查探针 (请求 /health 端点，检查 JSON 响应状态)
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

ENTRYPOINT ["./entrypoint.sh"]