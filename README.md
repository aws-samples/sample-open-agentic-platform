# Agent Platform on Amazon EKS

A production-ready, enterprise-grade AI agent platform built on Amazon EKS using [Kagent](https://kagent.dev), featuring comprehensive observability, intelligent gateway routing, and multi-agent orchestration.

## 🎯 Overview

This project demonstrates a complete AI agent platform with:
- **Multiple agent patterns** - Simple agents, K8s operators, multi-tool agents, and multi-agent collaboration
- **Production observability** - LLM tracing, distributed tracing, cost tracking, and infrastructure metrics
- **Intelligent gateway** - Rate limiting, caching, fallbacks, and load balancing via LiteLLM
- **Real-world use case** - Financial services multi-agent system with agent-to-agent (A2A) communication

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Platform                            │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ Simple Agent │  │ K8s Ops      │  │ Multi-Tool   │     │
│  │              │  │ Agent        │  │ Agent        │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                  │                  │              │
│         └──────────────────┼──────────────────┘              │
│                            │                                 │
│         ┌──────────────────▼──────────────────┐             │
│         │   Financial Services Multi-Agent    │             │
│         │                                      │             │
│         │  ┌────────────┐  ┌────────────┐    │             │
│         │  │ Portfolio  │  │ Risk       │    │             │
│         │  │ Analyst    │  │ Assessment │    │             │
│         │  └─────┬──────┘  └─────┬──────┘    │             │
│         │        │                │           │             │
│         │        └────────┬───────┘           │             │
│         │                 │                   │             │
│         │         ┌───────▼────────┐          │             │
│         │         │ Financial      │          │             │
│         │         │ Advisor        │          │             │
│         │         │ (Orchestrator) │          │             │
│         │         └────────────────┘          │             │
│         └─────────────────────────────────────┘             │
│                            │                                 │
└────────────────────────────┼─────────────────────────────────┘
                             │
                ┌────────────▼────────────┐
                │   LiteLLM Gateway       │
                │  - Rate Limiting        │
                │  - Caching (Redis)      │
                │  - Fallbacks            │
                │  - Cost Tracking        │
                └────────────┬────────────┘
                             │
                ┌────────────▼────────────┐
                │   Amazon Bedrock        │
                │   Claude 3.5 Sonnet     │
                └─────────────────────────┘

                    Observability Stack
        ┌──────────────┬──────────────┬──────────────┐
        │              │              │              │
   ┌────▼────┐   ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
   │Langfuse │   │ Jaeger  │   │Prometheus│   │ Grafana │
   │LLM Trace│   │Dist.Trac│   │ Metrics  │   │  Viz    │
   └─────────┘   └─────────┘   └──────────┘   └─────────┘
```

## 🚀 What's Included

### Agent Examples

#### 1️⃣ **Simple Agent** (`01-first-agent/`)
Basic agent demonstrating core Kagent functionality with Bedrock integration.

#### 2️⃣ **K8s Operations Agent** (`02-k8s-ops-agent/`)
Kubernetes-aware agent that can query and manage cluster resources.

#### 3️⃣ **Multi-Tool Agent** (`03-multi-tool-agent/`)
Smart assistant with multiple capabilities via MCP (Model Context Protocol):
- **Calculator** - Mathematical computations
- **Web Search** - Real-time information retrieval
- **Weather** - Current weather data
- **DateTime** - Timezone-aware date/time operations

#### 4️⃣ **Financial Services Multi-Agent System** (`04-multi-agents/financial-services/`)
Production-ready multi-agent system demonstrating agent-to-agent (A2A) collaboration:

**Specialist Agents:**
- **Portfolio Analyst** - Portfolio valuation and analysis
- **Risk Assessment** - Risk evaluation and compliance
- **Market Data** - Real-time market information

**Orchestrator:**
- **Financial Advisor** - Coordinates specialists to provide comprehensive financial advice

**Example Interaction:**
```
User: "I have 100 AAPL and 50 GOOGL shares. Is my portfolio balanced?"

Financial Advisor (Orchestrator)
    ├─→ Portfolio Analyst: Calculate total value
    ├─→ Risk Assessment: Evaluate risk profile
    ├─→ Market Data: Get current prices
    └─→ Synthesizes response with actionable advice
```

### Observability Stack (`05-observability/`)

#### **LiteLLM Gateway**
Intelligent proxy for LLM requests with enterprise features:
- ✅ **Rate Limiting** - 100 RPM, 100K TPM (configurable per agent)
- ✅ **Caching** - Redis-backed response caching (1-hour TTL)
- ✅ **Fallbacks** - Claude Sonnet → Claude Haiku on failures
- ✅ **Load Balancing** - Distribute across multiple model instances
- ✅ **Cost Tracking** - Real-time token usage and cost monitoring

#### **Langfuse**
LLM-specific observability platform:
- 📊 **Trace every LLM call** - Prompts, completions, tokens, costs
- 💰 **Cost analytics** - Per-agent, per-model, per-request
- 🔍 **Debug conversations** - Full context and tool calls
- 📈 **Usage trends** - Token consumption over time

#### **Jaeger**
Distributed tracing for agent interactions:
- 🔗 **Agent-to-agent traces** - A2A communication flows
- ⏱️ **Latency analysis** - Identify bottlenecks
- 🌐 **Request correlation** - End-to-end visibility

#### **Prometheus + Grafana**
Infrastructure and application metrics:
- 📉 **Kagent controller metrics** - Reconciliation rates, errors
- 🖥️ **Resource usage** - CPU, memory, network per agent
- 🚨 **Alerting** - High error rates, latency spikes

## 📋 Prerequisites

- Amazon EKS cluster (1.28+)
- kubectl configured
- Helm 3.x
- AWS credentials with Bedrock access
- Podman or Docker (for building custom tools)

## 🛠️ Quick Start

### 1. Initial Setup

```bash
# Install Kagent CRDs and operator
cd 00-initial-setup
kubectl apply -f bedrock-key.yaml
kubectl apply -f litellm-config.yaml
kubectl apply -f litellm-deploy.yaml

# Install Kagent via Helm
helm install kagent-crds oci://public.ecr.aws/kagent-dev/kagent-crds --version 0.7.9 -n kagent --create-namespace
helm install kagent oci://public.ecr.aws/kagent-dev/kagent --version 0.7.9 -n kagent -f values.yaml
```

### 2. Deploy Observability Stack

```bash
cd 05-observability/langfuse

# Deploy Langfuse
kubectl apply -f 00-langfuse-secrets.yaml
kubectl apply -f 01-postgres.yaml
kubectl apply -f 02-langfuse-deployment.yaml

# Setup LiteLLM gateway features
./setup-gateway-features.sh

# Deploy Jaeger
kubectl apply -f ../tracing/jaeger.yaml

# Deploy Prometheus ServiceMonitor
kubectl apply -f ../prometheus/kagent-servicemonitor.yaml
```

### 3. Deploy Agents

```bash
# Simple agent
kubectl apply -f 01-first-agent/sample-agent.yaml

# K8s ops agent
kubectl apply -f 02-k8s-ops-agent/k8s-ops-agent.yaml

# Multi-tool agent
cd 03-multi-tool-agent
./deploy.sh

# Financial services multi-agent
cd 04-multi-agents/financial-services
./deploy.sh
```

### 4. Access UIs

```bash
# Kagent UI
kubectl port-forward -n kagent svc/kagent-ui 8080:8080

# Langfuse (LLM tracing & costs)
kubectl port-forward -n langfuse svc/langfuse 3000:3000

# Jaeger (distributed tracing)
kubectl port-forward -n jaeger svc/jaeger 16686:16686

# Grafana (metrics)
kubectl port-forward -n monitoring svc/kube-prom-stack-grafana 3001:80
```

## 📊 Observability in Action

### View LLM Traces in Langfuse
1. Open http://localhost:3000
2. Navigate to **Traces**
3. See every LLM call with:
   - Input/output tokens
   - Cost per request
   - Latency
   - Model used
   - Cache hits (shows $0 cost)

### View Agent Traces in Jaeger
1. Open http://localhost:16686
2. Select service (e.g., `financial-advisor`)
3. See distributed traces showing:
   - Agent-to-agent calls
   - Tool invocations
   - End-to-end latency

### View Metrics in Grafana
1. Open http://localhost:3001 (admin/prom-operator)
2. Explore dashboards for:
   - Kagent controller operations
   - Agent resource usage
   - Request rates and errors

## 🎓 Key Concepts

### Agent-to-Agent (A2A) Communication
Agents can call other agents as tools, enabling:
- **Specialization** - Each agent focuses on specific domain
- **Orchestration** - Coordinator agents delegate to specialists
- **Scalability** - Add new specialists without changing orchestrator

### Model Context Protocol (MCP)
Standardized way for agents to access tools:
- **RemoteMCPServer** - Tools running as separate services
- **Tool Discovery** - Agents discover available tools dynamically
- **Streaming** - Real-time tool responses

### Gateway Pattern
LiteLLM acts as intelligent gateway:
- **Single endpoint** - All agents use same LLM endpoint
- **Centralized control** - Rate limits, caching, fallbacks
- **Observability** - Every request traced to Langfuse

## 🔧 Configuration

### Adjust Rate Limits
Edit `05-observability/langfuse/litellm-advanced-config.yaml`:
```yaml
litellm_settings:
  rpm_limit: 100  # Requests per minute
  tpm_limit: 100000  # Tokens per minute
```

### Configure Caching
```yaml
litellm_settings:
  cache: true
  cache_params:
    ttl: 3600  # Cache duration in seconds
```

### Add Fallback Models
```yaml
router_settings:
  fallbacks:
    - bedrock-claude-3-5-sonnet: [bedrock-claude-3-haiku]
```

## 📈 Monitoring & Alerts

### Key Metrics to Watch
- **LLM Cost** - Track spend per agent in Langfuse
- **Cache Hit Rate** - Target >30% for cost savings
- **Error Rate** - Alert if >5% in Prometheus
- **Latency** - P95 should be <5s for good UX

### Cost Optimization
1. **Enable caching** - Saves on repeated queries
2. **Use fallbacks** - Haiku is 10x cheaper than Sonnet
3. **Set budgets** - Prevent runaway costs
4. **Monitor in Langfuse** - Identify expensive agents

## 🤝 Contributing

This is a reference implementation. Feel free to:
- Add new agent examples
- Enhance observability dashboards
- Improve documentation
- Share your use cases

## 📚 Documentation

- **Langfuse Setup** - `05-observability/langfuse/INSTALL.md`
- **LiteLLM Gateway Features** - `05-observability/langfuse/LITELLM-GATEWAY-FEATURES.md`
- **Multi-Agent System** - `04-multi-agents/financial-services/README.md`

## 🔗 Resources

- [Kagent Documentation](https://kagent.dev)
- [LiteLLM Docs](https://docs.litellm.ai)
- [Langfuse Docs](https://langfuse.com/docs)
- [Amazon Bedrock](https://aws.amazon.com/bedrock)

## 📝 License

This project is provided as-is for educational and reference purposes.

---

**Built with ❤️ using Kagent, Amazon EKS, and Amazon Bedrock**
