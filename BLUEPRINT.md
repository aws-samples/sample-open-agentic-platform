# Agent Platform on EKS - Implementation Blueprint

## Overview
This blueprint provides a step-by-step approach to building a production-ready AI agent platform on Amazon EKS with comprehensive observability.

---

## Phase 1: Foundation Setup

### Step 1.1: EKS Cluster Preparation
**Objective:** Prepare EKS cluster with required add-ons

**Actions:**
1. Create/verify EKS cluster (1.28+)
2. Install kube-prometheus-stack for monitoring
   ```bash
   helm install kube-prom-stack prometheus-community/kube-prometheus-stack -n monitoring --create-namespace
   ```
3. Configure AWS credentials for Bedrock access
4. Set up IAM roles for pod identity

**Validation:**
- `kubectl get nodes` shows all nodes ready
- Prometheus/Grafana pods running in `monitoring` namespace
- AWS credentials accessible from pods

---

### Step 1.2: Install Kagent Operator
**Objective:** Deploy Kagent CRDs and controller

**Actions:**
1. Install Kagent CRDs
   ```bash
   helm install kagent-crds oci://public.ecr.aws/kagent-dev/kagent-crds --version 0.7.9 -n kagent --create-namespace
   ```
2. Create Bedrock API key secret
   ```bash
   kubectl apply -f 00-initial-setup/bedrock-key.yaml
   ```
3. Install Kagent operator with values
   ```bash
   helm install kagent oci://public.ecr.aws/kagent-dev/kagent --version 0.7.9 -n kagent -f 00-initial-setup/values.yaml
   ```

**Validation:**
- CRDs installed: `kubectl get crd | grep kagent`
- Controller running: `kubectl get pods -n kagent`
- No errors in controller logs

---

### Step 1.3: Deploy LiteLLM Gateway
**Objective:** Set up intelligent LLM gateway

**Actions:**
1. Deploy LiteLLM configuration
   ```bash
   kubectl apply -f 00-initial-setup/litellm-config.yaml
   ```
2. Deploy LiteLLM service
   ```bash
   kubectl apply -f 00-initial-setup/litellm-deploy.yaml
   ```
3. Create ModelConfig for Bedrock
   ```bash
   kubectl apply -f 00-initial-setup/bedrock-litellm.yaml
   ```

**Validation:**
- LiteLLM pod running: `kubectl get pods -n kagent -l app=litellm`
- Health check passes: `curl http://litellm-service:4000/health`
- Models available: `curl http://litellm-service:4000/models`

---

## Phase 2: Observability Stack

### Step 2.1: Deploy Langfuse (LLM Tracing)
**Objective:** Set up LLM-specific observability

**Actions:**
1. Deploy PostgreSQL for Langfuse
   ```bash
   cd 05-observability/langfuse
   kubectl apply -f 00-langfuse-secrets.yaml
   kubectl apply -f 01-postgres.yaml
   ```
2. Wait for PostgreSQL ready
   ```bash
   kubectl wait --for=condition=ready pod -l app=langfuse-postgres -n langfuse --timeout=120s
   ```
3. Deploy Langfuse application
   ```bash
   kubectl apply -f 02-langfuse-deployment.yaml
   ```
4. Access UI and create API keys
   ```bash
   kubectl port-forward -n langfuse svc/langfuse 3000:3000
   # Open http://localhost:3000
   # Login: admin@kagent.local / changeme-admin-password
   # Go to Settings → API Keys → Copy keys
   ```
5. Configure LiteLLM integration
   ```bash
   kubectl create secret generic langfuse-litellm-keys -n kagent \
     --from-literal=LANGFUSE_PUBLIC_KEY='pk-lf-...' \
     --from-literal=LANGFUSE_SECRET_KEY='sk-lf-...'
   ```

**Validation:**
- Langfuse UI accessible
- API keys created
- LiteLLM sending traces to Langfuse

**Design Decision:** Langfuse v2 (PostgreSQL-only) chosen over v3 (requires ClickHouse) for simpler deployment.

---

### Step 2.2: Configure LiteLLM Gateway Features
**Objective:** Enable rate limiting, caching, fallbacks

**Actions:**
1. Deploy Redis for caching
   ```bash
   ./setup-gateway-features.sh
   ```
2. Update LiteLLM config with gateway features
   ```bash
   kubectl apply -f litellm-advanced-config.yaml
   ```
3. Restart LiteLLM to apply changes
   ```bash
   kubectl rollout restart deployment litellm -n kagent
   ```

**Configuration:**
- **Rate Limiting:** 100 RPM, 100K TPM globally
- **Caching:** Redis with 1-hour TTL
- **Fallbacks:** Claude Sonnet → Claude Haiku
- **Load Balancing:** Simple shuffle strategy

