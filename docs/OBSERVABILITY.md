# Observability Architecture

## Overview

The Open Agentic Platform uses a dual-pipeline observability strategy:

- **Langfuse** — LLM trace visualization (agent reasoning, tool calls, token usage, costs)
- **Amazon Managed Grafana (AMG)** — operational dashboards (latency, throughput, system health)

Jaeger is not used. Langfuse acts as the distributed tracer for agent workloads.

## Architecture

```
Spoke Clusters (dev, prod)                         Hub Cluster
┌─────────────────────────────────┐     ┌──────────────────────────────────────┐
│                                 │     │                                      │
│  Agent (Strands)                │     │  Langfuse v3                         │
│    ├─ StrandsTelemetry SDK      │     │    ├─ Web (:3000)                    │
│    │    OTLP/HTTP direct ───────┼─────┼──► │   /api/public/otel             │
│    │    (traces with GenAI      │HTTPS│    ├─ Worker (async processing)      │
│    │     semantic attributes)   │     │    ├─ Redis (queue)                  │
│    │                            │     │    ├─ ClickHouse (OLAP trace store)  │
│    └─ W3C traceparent header    │     │    ├─ MinIO (S3 event upload)        │
│         ↓                       │     │    └─ PostgreSQL (metadata)          │
│  Bifrost Proxy                  │     │                                      │
│    ├─ Receives traceparent      │     │  Seed CronJob (every 5min)           │
│    ├─ Creates child LLM spans   │     │    └─ Auto-assigns SSO users         │
│    └─ Exposes :8080/metrics     │     │                                      │
│         ↓                       │     │  AMG (Grafana)                       │
│  OTel Collector                 │     │    ├─ AMP datasource (Prometheus)    │
│    ├─ Traces → X-Ray            │     │    └─ Agent Platform dashboards      │
│    └─ Metrics → AMP             │     │                                      │
│                                 │     └──────────────────────────────────────┘
│  Prometheus Scrapers (AMP)      │
│    └─ kube-state-metrics        │
│    └─ node-exporter             │
└─────────────────────────────────┘
```

## Trace Flow (Agent → Langfuse)

1. Agent creates a root span via `StrandsTelemetry.setup_otlp_exporter()`
2. Agent injects W3C `traceparent` header into Bifrost LLM call
3. Bifrost creates nested child spans (model, tokens, latency)
4. Both agent and Bifrost push spans via OTLP/HTTP to Langfuse's `/api/public/otel` endpoint
5. Langfuse Web accepts the payload, queues to Redis
6. Langfuse Worker reads from Redis, stores raw event in MinIO (S3), writes structured data to ClickHouse
7. Traces visible in Langfuse UI with full parent-child hierarchy

### Authentication

Traces are authenticated via HTTP Basic Auth:
- Header: `Authorization: Basic <base64(publicKey:secretKey)>`
- Header: `x-langfuse-ingestion-version: 4` (enables real-time Fast Preview)
- Keys are created by the Langfuse seed CronJob and stored in the Langfuse database

### Agent Configuration (OAM ComponentDefinition)

The `agent` OAM component injects these env vars:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.otel.svc.cluster.local:4318
OTEL_SERVICE_NAME=<agent-name>
LANGFUSE_PUBLIC_KEY=<from OAM Application properties>
LANGFUSE_SECRET_KEY=<from OAM Application properties>
LANGFUSE_BASE_URL=https://<ingress_domain>
```

The agent's `main.py` initializes `StrandsTelemetry().setup_otlp_exporter()` at startup which configures the OTLP exporter pointing to Langfuse.

## Metrics Flow (Bifrost → Grafana)

1. Bifrost exposes Prometheus metrics at `:8080/metrics`
2. OTel Collector scrapes Bifrost metrics (prometheus receiver)
3. Collector forwards to AMP via `prometheusremotewrite` exporter
4. AMG (Grafana) queries AMP for dashboards

### Metrics Available

| Metric | Source | Description |
|--------|--------|-------------|
| Request latency per model | Bifrost | P50/P95/P99 latency by model |
| Token usage | Bifrost | Input/output/total tokens per request |
| Provider cost | Bifrost | Cost tracking by model provider |
| Cache hit ratio | Bifrost | Virtual key cache effectiveness |
| Pod CPU/Memory | kube-state-metrics | Resource usage by namespace |
| Node health | node-exporter | Cluster infrastructure metrics |

## Langfuse v3 Infrastructure

Deployed on the hub cluster only (namespace: `langfuse`).

| Component | Image | Purpose |
|-----------|-------|---------|
| langfuse (Web) | `langfuse/langfuse:3` | API + UI, OTLP receiver |
| langfuse-worker | `langfuse/langfuse-worker:3` | Async event processing |
| langfuse-postgres | `postgres:16-alpine` | Metadata, users, projects |
| langfuse-clickhouse | `clickhouse/clickhouse-server:24.12` | OLAP trace/observation storage |
| langfuse-redis | `redis:7-alpine` | Async queue + cache |
| langfuse-minio | `minio/minio:latest` | S3-compatible blob storage (event upload) |

### Why MinIO?

Langfuse v3 requires S3-compatible blob storage for its event ingestion pipeline. Raw OTLP events are written to S3 before being processed into ClickHouse. Without it, the OTLP endpoint returns 500. MinIO provides this locally without requiring an AWS S3 bucket.

### Seed CronJob

Runs every 5 minutes (idempotent):
1. Creates "Agent Platform" organization
2. Creates "agent-platform" project
3. Creates API keys for OTLP authentication
4. Auto-assigns any new Keycloak SSO users as OWNER of org + project

## OTel Collector

Deployed on every spoke cluster (namespace: `otel`).

Two pipelines:
- **Traces:** OTLP receiver (HTTP:4318) → otlphttp/langfuse exporter
- **Metrics:** Prometheus scraper (Bifrost) → AMP remote write

The Langfuse trace export happens directly from the agent SDK, not through the collector. The collector handles infrastructure-level traces (X-Ray service maps) and Bifrost metrics only.

## Grafana Dashboards (AMG)

Three agent-platform dashboards in the "Agent Platform" folder:

### Agent Platform — Overview
- OAM Agent pods count
- MCP Server pods count
- LiteLLM/Bifrost readiness
- AgentGateway readiness
- CPU/Memory by namespace (litellm, bifrost, otel, agentgateway-system, mcp-*)
- Pod restarts (last 1h)
- Argo Rollout replicas

### Agent Platform — LiteLLM Gateway
- LiteLLM CPU/Memory
- Bifrost CPU/Memory
- Network I/O

### Agent Platform — X-Ray Traces
- Service map (node graph)
- Recent traces (table)

## Access

| Service | URL | Auth |
|---------|-----|------|
| Langfuse UI | `https://<ingress_domain>/` | Keycloak SSO (user1) |
| Langfuse OTLP | `https://<ingress_domain>/api/public/otel/v1/traces` | Basic Auth (API keys) |
| AMG (Grafana) | `https://g-<id>.grafana-workspace.<region>.amazonaws.com` | Keycloak SSO |
| Langfuse API | `https://<ingress_domain>/api/public/traces` | Basic Auth (API keys) |
