# LiteLLM Advanced Gateway Features

## Overview

LiteLLM provides enterprise gateway features for AI agents. This guide shows how to configure and monitor them.

## Prerequisites

### 1. Deploy Redis (for caching)

```bash
cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  namespace: kagent
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          ports:
            - containerPort: 6379
          resources:
            requests:
              memory: "256Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "500m"
---
apiVersion: v1
kind: Service
metadata:
  name: redis
  namespace: kagent
spec:
  selector:
    app: redis
  ports:
    - port: 6379
      targetPort: 6379
EOF
```

### 2. Deploy PostgreSQL (for virtual keys - optional)

```bash
cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: litellm-postgres
  namespace: kagent
spec:
  replicas: 1
  selector:
    matchLabels:
      app: litellm-postgres
  template:
    metadata:
      labels:
        app: litellm-postgres
    spec:
      containers:
        - name: postgres
          image: postgres:15-alpine
          env:
            - name: POSTGRES_DB
              value: litellm
            - name: POSTGRES_USER
              value: litellm
            - name: POSTGRES_PASSWORD
              value: litellm_password
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          ports:
            - containerPort: 5432
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
      volumes:
        - name: data
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: kagent
spec:
  selector:
    app: litellm-postgres
  ports:
    - port: 5432
      targetPort: 5432
EOF
```

## Feature Configuration

### 1. Rate Limiting

**Per-Agent Rate Limits:**

```yaml
# In litellm-config ConfigMap
litellm_settings:
  # Global limits
  rpm_limit: 100  # Requests per minute
  tpm_limit: 100000  # Tokens per minute
  
  # Per-user limits (requires virtual keys)
  user_api_key_cache_ttl: 60
```

**Test Rate Limiting:**
```bash
# Make 101 requests quickly
for i in {1..101}; do
  curl -X POST http://litellm.kagent.svc.cluster.local:4000/chat/completions \
    -H "Content-Type: application/json" \
    -d '{"model": "bedrock-claude-3-5-sonnet", "messages": [{"role": "user", "content": "Hi"}]}'
done
```

**View in Langfuse:**
- Go to Traces → Filter by status "error"
- Look for "Rate limit exceeded" errors

---

### 2. Load Balancing

**Multiple Model Instances:**

```yaml
model_list:
  # Instance 1
  - model_name: bedrock-claude-3-5-sonnet
    litellm_params:
      model: bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0
      aws_region_name: us-west-2
  
  # Instance 2 (different region for redundancy)
  - model_name: bedrock-claude-3-5-sonnet
    litellm_params:
      model: bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0
      aws_region_name: us-east-1

router_settings:
  routing_strategy: simple-shuffle  # Round-robin across instances
```

**Routing Strategies:**
- `simple-shuffle`: Random selection
- `least-busy`: Route to least loaded instance
- `usage-based-routing`: Route based on cost/performance

**View in Langfuse:**
- Traces will show which region/instance was used
- Compare latency across instances

---

### 3. Fallbacks

**Primary → Backup Model:**

```yaml
model_list:
  - model_name: bedrock-claude-3-5-sonnet  # Primary (expensive)
    litellm_params:
      model: bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0
  
  - model_name: bedrock-claude-3-haiku  # Fallback (cheaper)
    litellm_params:
      model: bedrock/anthropic.claude-3-haiku-20240307-v1:0

router_settings:
  fallbacks:
    - bedrock-claude-3-5-sonnet: [bedrock-claude-3-haiku]
  
  allowed_fails: 3  # Try primary 3 times before fallback
  num_retries: 2
```

**Test Fallback:**
```bash
# Simulate primary failure by using invalid credentials
# Fallback will kick in automatically
```

**View in Langfuse:**
- Traces show which model was actually used
- Filter by model to see fallback usage
- Compare costs: primary vs fallback

---

### 4. Caching

**Redis-based Response Caching:**

```yaml
litellm_settings:
  cache: true
  cache_params:
    type: redis
    host: redis.kagent.svc.cluster.local
    port: 6379
    ttl: 3600  # Cache for 1 hour
    
    # Cache key includes these params
    supported_call_types: ["completion", "acompletion", "embedding"]
```

**How It Works:**
- Identical requests return cached responses
- Saves cost and latency
- Cache key = model + messages + params

**Test Caching:**
```bash
# First request (cache miss)
time curl -X POST http://litellm.kagent.svc.cluster.local:4000/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "bedrock-claude-3-5-sonnet", "messages": [{"role": "user", "content": "What is 2+2?"}]}'

# Second identical request (cache hit - much faster)
time curl -X POST http://litellm.kagent.svc.cluster.local:4000/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "bedrock-claude-3-5-sonnet", "messages": [{"role": "user", "content": "What is 2+2?"}]}'
```

**View in Langfuse:**
- Cached responses show $0 cost
- Latency is near-zero for cache hits
- Filter by cost=0 to see cached requests

---

### 5. Virtual Keys (Access Control)

**Enable Virtual Keys:**

```yaml
general_settings:
  master_key: "sk-master-1234"  # Admin key
  database_url: "postgresql://litellm:litellm_password@postgres.kagent.svc.cluster.local:5432/litellm"
  store_model_in_db: true
```

**Create Virtual Keys:**

```bash
# Create key for financial-advisor agent
curl -X POST http://litellm.kagent.svc.cluster.local:4000/key/generate \
  -H "Authorization: Bearer sk-master-1234" \
  -H "Content-Type: application/json" \
  -d '{
    "key_alias": "financial-advisor-key",
    "models": ["bedrock-claude-3-5-sonnet"],
    "max_budget": 50,
    "budget_duration": "30d",
    "metadata": {
      "agent": "financial-advisor",
      "team": "finance"
    }
  }'

# Response: {"key": "sk-proj-abc123..."}
```

