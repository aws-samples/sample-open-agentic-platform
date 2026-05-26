# Langfuse Installation Guide

## Overview

Langfuse is deployed in the `langfuse` namespace with:
- PostgreSQL database for trace storage
- Langfuse web UI and API
- Agent integration configs in `kagent` namespace

## Installation Steps

### 1. Deploy Langfuse

```bash
cd gateway/observability/langfuse

# Create namespace and secrets
kubectl apply -f 00-langfuse-secrets.yaml

# Deploy PostgreSQL
kubectl apply -f 01-postgres.yaml

# Wait for postgres to be ready
kubectl wait --for=condition=ready pod -l app=langfuse-postgres -n langfuse --timeout=120s

# Deploy Langfuse
kubectl apply -f 02-langfuse-deployment.yaml

# Wait for Langfuse to be ready
kubectl wait --for=condition=ready pod -l app=langfuse -n langfuse --timeout=180s
```

### 2. Access Langfuse UI

```bash
# Port forward to access UI
kubectl port-forward -n langfuse svc/langfuse 3000:3000

# Open in browser
open http://localhost:3000
```

### 3. Initial Setup

**Login:**
- Email: `admin@kagent.local`
- Password: Get from secret:
  ```bash
  kubectl get secret langfuse-secrets -n langfuse -o jsonpath='{.data.LANGFUSE_INIT_USER_PASSWORD}' | base64 -d
  ```

**Create/View Project:**
1. Navigate to Settings → Projects
2. Project "kagent-agents" should be auto-created
3. Go to Settings → API Keys

**Copy API Keys:**
- Public Key: `pk-lf-...`
- Secret Key: `sk-lf-...`

### 4. Configure Agent Integration

```bash
# Update agent keys with your Langfuse keys
kubectl edit secret langfuse-agent-keys -n kagent

# Replace placeholders:
# LANGFUSE_PUBLIC_KEY: pk-lf-your-actual-key
# LANGFUSE_SECRET_KEY: sk-lf-your-actual-secret
```

### 5. Deploy Agent Integration

```bash
# Apply agent integration config
kubectl apply -f 03-agent-integration.yaml

# Restart agents to pick up Langfuse config
kubectl rollout restart deployment -n kagent smart-assistant
kubectl rollout restart deployment -n kagent financial-advisor
kubectl rollout restart deployment -n kagent portfolio-analyst
kubectl rollout restart deployment -n kagent risk-assessment
kubectl rollout restart deployment -n kagent market-data
```

### 6. Setup Grafana Integration (Optional)

```bash
# Add Langfuse as Grafana datasource
kubectl apply -f ../grafana/grafana-dashboards.yaml

# Restart Grafana to pick up new datasource
kubectl rollout restart deployment -n monitoring kube-prom-stack-grafana
```

## Verification

### Check Langfuse Health

```bash
# Check pods
kubectl get pods -n langfuse

# Check logs
kubectl logs -n langfuse -l app=langfuse --tail=50

# Test API
kubectl run test-langfuse --rm -i --restart=Never --image=curlimages/curl -- \
  curl -s http://langfuse.langfuse.svc.cluster.local:3000/api/public/health
```

### Verify Agent Integration

```bash
# Check agent config
kubectl get configmap langfuse-agent-config -n kagent -o yaml

# Check agent has keys
kubectl get secret langfuse-agent-keys -n kagent

# Test agent trace (make a request to an agent and check Langfuse UI)
```

## Access Grafana

```bash
# Get Grafana password
kubectl get secret -n monitoring kube-prom-stack-grafana -o jsonpath='{.data.admin-password}' | base64 -d

# Port forward
kubectl port-forward -n monitoring svc/kube-prom-stack-grafana 3001:80

# Open browser
open http://localhost:3001
# Login: admin / <password from above>
```

## What You'll See in Langfuse

