# Gateway Implementation for Kagent Agents

This directory contains KGateway configurations for secure, observable connectivity between agents, LLMs, and tools.

## Directory Structure

```
gateway/
├── llm/                    # Agent → LLM gateway routes
├── mcp-tools/             # Agent → MCP Tools gateway routes
├── a2a/                   # Agent → Agent gateway routes
└── observability/         # Monitoring and tracing configs
```

## Observability Stack

### Prometheus + Grafana
- **Purpose**: Infrastructure and gateway metrics
- **Tracks**: Request rates, latencies, errors, resource usage
- **Location**: `observability/prometheus/`

### Langfuse (Optional)
- **Purpose**: LLM and agent behavior tracking
- **Tracks**: Prompts, completions, costs, tool calls, reasoning traces
- **Location**: `observability/langfuse/`

### Combined View
```
User → KGateway (Prometheus) → Agent (Langfuse) → LLM/Tools
       └─ HTTP metrics          └─ LLM traces
```

## Quick Start

### 1. Deploy Observability
```bash
# Prometheus for gateway metrics
kubectl apply -f observability/prometheus/

# Langfuse for LLM traces (optional)
kubectl apply -f observability/langfuse/
```

### 2. Deploy Gateway Routes
```bash
# LLM gateway
kubectl apply -f llm/

# MCP Tools gateway
kubectl apply -f mcp-tools/

# A2A gateway
kubectl apply -f a2a/
```

### 3. Verify
```bash
# Check routes
kubectl get httproute -n kagent

# Check metrics
kubectl port-forward -n kagent svc/prometheus 9090:9090

# Check Langfuse (if deployed)
kubectl port-forward -n kagent svc/langfuse 3000:3000
```

## Patterns Implemented

### Pattern 1: LLM Gateway
- Rate limiting per agent
- Cost tracking
- Model failover
- Request/response logging

### Pattern 2: MCP Tools Gateway
- Tool access authorization
- Request validation
- Response caching
- Audit logging

### Pattern 3: A2A Gateway
- Agent discovery
- Load balancing
- Distributed tracing
- Circuit breaking

## Agents Covered

- ✅ first-agent
- ✅ k8s-ops-agent
- ✅ smart-assistant (multi-tool-agent)
- ✅ financial-advisor (multi-agents)
- ✅ portfolio-analyst
- ✅ risk-assessment
- ✅ market-data
