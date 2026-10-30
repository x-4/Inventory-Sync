#!/bin/sh
set -e

# ====================================================================
# Service Bootstrapper
# Initializes runtime constraints and launches core service
# ====================================================================

# 1. Memory control: limit V8 heap to 160MB (fits 256MB containers, prevents OOM)
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=160}"

# 2. Optimize async I/O threadpool (eliminates high-concurrency DNS queueing delay)
export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-64}"

# Launch service (tunnel management is handled internally)
exec node src/server.js
