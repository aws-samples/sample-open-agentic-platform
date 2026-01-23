# LiteLLM + Langfuse Integration

## Overview

LiteLLM has built-in Langfuse support. All LLM requests through LiteLLM will automatically send traces to Langfuse.

## Setup Steps

### 1. Deploy Langfuse (if not already done)

```bash
cd gateway/observability/langfuse
kubectl apply -f 00-langfuse-secrets.yaml
kubectl apply -f 01-postgres.yaml
kubectl apply -f 02-langfuse-deployment.yaml
```

### 2. Get Langfuse API Keys

```bash
# Port forward to Langfuse UI
kubectl port-forward -n langfuse svc/langfuse 3000:3000

# Open browser: http://localhost:3000
# Login with admin@kagent.local / <password from secret>
# Go to Settings → API Keys
# Copy: Public Key (pk-lf-...) and Secret Key (sk-lf-...)
```

### 3. Update LiteLLM with Langfuse Keys

```bash
# Update the secret with your actual keys
kubectl create secret generic langfuse-litellm-keys -n kagent \
  --from-literal=LANGFUSE_PUBLIC_KEY='pk-lf-your-key' \
  --from-literal=LANGFUSE_SECRET_KEY='sk-lf-your-secret' \
  --dry-run=client -o yaml | kubectl apply -f -
```

### 4. Update LiteLLM ConfigMap

```bash
# Apply the new config with Langfuse callbacks
kubectl apply -f litellm-langfuse-config.yaml
```

### 5. Patch LiteLLM Deployment

```bash
# Add Langfuse env vars to LiteLLM
kubectl patch deployment litellm -n kagent --type='json' -p='[
  {
    "op": "add",
    "path": "/spec/template/spec/containers/0/env/-",
    "value": {
      "name": "LANGFUSE_HOST",
      "value": "http://langfuse.langfuse.svc.cluster.local:3000"
    }
  },
  {
    "op": "add",
    "path": "/spec/template/spec/containers/0/env/-",
    "value": {
      "name": "LANGFUSE_PUBLIC_KEY",
      "valueFrom": {
        "secretKeyRef": {
          "name": "langfuse-litellm-keys",
          "key": "LANGFUSE_PUBLIC_KEY"
        }
      }
    }
  },
  {
    "op": "add",
    "path": "/spec/template/spec/containers/0/env/-",
    "value": {
      "name": "LANGFUSE_SECRET_KEY",
      "valueFrom": {
        "secretKeyRef": {
          "name": "langfuse-litellm-keys",
          "key": "LANGFUSE_SECRET_KEY"
        }
      }
    }
  }
]'

# Restart LiteLLM to pick up changes
kubectl rollout restart deployment litellm -n kagent
```

### 6. Verify Integration

```bash
# Check LiteLLM logs for Langfuse connection
kubectl logs -n kagent deployment/litellm --tail=50 | grep -i langfuse

# Make a test request through an agent
# Then check Langfuse UI for traces
```

## What Gets Traced

Every LLM request through LiteLLM will create a Langfuse trace with:

- **Request Details**:
  - Model used (e.g., bedrock-claude-3-5-sonnet)
  - Prompt/messages
  - Parameters (temperature, max_tokens, etc.)
  
- **Response Details**:
  - Completion text
  - Token counts (input/output)
  - Latency
  - Cost (calculated by LiteLLM)

- **Metadata**:
  - Agent name (if passed in metadata)
  - User ID
  - Session ID
  - Custom tags

## Trace Structure in Langfuse

```
Session: "User Request"
├─ Generation: bedrock-claude-3-5-sonnet
│  ├─ Input: "You are a financial advisor..."
│  ├─ Output: "Based on your portfolio..."
│  ├─ Tokens: 1,234 input + 567 output
│  ├─ Latency: 2.3s
│  └─ Cost: $0.012
```

## Cost Tracking

LiteLLM automatically calculates costs based on:
- Model pricing (Bedrock pricing for Claude)
- Token counts
- Sends to Langfuse for aggregation

View in Langfuse UI:
- Cost per agent
- Cost per model
- Cost trends over time
- Most expensive requests

## Troubleshooting

### LiteLLM not sending traces

```bash
# Check env vars are set
kubectl exec -n kagent deployment/litellm -- env | grep LANGFUSE

# Check LiteLLM can reach Langfuse
kubectl exec -n kagent deployment/litellm -- curl -s http://langfuse.langfuse.svc.cluster.local:3000/api/public/health

# Check for errors in logs
kubectl logs -n kagent deployment/litellm --tail=100 | grep -i error
```

### Traces not appearing in Langfuse

```bash
# Verify Langfuse is running
kubectl get pods -n langfuse

# Check Langfuse logs
kubectl logs -n langfuse deployment/langfuse --tail=50

# Verify API keys are correct
kubectl get secret langfuse-litellm-keys -n kagent -o yaml
```

### Invalid API keys

```bash
# Re-create secret with correct keys
kubectl delete secret langfuse-litellm-keys -n kagent
kubectl create secret generic langfuse-litellm-keys -n kagent \
  --from-literal=LANGFUSE_PUBLIC_KEY='pk-lf-correct-key' \
  --from-literal=LANGFUSE_SECRET_KEY='sk-lf-correct-secret'

# Restart LiteLLM
kubectl rollout restart deployment litellm -n kagent
```

## Testing

```bash
# Make a test request through LiteLLM
kubectl run test-litellm --rm -i --restart=Never --image=curlimages/curl -- \
  curl -X POST http://litellm.kagent.svc.cluster.local:4000/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "bedrock-claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "Hello"}],
    "metadata": {
      "user_id": "test-user",
      "tags": ["test"]
    }
  }'

# Check Langfuse UI for the trace
# Should appear within 5-10 seconds
```

## Next Steps

1. ✅ Deploy Langfuse
2. ✅ Get API keys from Langfuse UI
3. ✅ Configure LiteLLM with Langfuse
4. Test with agent requests
5. View traces in Langfuse UI
6. Analyze costs and optimize
