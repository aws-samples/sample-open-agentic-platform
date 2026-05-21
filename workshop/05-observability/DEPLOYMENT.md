# Gateway Deployment Guide

## Prerequisites

- KGateway already installed with Kagent ✓
- Prometheus (optional, for metrics)
- Langfuse account (optional, for LLM tracing)

## Deployment Steps

### 1. Deploy Observability (Optional but Recommended)

#### Prometheus for Gateway Metrics
```bash
kubectl apply -f observability/prometheus/prometheus-config.yaml
```

**What you get:**
- Request rates per agent
- Latency percentiles
- Error rates
- Tool call metrics
- Alerts for high latency/errors

**Access:**
```bash
kubectl port-forward -n kagent svc/prometheus 9090:9090
# Open http://localhost:9090
```

#### Langfuse for LLM Tracing
```bash
# 1. Update langfuse-keys secret with your keys
kubectl apply -f observability/langfuse/langfuse-config.yaml
```

**What you get:**
- LLM prompt/completion traces
- Token usage and costs per agent
- Tool call sequences
- Agent-to-agent call traces
- User feedback tracking

**Access:**
- Cloud: https://cloud.langfuse.com
- Self-hosted: Your Langfuse URL

### 2. Deploy Gateway Routes

#### LLM Gateway
```bash
kubectl apply -f llm/llm-gateway-route.yaml
```

**Features:**
- Rate limiting per agent (configured in ConfigMap)
- Request/response headers for tracking
- Model routing and failover

**Agents covered:**
- first-agent: 60 req/min, 100k tokens/day
- k8s-ops-agent: 100 req/min, 200k tokens/day
- smart-assistant: 50 req/min, 50k tokens/day
- financial-advisor: 80 req/min, 150k tokens/day
- All specialist agents: 60 req/min, 80k tokens/day

#### MCP Tools Gateway
```bash
kubectl apply -f mcp-tools/mcp-tools-gateway-route.yaml
```

**Features:**
- Tool access authorization (which agents can use which tools)
- Request validation (MCP protocol compliance)
- Separate routes for different tool servers

**Tool Access Control:**
- Multi-tool server: Only smart-assistant
- Financial tools: Appropriate specialist agents + orchestrator

#### A2A Gateway
```bash
kubectl apply -f a2a/a2a-gateway-route.yaml
```

**Features:**
- Agent-to-agent routing
- Distributed tracing
- Load balancing across agent replicas
- Timeout and retry policies

**A2A Patterns:**
- financial-advisor → portfolio-analyst, risk-assessment, market-data

### 3. Verify Deployment

```bash
# Check HTTPRoutes
kubectl get httproute -n kagent

# Check ConfigMaps
kubectl get configmap -n kagent | grep -E "gateway|langfuse|prometheus"

# Check gateway logs
kubectl logs -n kagent -l app=kgateway-agent -f
```

### 4. Test Gateway Routes

#### Test LLM Gateway
```bash
kubectl run test-llm --rm -i --restart=Never --image=curlimages/curl -- \
  curl -X POST http://llm.kagent.local/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-agent-id: smart-assistant" \
  -d '{"model":"claude-3-5-sonnet","messages":[{"role":"user","content":"Hello"}]}'
```

#### Test MCP Tools Gateway
```bash
kubectl run test-mcp --rm -i --restart=Never --image=curlimages/curl -- \
  curl -X POST http://tools.kagent.local/mcp \
  -H "Content-Type: application/json" \
  -H "x-mcp-server: kagent-multi-agent-tools-server" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

#### Test A2A Gateway
```bash
kubectl run test-a2a --rm -i --restart=Never --image=curlimages/curl -- \
  curl -X POST http://agents.kagent.local/ \
  -H "Content-Type: application/json" \
  -H "x-source-agent: financial-advisor" \
  -d '{"query":"Analyze portfolio"}'
```

## Monitoring

### Prometheus Metrics

**Key Metrics:**
```promql
# Request rate per agent
rate(agent_llm_requests_total[5m])

# P50 latency
histogram_quantile(0.5, rate(agent_llm_duration_seconds_bucket[5m]))

# Error rate
rate(agent_requests_total{status=~"5.."}[5m]) / rate(agent_requests_total[5m])

# Tool calls per agent
rate(agent_tool_calls_total[5m])
```

**Dashboards:**
- Gateway Overview: Request rates, latencies, errors
- Agent Performance: Per-agent metrics
- Tool Usage: Tool call frequencies and latencies
- Cost Tracking: Token usage per agent

### Langfuse Traces

**What to Monitor:**
1. **Cost Analysis**: Which agents are most expensive?
2. **Tool Usage**: Which tools are called most frequently?
3. **A2A Patterns**: How do agents collaborate?
4. **Error Patterns**: What's failing and why?
5. **Latency Breakdown**: Where is time spent?

**Example Trace:**
```
Session: "Portfolio Analysis Request"
├─ Agent: financial-advisor (2.3s, $0.045)
│  ├─ LLM: Understand request (0.8s, $0.012)
│  ├─ A2A: portfolio-analyst (0.9s, $0.018)
│  │  ├─ Tool: calculate_portfolio_value (0.2s)
│  │  └─ Tool: get_stock_price (0.3s)
│  ├─ A2A: risk-assessment (0.4s, $0.010)
│  │  └─ Tool: calculate_risk_score (0.1s)
│  └─ LLM: Synthesize response (0.6s, $0.015)
```

## Troubleshooting

### Gateway Not Routing
```bash
# Check HTTPRoute status
kubectl describe httproute llm-gateway -n kagent

# Check gateway logs
kubectl logs -n kagent -l app=kgateway-agent --tail=100
```

### Rate Limiting Issues
```bash
# Check rate limit config
kubectl get configmap llm-gateway-config -n kagent -o yaml

# Monitor rate limit hits in Prometheus
rate(gateway_rate_limit_hits_total[5m])
```

### Langfuse Not Receiving Traces
```bash
# Check secret
kubectl get secret langfuse-keys -n kagent

# Check agent logs for Langfuse errors
kubectl logs -n kagent <agent-pod> | grep -i langfuse
```

## Next Steps

1. **Customize Rate Limits**: Edit `llm/llm-gateway-route.yaml` ConfigMap
2. **Add More Policies**: Create additional HTTPRoute filters
3. **Set Up Alerts**: Configure Prometheus alerting rules
4. **Create Dashboards**: Build Grafana dashboards for your metrics
5. **Analyze Costs**: Use Langfuse to optimize expensive agents
6. **Tune Performance**: Use traces to identify bottlenecks

## Notes

- **HTTPRoute CRDs**: These are declarative configs. KGateway may need additional configuration to fully implement all features shown.
- **Langfuse Integration**: Requires agent SDK support. Check if Kagent has built-in Langfuse integration or uses OpenTelemetry.
- **Prometheus**: Assumes KGateway exposes Prometheus metrics. Verify metrics endpoint.
- **Testing**: The test commands assume internal DNS resolution. Adjust for your cluster setup.