### Traces
Every agent interaction creates a trace with:
- Session ID
- Agent name
- LLM calls (prompts, completions, tokens, cost)
- Tool calls (name, inputs, outputs, duration)
- Agent-to-agent calls (for A2A patterns)
- Total cost and duration

### Example Trace Structure
```
Session: "Portfolio Analysis"
├─ Agent: financial-advisor
│  ├─ LLM: "Understand request" (tokens: 1234, cost: $0.012)
│  ├─ Agent Call: portfolio-analyst
│  │  ├─ LLM: "Analyze portfolio" (tokens: 567, cost: $0.006)
│  │  ├─ Tool: calculate_portfolio_value
│  │  └─ Tool: get_stock_price
│  ├─ Agent Call: risk-assessment
│  │  ├─ LLM: "Calculate risk" (tokens: 345, cost: $0.003)
│  │  └─ Tool: calculate_risk_score
│  └─ LLM: "Synthesize response" (tokens: 890, cost: $0.009)
Total: $0.030, 3.2s
```

## What You'll See in Grafana

### Prometheus Metrics (Already Available)
- Request rates per agent
- Latency percentiles
- Error rates
- Resource utilization

### Langfuse Metrics (After Integration)
- Cost per agent
- Token usage trends
- Tool call frequencies
- A2A call patterns

### Combined Dashboards
- Agent Overview: Requests, latency, errors
- Cost Analysis: Spend by agent, model, time
- Tool Usage: Call frequency, latency distribution
- A2A Patterns: Call graph, collaboration metrics

## Troubleshooting

### Langfuse Not Starting
```bash
# Check postgres is ready
kubectl get pods -n langfuse -l app=langfuse-postgres

# Check Langfuse logs
kubectl logs -n langfuse -l app=langfuse --tail=100

# Check database connection
kubectl exec -n langfuse -it deployment/langfuse-postgres -- psql -U langfuse -d langfuse -c "SELECT 1"
```

### Agents Not Sending Traces
```bash
# Verify config is mounted
kubectl describe pod -n kagent <agent-pod> | grep -A 5 "Environment"

# Check agent logs for Langfuse errors
kubectl logs -n kagent <agent-pod> | grep -i langfuse

# Verify keys are correct
kubectl get secret langfuse-agent-keys -n kagent -o yaml
```

### Grafana Not Showing Langfuse Data
```bash
# Check datasource config
kubectl get configmap grafana-langfuse-datasource -n monitoring -o yaml

# Test connection from Grafana pod
kubectl exec -n monitoring -it deployment/kube-prom-stack-grafana -- \
  nc -zv langfuse-postgres.langfuse.svc.cluster.local 5432
```

## Cost Estimates

### Langfuse Resources
- PostgreSQL: ~0.5 CPU, 1GB RAM, 10GB storage
- Langfuse: ~1 CPU, 2GB RAM (2 replicas)
- Total: ~2 CPU, 4GB RAM, 10GB storage

### Data Retention
Default: Unlimited (stored in PostgreSQL)

**Recommended cleanup policy:**
```sql
-- Delete traces older than 90 days
DELETE FROM traces WHERE timestamp < NOW() - INTERVAL '90 days';
```

Add as CronJob if needed.

## Security Notes

1. **Change default passwords** in `00-langfuse-secrets.yaml`
2. **Generate secure secrets**:
   ```bash
   openssl rand -base64 32  # For NEXTAUTH_SECRET
   openssl rand -base64 32  # For SALT
   ```
3. **Restrict access**: Langfuse UI contains sensitive data
4. **Use RBAC**: Limit who can access langfuse namespace
5. **Enable TLS**: For production, add ingress with TLS

## Next Steps

1. ✅ Deploy Langfuse
2. ✅ Configure agent integration
3. ✅ Setup Grafana dashboards
4. Test with agent requests
5. Analyze traces and costs
6. Optimize expensive agents
7. Set up alerts for cost thresholds