**Validation:**
- Redis pod running
- Cache hits show $0 cost in Langfuse
- Rate limit errors after 100 requests/min

---

### Step 2.3: Deploy Jaeger (Distributed Tracing)
**Objective:** Trace agent-to-agent interactions

**Actions:**
1. Deploy Jaeger all-in-one
   ```bash
   kubectl apply -f 05-observability/tracing/jaeger.yaml
   ```
2. Verify OTEL configuration in agents
   ```bash
   kubectl get deployment -n kagent -o yaml | grep OTEL_TRACING_ENABLED
   ```

**Validation:**
- Jaeger UI accessible: `kubectl port-forward -n jaeger svc/jaeger 16686:16686`
- Agents sending traces
- A2A calls visible in trace view

**Design Decision:** All-in-one Jaeger deployment for simplicity; use Jaeger Operator for production.

---

### Step 2.4: Configure Prometheus Monitoring
**Objective:** Collect infrastructure and controller metrics

**Actions:**
1. Deploy ServiceMonitor for Kagent controller
   ```bash
   kubectl apply -f 05-observability/prometheus/kagent-servicemonitor.yaml
   ```
2. Verify Prometheus scraping
   ```bash
   kubectl port-forward -n monitoring prometheus-kube-prom-stack-kube-prome-prometheus-0 9090:9090
   # Check targets: http://localhost:9090/targets
   ```

**Validation:**
- ServiceMonitor created
- Prometheus scraping Kagent controller
- Metrics visible in Grafana

**Note:** Kagent controller metrics require authentication; ServiceMonitor configured with bearer token.

---

## Phase 3: Agent Deployment

### Step 3.1: Deploy Simple Agent
**Objective:** Validate basic agent functionality

**Actions:**
1. Deploy sample agent
   ```bash
   kubectl apply -f 01-first-agent/sample-agent.yaml
   ```
2. Test agent
   ```bash
   kubectl run test --rm -i --restart=Never --image=curlimages/curl -n kagent -- \
     curl -X POST http://sample-agent:8080/chat \
     -H "Content-Type: application/json" \
     -d '{"message": "Hello"}'
   ```

**Validation:**
- Agent pod running
- Response received
- Trace visible in Langfuse

---

### Step 3.2: Deploy K8s Operations Agent
**Objective:** Enable Kubernetes-aware agent

**Actions:**
1. Deploy K8s ops agent
   ```bash
   kubectl apply -f 02-k8s-ops-agent/k8s-ops-agent.yaml
   ```
2. Test K8s queries
   ```bash
   # Ask: "List all pods in kagent namespace"
   ```

**Validation:**
- Agent can query Kubernetes API
- Returns accurate cluster information

**Design Decision:** Agent uses in-cluster service account with RBAC permissions for K8s API access.

---

### Step 3.3: Deploy Multi-Tool Agent
**Objective:** Demonstrate MCP tool integration

**Actions:**
1. Build and push tools server image
   ```bash
   cd 03-multi-tool-agent
   podman build --platform linux/amd64 -t <ECR_URI>/multi-tool-agent:latest .
   podman push <ECR_URI>/multi-tool-agent:latest
   ```
2. Deploy tools server
   ```bash
   kubectl apply -f tools-server-deployment.yaml
   ```
3. Deploy RemoteMCPServer CRD
   ```bash
   kubectl apply -f kagent-remotemcpserver.yaml
   ```
4. Deploy agent
   ```bash
   kubectl apply -f smart-assistant-agent.yaml
   ```

**Validation:**
- Tools server running
- Agent can call calculator, web_search, weather, datetime tools
- Tool calls visible in logs

**Design Decision:** MCP STREAMABLE_HTTP protocol for real-time tool responses.

---

### Step 3.4: Deploy Multi-Agent System (Financial Services)
**Objective:** Demonstrate agent-to-agent (A2A) collaboration

**Actions:**
1. Build and push financial tools server
   ```bash
   cd 04-multi-agents/financial-services
   podman build --platform linux/amd64 -t <ECR_URI>/financial-tools:latest .
   podman push <ECR_URI>/financial-tools:latest
   ```
2. Deploy all components
   ```bash
   ./deploy.sh
   ```

**Components Deployed:**
- **Tools Server:** Financial calculation tools
- **RemoteMCPServer:** MCP server definition
- **Specialist Agents:**
  - Portfolio Analyst
  - Risk Assessment
  - Market Data
- **Orchestrator Agent:**
  - Financial Advisor (coordinates specialists)

**Validation:**
- All agents running
- Financial Advisor can call specialist agents
- A2A calls visible in Jaeger traces
- Complete conversation flow in Langfuse

