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

# 启动核心业务服务 (Node.js 内部已集成跨平台自适应边缘连接器看门狗引擎)
exec node src/server.js
