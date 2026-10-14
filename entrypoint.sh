#!/bin/sh
set -e

# ====================================================================
# Enterprise Edge Gateway & Service Bootstrapper
# Initializes secure edge uplinks and launches core microservice
# ====================================================================

# 1. 严格内存控制：将 Node.js V8 堆内存上限严格限制在 160MB (适配 256MB 轻量容器，杜绝 OOM)
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=160}"

# 2. 优化异步 I/O 线程池容量 (消除高并发 DNS 查询排队延迟)
export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-64}"

# 企业边缘接入令牌 (统一使用 TOKEN 环境变量)
EDGE_TOKEN="${TOKEN:-$EDGE_GATEWAY_TOKEN}"

TUNNEL_WATCHDOG_PID=""
RUNNING=1

# 优雅停机信号处理
cleanup() {
    RUNNING=0
    echo "[EdgeGateway] Received shutdown signal. Terminating runtime processes..."
    if [ -n "$TUNNEL_WATCHDOG_PID" ]; then
        kill -TERM "$TUNNEL_WATCHDOG_PID" 2>/dev/null || true
    fi
    killall cloudflared 2>/dev/null || true
    exit 0
}

trap cleanup INT TERM

# 边缘连接器看门狗守护循环 (Auto-Restart Supervisor for 7x24 Zero-Maintenance)
start_tunnel_supervisor() {
    while [ "$RUNNING" -eq 1 ]; do
        echo "[EdgeGateway] Starting edge connector instance (Protocol: HTTP/2, IPv4)..."
        cloudflared tunnel --no-autoupdate --protocol http2 --edge-ip-version 4 run --token "$EDGE_TOKEN" > /dev/null 2>&1 || true
        if [ "$RUNNING" -eq 1 ]; then
            echo "[EdgeGateway] Edge connector process exited. Watchdog restarting in 3s..."
            sleep 3
        fi
    done
}

if [ -n "$EDGE_TOKEN" ]; then
    echo "[EdgeGateway] Enterprise uplink token configured. Activating watchdog supervisor..."
    start_tunnel_supervisor &
    TUNNEL_WATCHDOG_PID=$!
else
    echo "[EdgeGateway] Standalone deployment mode: Operating on direct port binding."
fi

# 启动核心业务服务
exec node src/server.js