**Design Decision:** Orchestrator pattern with specialist agents for domain separation and scalability.

---

## Phase 4: Integration & Testing

### Step 4.1: Verify Observability Integration
**Objective:** Ensure all observability components working together

**Test Scenarios:**

1. **LLM Tracing (Langfuse)**
   - Make agent request
   - Verify trace in Langfuse with tokens, cost, latency
   - Check cache hits show $0 cost

2. **Distributed Tracing (Jaeger)**
   - Make A2A request (Financial Advisor)
   - Verify trace shows orchestrator → specialists flow
   - Check latency breakdown

3. **Infrastructure Metrics (Prometheus/Grafana)**
   - Check Kagent controller metrics
   - Verify agent pod resource usage
   - Confirm no errors in reconciliation

**Validation Checklist:**
- [ ] Langfuse shows all LLM calls
- [ ] Jaeger shows A2A traces
- [ ] Prometheus scraping all targets
- [ ] Grafana dashboards populated

---

### Step 4.2: Test Gateway Features
**Objective:** Validate LiteLLM gateway functionality

**Test Scenarios:**

1. **Caching**
   ```bash
   # First request (cache miss)
   curl -X POST http://localhost:4000/chat/completions \
     -H "Content-Type: application/json" \
     -d '{"model": "bedrock-claude-3-5-sonnet", "messages": [{"role": "user", "content": "What is 2+2?"}]}'
   
   # Second identical request (cache hit - $0 cost)
   curl -X POST http://localhost:4000/chat/completions \
     -H "Content-Type: application/json" \
     -d '{"model": "bedrock-claude-3-5-sonnet", "messages": [{"role": "user", "content": "What is 2+2?"}]}'
   ```
   - Verify second request shows $0 cost in Langfuse

2. **Rate Limiting**
   ```bash
   # Send 105 requests quickly
   for i in {1..105}; do
     curl -X POST http://localhost:4000/chat/completions ... &
   done
   ```
   - Verify requests 101-105 return 429 errors

3. **Fallbacks**
   - Simulate primary model failure
   - Verify fallback to Claude Haiku
   - Check Langfuse shows different model used

**Validation Checklist:**
- [ ] Cache hits reduce costs
- [ ] Rate limits enforced
- [ ] Fallbacks work on failures

---

### Step 4.3: Performance Testing
**Objective:** Validate system under load

**Test Scenarios:**

1. **Concurrent Requests**
   - Send 50 concurrent requests to different agents
   - Monitor latency in Jaeger
   - Check error rates in Prometheus

2. **A2A Load Test**
   - Send 20 concurrent requests to Financial Advisor
   - Verify specialist agents handle load
   - Check for bottlenecks in traces

3. **Resource Usage**
   - Monitor CPU/memory during load
   - Verify no OOM kills
   - Check autoscaling if configured

**Success Criteria:**
- P95 latency < 5s
- Error rate < 1%
- No resource exhaustion

---

## Phase 5: Production Readiness

### Step 5.1: Security Hardening
**Actions:**

1. **Secrets Management**
   - Rotate Langfuse admin password
   - Use AWS Secrets Manager for Bedrock keys
   - Enable secret encryption at rest

2. **Network Policies**
   - Restrict agent-to-agent communication
   - Limit external access to observability UIs
   - Enable mTLS for service mesh (optional)

3. **RBAC**
   - Limit agent service account permissions
   - Restrict access to Kagent CRDs
   - Enable audit logging

---

### Step 5.2: High Availability
**Actions:**

1. **Multi-Replica Deployments**
   - Scale LiteLLM to 2+ replicas
   - Scale Langfuse to 2+ replicas
   - Use PodDisruptionBudgets

2. **Database HA**
   - Use RDS for Langfuse PostgreSQL
   - Enable automated backups
   - Configure read replicas

3. **Redis HA**
   - Deploy Redis Sentinel or Cluster
   - Enable persistence
   - Configure backup strategy

---

### Step 5.3: Monitoring & Alerting
**Actions:**

1. **Configure Alerts**
   - High error rate (>5%)
   - High latency (P95 >5s)
   - Cost threshold exceeded
   - Pod restarts

2. **Dashboards**
   - Agent overview dashboard
   - Cost tracking dashboard
   - A2A communication dashboard
   - Infrastructure health dashboard

3. **Log Aggregation**
   - Configure CloudWatch Logs
   - Set up log retention policies
   - Create log-based metrics

---

### Step 5.4: Cost Optimization
**Actions:**

1. **Enable Caching**
   - Increase cache TTL for stable queries
   - Monitor cache hit rate (target >30%)

2. **Use Fallbacks**
   - Configure Haiku as fallback (10x cheaper)
   - Set appropriate failure thresholds

