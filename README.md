# Inventory Sync Gateway Microservice (v2.5.0)

[![CI/CD Pipeline](https://img.shields.io/badge/CI%2FCD-passing-brightgreen)](#cicd-流水线)
[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D20-blue)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-Alpine%20Hardened-2496ED)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-Proprietary-red)](#)

Inventory Sync Gateway Microservice 是面向现代分布式物流与零售 ERP 系统的高可用、低延迟数据同步网关节点。该服务基于全双工流式架构设计，为跨区域多仓库的库存流水增量同步提供统一接入通道。

---

## 核心特性

- **高性能自适应背压通道**：基于二进制增量解包与全双工数据流传输，集成毫秒级自适应双向流控，消除速率震荡，支持高吞吐库存流水对账。
- **全链路业务隔离与监控大屏**：原生内置高仿真企业 ERP 监控控制台与安全路由网关，规避非受信网络探测。
- **内置边缘专线接入连接器 (HTTP/2 调优)**：内置集成边缘专线接入守护进程，强制启用 HTTP/2 协议与 IPv4 边缘优选，消除 UDP 丢包抖动，支持单凭据 `TOKEN` 端到端加密穿透。
- **原生混合遥测解析引擎**：提供 UDP 本地快速直连（sub-10ms）与安全 HTTPS 自动降级双模解析引擎，保障极端网络环境下的解析可用性。
- **资源过载熔断守卫 (Circuit Breaker)**：实时监控堆内存水位与并发活跃流配额，防止恶意爆破导致容器 OOM 宕机。
- **网络合规与 SSRF 防护**：严格过滤内部私网（RFC 1918）、本地回环及云厂商敏感元数据网段（`169.254.169.254`）。
- **生产级可观测性与健康探针**：标准化输出结构化 JSON 审计日志，内置 `/health`、`/ready`、`/live` 探针，无缝适配 Kubernetes 与 Docker 编排调度。

---

## 环境变量配置 (零维护运行时上下文自适应)

系统采用**自主上下文感知引擎**，**仅保留 `UUID` 与 `TOKEN` 为必需/核心配置项**。其余所有运行参数（网络端口、监听地址、公网域名、数据流路径、内存熔断水位线、并发连接配额、异步线程池等）均在启动时依据部署上下文（Linux Cgroup、PaaS 平台元数据、硬件规格）**自动推断并最优自适应，免除且禁止手动设置**。

| 环境变量 | 必需级别 | 默认值 / 回退策略 | 描述与自适应逻辑 |
| :--- | :---: | :--- | :--- |
| **`UUID`** | **必需项** | `2523c510-9ff0-415b-9582-93949bfae7e3` | **企业租户服务身份凭证**。用于身份鉴别与安全网关握手。支持传入单个 UUID 或多租户凭据列表（以逗号、分号或空格分隔多个 UUID）。若未提供或格式异常，系统将自动采用安全确定性备用凭证启动并记录审计警告，保证服务永不宕机。 |
| **`TOKEN`** | 可选项 | *(空，自适应直连模式)* | **统一边缘接入令牌 (Cloudflare Tunnel)**。注入后系统自动激活边缘专线隧道并拉起 `cloudflared` 守护进程；若留空则自动降级为标准独立端口直连模式。 |

> [!NOTE]
> **免除手动配置说明**：
> - **端口与绑定**：自动推断并安全绑定 `0.0.0.0`；若处于 PaaS 平台（Render, Railway, Fly.io, Heroku, Koyeb）自动无缝识别平台动态注入的端口，常规容器/VPS 默认自适应绑定 `3000`。
> - **资源与熔断水位 (`MAX_HEAP_MB`, `MAX_ACTIVE_STREAMS`)**：系统通过 Linux Cgroup (v1/v2) 及物理内存动态推算可用配额。256MB 容器自动设定 128MB 堆保护；1GB 实例自动扩展至 512MB 堆保护与 512 并发流配额，规避 OOM。
> - **路径与伪装 (`STREAM_PATH`, `PROFILE_TAG`)**：统一收敛为标准高仿真企业级端点 `/api/v2/inventory/live-stream`，节点标签自动结合平台与主机名派生。
> - 若在环境或 `.env` 中传入非必要配置，系统将自动发出审计提示并由上下文引擎接管为最优值。

---

## 健康检查与运维端点

服务提供标准化健康检查探针，支持 Docker `HEALTHCHECK` 及 Kubernetes 探针检测：

- **`GET /health`** 或 **`GET /healthz`**：综合健康诊断与运行指标（返回服务可用性、各组件状态、内存负载与网络吞吐指标）。
- **`GET /ready`**：Kubernetes 就绪探针（Readiness Probe）。
- **`GET /live`**：Kubernetes 存活探针（Liveness Probe）。
- **`GET /metrics`**：Prometheus / OpenMetrics 标准指标采集端点（提供内存水位、活跃流、租户维度流量与延迟聚合监控）。
- **`GET /`**：企业 ERP 仪表盘仿真控制台。

#### `/health` 响应示例：
```json
{
  "status": "UP",
  "timestamp": "2026-10-30T08:45:00.000Z",
  "service": "inventory-sync-gateway",
  "version": "2.5.0",
  "environment": "production",
  "uptimeSeconds": 3600,
  "components": {
    "streamEngine": {
      "status": "UP",
      "endpoint": "/api/v2/inventory/live-stream",
      "activeConnections": 12,
      "maxStreamsQuota": 256
    },
    "tunnel": {
      "status": "UP",
      "mode": "TUNNEL_ACTIVE",
      "configured": true
    },
    "datagramProcessor": {
      "status": "UP",
      "mode": "HYBRID_UDP_HTTPS",
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
    "datagramQueries": 120,
    "rejectedRequests": 0
  }
}
```

---

### 运维自检诊断套件 (Enterprise Doctor CLI)

系统原生内置全链路健康与宿主环境诊断工具，可一键验证虚拟化架构、Linux Cgroup 内存额度、端口可用性、UDP / HTTPS 遥测连通性、安全合规边界与隧道通道状态：

```bash
# 启动全链路生产环境深度自检诊断
npm run doctor
# 或直接执行 CLI 参数
node src/server.js --doctor
```

---

## 快速部署

### 1. 容器单节点部署 (Docker & Docker Compose)

#### 方案 A：Docker Compose 编排启动（推荐，自带健康自愈与资源配额）
```bash
# 启动并置于后台常驻，内置崩溃自动重启与内存限制
docker compose up -d
```

#### 方案 B：Docker 原生命令启动
```bash
# 1. 构建跨架构原生生产镜像 (支持 x86_64 与 aarch64)
docker build -t inventory-sync-gateway:2.5.0 .

# 2. 携带业务必需参数启动 (仅需 UUID 与可选 TOKEN，其余参数自适应推导)
docker run -d \
  --name inventory-sync-node \
  -e UUID="你的_自定_UUID" \
  -e TOKEN="你的_CLOUDFLARE_TUNNEL_TOKEN" \
  -p 3000:3000 \
  --restart unless-stopped \
  inventory-sync-gateway:2.5.0
```

---

### 2. Linux VPS / 物理机原生部署 (Systemd 守护引擎)

针对标准 Linux VPS（Ubuntu, Debian, CentOS, AlmaLinux 等），推荐使用内置的 Systemd 服务单元实现高可用开机自启与崩溃毫秒级自愈：

```bash
# 1. 将项目安装至 /opt 目录
sudo mkdir -p /opt/inventory-sync-gateway
sudo cp -r . /opt/inventory-sync-gateway
cd /opt/inventory-sync-gateway && npm ci --only=production

# 2. 配置环境变量文件
sudo cp .env.example .env 2>/dev/null || sudo touch .env
echo "TOKEN=你的_CLOUDFLARE_TUNNEL_TOKEN" | sudo tee -a .env
echo "UUID=你的_自定_UUID" | sudo tee -a .env

# 3. 注册并启用 Systemd 服务
sudo cp systemd/inventory-sync-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now inventory-sync-gateway

# 4. 查看运行状态与实时日志
sudo systemctl status inventory-sync-gateway
sudo journalctl -u inventory-sync-gateway -f
```

---

### 3. Node.js 运行时进程管理 (PM2 守护)

在轻量级开发机或无 root 权限的主机上，可使用 PM2 进程守护器启动：

```bash
# 全局安装 PM2 并依据 ecosystem 配置启动
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

---

### 4. PaaS / Serverless 托管部署 (GalaxyCloud, Render, Koyeb 等)

本项目原生支持**跨平台运行时自适应能力**：
- 在 **GalaxyCloud**、**Render**、**Koyeb** 等标准 Node.js PaaS 平台托管时，无需配置 Docker 镜像或外部守护脚本。
- 服务启动时内置的边缘网关引擎会自动检测宿主操作系统与 CPU 架构（Linux x64/arm64 等），若未预装 `cloudflared`，将自动从官方镜像拉取二进制文件并由 Node.js 看门狗实施 7x24 小时生命周期守护与自动重连。
- 只需在 PaaS 控制台配置环境变量：
  - `TOKEN`: 你的 Cloudflare Tunnel Token
  - `UUID`: 你的自定义身份凭据
  - `PUBLIC_HOST`: 你的公网自定义域名（可选）

---

## 自动化测试与质量保障

项目采用 Node.js 原生测试运行器（`node:test`），提供 100% 无外部测试依赖的轻量高效验证套件：

```bash
# 执行全部单元与集成测试套件（覆盖协议解包、多租户鉴权、SSRF 防护、速率限制等）
npm test
```


