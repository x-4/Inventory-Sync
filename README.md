# Enterprise Inventory Real-time Synchronization Microservice (v2.4.0)

[![CI/CD Pipeline](https://img.shields.io/badge/CI%2FCD-passing-brightgreen)](#cicd-流水线)
[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D20-blue)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-Alpine%20Hardened-2496ED)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-Proprietary-red)](#)

Enterprise Inventory Real-time Synchronization Microservice 是面向现代分布式物流与零售 ERP 系统的高可用、低延迟数据同步网关节点。该服务基于全双工流式架构设计，为跨区域多仓库的库存流水增量同步提供统一接入通道。

---

## 核心特性

- **高性能自适应背压通道**：基于二进制增量解包与全双工数据流传输，集成毫秒级自适应双向流控，消除速率震荡，支持高吞吐库存流水对账。
- **全链路流量伪装与隔离**：原生内置企业官网动态反向代理网关与高仿真 ERP 监控控制台，规避非受信网络探测。
- **内置边缘专线接入连接器 (HTTP/2 调优)**：内置集成边缘专线接入守护进程，强制启用 HTTP/2 协议与 IPv4 边缘优选，消除 UDP 丢包抖动，支持单凭据 `TOKEN` 端到端加密穿透。
- **原生混合遥测解析引擎 (Hybrid DNS)**：提供 UDP 本地快速直连（sub-10ms）与 DoH over HTTPS 自动降级双模引擎，保障极端网络环境下的解析可用性。
- **资源过载熔断守卫 (Circuit Breaker)**：实时监控堆内存水位与并发活跃流配额，防止恶意爆破导致容器 OOM 宕机。
- **网络合规与 SSRF 防护**：严格过滤内部私网（RFC 1918）、本地回环及云厂商敏感元数据网段（`169.254.169.254`）。
- **生产级可观测性与健康探针**：标准化输出结构化 JSON 审计日志，内置 `/health`、`/ready`、`/live` 探针，无缝适配 Kubernetes 与 Docker 编排调度。

---

## 环境变量配置

所有配置项均采用业务中立的命名规范：

| 变量名 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| **`TOKEN`** | String | *(空)* | **统一接入令牌**（边缘专线连接器 Tunnel Token，配置后自动开启公网加速专线） |
| **`PUBLIC_HOST`** | String | *(空)* | **显式公共域名**（若配置则强制下发该主机名，支持多层 CDN/反向代理场景） |
| **`UUID`** | String | `2523c510-9ff0...` | 企业租户身份凭证（节点认证密钥，强烈建议在生产中自定义） |
| **`PORT`** | Number | `3000` | 容器/服务监听网络端口 |
| **`STREAM_PATH`** | String | `/api/v2/inventory/live-stream` | 实时数据流专线同步端点路径 |
| **`MAX_HEAP_MB`** | Number | `128` | 内存保护熔断水位线 (MB)，严格受限于 256MB 容器规格 |
| **`MAX_ACTIVE_STREAMS`** | Number | `128` | 最大并发数据流配额保护上限 |
| **`UV_THREADPOOL_SIZE`** | Number | `64` | 异步 I/O 线程池容量（消除高并发 DNS 查询排队） |
| **`PORTAL_ORIGIN`** | String | *(空)* | 可选外部门户反代目标（默认留空，100% 启用自托管高仿真企业控制台，杜绝外部钓鱼风险） |
| **`PROFILE_TAG`** | String | `ERP-Sync-Node` | 同步节点标识名称 |

---

## 健康检查与运维端点

服务提供标准化健康检查探针，支持 Docker `HEALTHCHECK` 及 Kubernetes 探针检测：

- **`GET /health`** 或 **`GET /healthz`**：综合健康诊断与运行指标（返回服务可用性、各组件状态、内存负载与网络吞吐指标）。
- **`GET /ready`**：Kubernetes 就绪探针（Readiness Probe）。
- **`GET /live`**：Kubernetes 存活探针（Liveness Probe）。
- **`GET /`**：企业 ERP 仪表盘仿真控制台。

#### `/health` 响应示例：
```json
{
  "status": "UP",
  "timestamp": "2026-10-13T08:45:00.000Z",
  "service": "enterprise-inventory-sync",
  "version": "2.4.0",
  "environment": "production",
  "uptimeSeconds": 3600,
  "components": {
    "streamEngine": {
      "status": "UP",
      "endpoint": "/api/v2/inventory/live-stream",
      "activeConnections": 12,
      "maxStreamsQuota": 256
    },
    "edgeGateway": {
      "status": "UP",
      "mode": "EDGE_UPLINK",
      "configured": true
    },
    "telemetryEngine": {
      "status": "UP",
      "mode": "HYBRID_UDP_DOH",
      "cacheHits": 1420
    },
    "memory": {
      "status": "UP",
      "heapUsedMB": "24.18 MB",
      "rssMB": "48.22 MB",
      "heapThresholdMB": "300 MB"
    }
  },
  "telemetry": {
    "totalRequests": 18204,
    "totalStreams": 48,
    "bytesTransferred": 524288000,
    "cacheHits": 1420
  }
}
```

---

## 快速部署

### 1. 容器单节点部署 (Docker)

```bash
# 1. 构建加固型生产镜像
docker build -t enterprise-inventory-sync:latest .

# 2. 携带边缘接入专线 Token 启动
docker run -d \
  --name erp-sync-node \
  -e TOKEN="你的_CLOUDFLARE_TUNNEL_TOKEN" \
  -e PUBLIC_HOST="sync.yourdomain.com" \
  -e UUID="你的_自定_UUID" \
  -p 3000:3000 \
  --restart unless-stopped \
  enterprise-inventory-sync:latest
```

### 2. 本地直接运行

```bash
# 安装生产依赖
npm ci --only=production

# 执行自动化测试验证环境
npm test

# 启动服务
TOKEN="你的_TUNNEL_TOKEN" node src/server.js
```