3. **Set Budgets**
   - Configure per-agent budgets
   - Alert on budget thresholds
   - Implement rate limiting per agent

4. **Right-Size Resources**
   - Analyze actual resource usage
   - Adjust CPU/memory requests
   - Enable cluster autoscaling

---

## Design Decisions Summary

### Architecture Choices

1. **LiteLLM as Gateway**
   - **Why:** Centralized control, built-in observability, multi-model support
   - **Alternative:** Direct Bedrock calls (no caching, rate limiting, or centralized observability)

2. **Langfuse for LLM Tracing**
   - **Why:** Purpose-built for LLM observability, cost tracking, prompt management
   - **Alternative:** Generic APM tools (lack LLM-specific features)

3. **Jaeger for Distributed Tracing**
   - **Why:** CNCF standard, excellent A2A visualization, OpenTelemetry compatible
   - **Alternative:** AWS X-Ray (vendor lock-in, less flexible)

4. **MCP for Tool Integration**
   - **Why:** Standardized protocol, tool discovery, streaming support
   - **Alternative:** Custom tool APIs (no standardization, more maintenance)

5. **A2A Orchestrator Pattern**
   - **Why:** Domain separation, scalability, reusable specialists
   - **Alternative:** Monolithic agent (harder to maintain, less flexible)

### Technology Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Container Orchestration | Amazon EKS | Managed Kubernetes, AWS integration |
| Agent Framework | Kagent | Kubernetes-native, CRD-based, declarative |
| LLM Gateway | LiteLLM | Multi-model support, observability, caching |
| LLM Provider | Amazon Bedrock | Managed service, Claude 3.5 Sonnet |
| LLM Tracing | Langfuse | Purpose-built for LLMs, cost tracking |
| Distributed Tracing | Jaeger | CNCF standard, OpenTelemetry |
| Metrics | Prometheus | Industry standard, Kubernetes-native |
| Visualization | Grafana | Rich dashboards, multi-datasource |
| Caching | Redis | Fast, reliable, widely supported |
| Tool Protocol | MCP | Standardized, streaming, discoverable |

---

## Troubleshooting Guide

### Common Issues

1. **Langfuse Not Receiving Traces**
   - Check LiteLLM has correct API keys
   - Verify Langfuse service accessible from LiteLLM pod
   - Check LiteLLM logs for Langfuse errors

2. **Agent Can't Reach LiteLLM**
   - Verify ModelConfig has correct baseUrl
   - Check LiteLLM service exists and has endpoints
   - Test connectivity from agent pod

3. **Jaeger Not Showing Traces**
   - Verify OTEL_TRACING_ENABLED=true in agent env
   - Check Jaeger service endpoint correct
   - Verify agents sending to correct port (4317)

4. **High Costs**
   - Enable caching to reduce duplicate requests
   - Use fallback models (Haiku) for non-critical queries
   - Set per-agent budgets
   - Monitor in Langfuse and optimize expensive agents

---

## Next Steps

### Enhancements

1. **Add More Agents**
   - Customer service agent
   - DevOps automation agent
   - Data analysis agent

2. **Advanced Features**
   - Prompt versioning in Langfuse
   - A/B testing different prompts
   - Fine-tuned models for specific tasks

3. **Enterprise Features**
   - Multi-tenancy support
   - Advanced RBAC
   - Compliance logging
   - Disaster recovery

---

## Appendix

### Useful Commands

```bash
# Check all agent pods
kubectl get pods -n kagent -l app.kubernetes.io/part-of=kagent

# View agent logs
kubectl logs -n kagent <agent-pod> --tail=100 -f

# Test LiteLLM
curl http://localhost:4000/models

# Access Langfuse
kubectl port-forward -n langfuse svc/langfuse 3000:3000

# Access Jaeger
kubectl port-forward -n jaeger svc/jaeger 16686:16686

# Access Grafana
kubectl port-forward -n monitoring svc/kube-prom-stack-grafana 3001:80

# Check Prometheus targets
kubectl port-forward -n monitoring prometheus-kube-prom-stack-kube-prome-prometheus-0 9090:9090
```

### Resource Requirements

| Component | CPU | Memory | Storage |
|-----------|-----|--------|---------|
| Kagent Controller | 100m | 256Mi | - |
| LiteLLM | 500m | 1Gi | - |
| Langfuse | 1000m | 2Gi | - |
| Langfuse PostgreSQL | 500m | 1Gi | 10Gi |
| Redis | 100m | 256Mi | 1Gi |
| Jaeger | 500m | 1Gi | 10Gi |
| Agent (typical) | 100m | 256Mi | - |

**Total Cluster:** ~4 CPU, 8Gi RAM, 25Gi storage (minimum)

---

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Maintained By:** Agent Platform Team