**Use Virtual Key:**
```bash
curl -X POST http://litellm.kagent.svc.cluster.local:4000/chat/completions \
  -H "Authorization: Bearer sk-proj-abc123..." \
  -H "Content-Type: application/json" \
  -d '{"model": "bedrock-claude-3-5-sonnet", "messages": [{"role": "user", "content": "Hi"}]}'
```

**View in Langfuse:**
- Traces tagged with key metadata
- Filter by agent/team
- Track spend per key

---

### 6. Budgets (Cost Limits)

**Global Budget:**

```yaml
litellm_settings:
  max_budget: 100  # USD
  budget_duration: 30d
```

**Per-Key Budget:**

```bash
curl -X POST http://litellm.kagent.svc.cluster.local:4000/key/generate \
  -H "Authorization: Bearer sk-master-1234" \
  -d '{
    "key_alias": "test-agent",
    "max_budget": 10,
    "budget_duration": "7d"
  }'
```

**Budget Exceeded:**
- Requests return 429 error
- "Budget exceeded" message

**View in Langfuse:**
- Dashboard → Cost Analysis
- Filter by key/agent
- Set up alerts for budget thresholds

---

## Apply Configuration

### 1. Update LiteLLM Config

```bash
# Apply advanced config
kubectl apply -f gateway/observability/langfuse/litellm-advanced-config.yaml

# Restart LiteLLM
kubectl rollout restart deployment litellm -n kagent
```

### 2. Verify Features

```bash
# Check Redis is running
kubectl get pods -n kagent -l app=redis

# Check LiteLLM logs
kubectl logs -n kagent deployment/litellm --tail=50

# Test caching
kubectl logs -n kagent deployment/litellm | grep -i cache
```

---

## Monitoring in Langfuse

### Dashboard Views

**1. Cost Analysis**
- Go to: Analytics → Cost
- View: Cost per agent, model, time period
- Filter: By key, agent, model

**2. Rate Limit Tracking**
- Go to: Traces → Filter by error
- Look for: "Rate limit exceeded"
- Analyze: Which agents hit limits

**3. Cache Hit Rate**
- Go to: Traces → Filter by cost = 0
- Calculate: Cache hits / total requests
- Optimize: Increase TTL for high-hit queries

**4. Fallback Usage**
- Go to: Traces → Group by model
- Compare: Primary vs fallback usage
- Analyze: When fallbacks trigger

**5. Budget Monitoring**
- Go to: Analytics → Cost
- Set alerts: When approaching budget
- Track: Spend per key/agent

### Custom Queries

**Cache Hit Rate:**
```sql
SELECT 
  COUNT(CASE WHEN cost = 0 THEN 1 END) * 100.0 / COUNT(*) as cache_hit_rate
FROM traces
WHERE timestamp > NOW() - INTERVAL '24 hours'
```

**Cost by Agent:**
```sql
SELECT 
  metadata->>'agent' as agent,
  SUM(cost) as total_cost,
  COUNT(*) as requests
FROM traces
WHERE timestamp > NOW() - INTERVAL '7 days'
GROUP BY agent
ORDER BY total_cost DESC
```

**Fallback Rate:**
```sql
SELECT 
  model,
  COUNT(*) as usage_count
FROM traces
WHERE timestamp > NOW() - INTERVAL '24 hours'
GROUP BY model
```

---

## Best Practices

### 1. Rate Limiting
- Set per-agent limits based on usage patterns
- Monitor for limit hits in Langfuse
- Adjust limits as needed

### 2. Caching
- Cache common queries (weather, calculations)
- Don't cache personalized responses
- Monitor cache hit rate (target >30%)

### 3. Fallbacks
- Use cheaper models as fallbacks
- Test fallback quality
- Monitor fallback usage

### 4. Budgets
- Set conservative budgets initially
- Monitor actual spend
- Adjust based on usage

### 5. Virtual Keys
- One key per agent
- Tag with metadata (agent, team)
- Rotate keys regularly

---

## Troubleshooting

### Rate Limit Not Working
```bash
# Check config
kubectl get configmap litellm-config -n kagent -o yaml | grep rpm_limit

# Check logs
kubectl logs -n kagent deployment/litellm | grep -i "rate limit"
```

### Cache Not Working
```bash
# Check Redis
kubectl exec -n kagent deployment/redis -- redis-cli ping

# Check cache config
kubectl logs -n kagent deployment/litellm | grep -i cache
```

### Virtual Keys Not Working
```bash
# Check PostgreSQL
kubectl exec -n kagent deployment/litellm-postgres -- psql -U litellm -d litellm -c "SELECT * FROM litellm_verificationtoken;"

# Check database connection
kubectl logs -n kagent deployment/litellm | grep -i database
```

---

## Summary

| Feature | Config Location | View in Langfuse |
|---------|----------------|------------------|
| Rate Limiting | `rpm_limit`, `tpm_limit` | Traces → Filter errors |
| Load Balancing | `routing_strategy` | Traces → Group by model |
| Fallbacks | `fallbacks` | Traces → Compare models |
| Caching | `cache: true` | Traces → Filter cost=0 |
| Virtual Keys | `master_key`, database | Analytics → By key |
| Budgets | `max_budget` | Analytics → Cost tracking |

All metrics automatically flow to Langfuse via the callbacks integration!
