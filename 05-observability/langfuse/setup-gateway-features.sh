#!/bin/bash

set -e

echo "========================================="
echo "LiteLLM Gateway Features Setup"
echo "========================================="
echo ""

# Deploy Redis for caching
echo "1. Deploying Redis for caching..."
kubectl apply -f - <<EOF
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

echo "✅ Redis deployed"
echo ""

# Wait for Redis
echo "2. Waiting for Redis to be ready..."
kubectl wait --for=condition=ready pod -l app=redis -n kagent --timeout=60s
echo "✅ Redis ready"
echo ""

# Apply advanced LiteLLM config
echo "3. Applying advanced LiteLLM configuration..."
kubectl apply -f litellm-advanced-config.yaml
echo "✅ Config applied"
echo ""

# Restart LiteLLM
echo "4. Restarting LiteLLM to pick up new config..."
kubectl rollout restart deployment litellm -n kagent
kubectl rollout status deployment litellm -n kagent --timeout=120s
echo "✅ LiteLLM restarted"
echo ""

echo "========================================="
echo "Setup Complete!"
echo "========================================="
echo ""
echo "Features Enabled:"
echo "  ✅ Rate Limiting (100 RPM, 100K TPM)"
echo "  ✅ Load Balancing (simple-shuffle)"
echo "  ✅ Fallbacks (Sonnet → Haiku)"
echo "  ✅ Caching (Redis, 1 hour TTL)"
echo "  ✅ Cost Tracking (Langfuse)"
echo ""
echo "Next Steps:"
echo "  1. Test caching:"
echo "     See LITELLM-GATEWAY-FEATURES.md"
echo ""
echo "  2. View metrics in Langfuse:"
echo "     http://localhost:3000"
echo ""
echo "  3. Monitor in logs:"
echo "     kubectl logs -n kagent deployment/litellm -f"
echo ""
echo "========================================="
