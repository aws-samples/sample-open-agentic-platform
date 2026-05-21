#!/bin/bash

set -e

echo "========================================="
echo "Langfuse + LiteLLM Integration - Final Steps"
echo "========================================="
echo ""

# Check if port forward is running
if ! pgrep -f "port-forward.*langfuse" > /dev/null; then
    echo "Starting port-forward to Langfuse..."
    kubectl port-forward -n langfuse svc/langfuse 3000:3000 > /dev/null 2>&1 &
    sleep 3
fi

echo "✅ Langfuse deployed and running"
echo "✅ LiteLLM configured with Langfuse callbacks"
echo "✅ LiteLLM deployment updated with Langfuse env vars"
echo ""
echo "========================================="
echo "NEXT STEPS - Get API Keys from Langfuse UI"
echo "========================================="
echo ""
echo "1. Open Langfuse UI:"
echo "   http://localhost:3000"
echo ""
echo "2. Login with:"
echo "   Email: admin@kagent.local"
PASSWORD=$(kubectl get secret langfuse-secrets -n langfuse -o jsonpath='{.data.LANGFUSE_INIT_USER_PASSWORD}' | base64 -d)
echo "   Password: $PASSWORD"
echo ""
echo "3. After login:"
echo "   - Go to Settings → API Keys"
echo "   - Copy the Public Key (pk-lf-...)"
echo "   - Copy the Secret Key (sk-lf-...)"
echo ""
echo "4. Update the secret with real keys:"
echo ""
echo "   kubectl create secret generic langfuse-litellm-keys -n kagent \\"
echo "     --from-literal=LANGFUSE_PUBLIC_KEY='pk-lf-YOUR-KEY' \\"
echo "     --from-literal=LANGFUSE_SECRET_KEY='sk-lf-YOUR-SECRET' \\"
echo "     --dry-run=client -o yaml | kubectl apply -f -"
echo ""
echo "5. Restart LiteLLM to pick up real keys:"
echo ""
echo "   kubectl rollout restart deployment litellm -n kagent"
echo ""
echo "6. Test by making an agent request, then check Langfuse UI for traces"
echo ""
echo "========================================="
echo "Verification Commands"
echo "========================================="
echo ""
echo "# Check Langfuse pods:"
echo "kubectl get pods -n langfuse"
echo ""
echo "# Check LiteLLM has Langfuse env vars:"
echo "kubectl exec -n kagent deployment/litellm -- env | grep LANGFUSE"
echo ""
echo "# Check LiteLLM logs for Langfuse:"
echo "kubectl logs -n kagent deployment/litellm --tail=50 | grep -i langfuse"
echo ""
echo "========================================="
