FROM --platform=linux/amd64 node:20-slim AS runner

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

# 切换为 Alpine 内置非特权用户 node
USER node

ENV NODE_ENV=production
ENV PORT=3000
# 统一接入令牌 (可在平台或运行时注入，兼容边缘专线通道)
ENV TOKEN=""
# 优化异步 I/O 线程池容量
ENV UV_THREADPOOL_SIZE=64
# 严格限制 V8 堆内存上限为 160MB，适配 256MB 规格轻量容器，杜绝 OOM 崩溃
ENV NODE_OPTIONS="--max-old-space-size=160"

EXPOSE 3000

# 生产级健康检查探针 (请求 /health 端点，检查 JSON 响应状态)
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1

ENTRYPOINT ["./entrypoint.sh"]