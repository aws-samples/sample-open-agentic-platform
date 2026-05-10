# Agent Platform GitOps Deployment Guide

Deploy the AI agent platform on an EKS cluster using the ArgoCD EKS Capability.

## What Gets Deployed

| Wave | Addon | Source | Namespace |
|------|-------|--------|-----------|
| 2 | kagent-crds | OCI: `ghcr.io/kagent-dev/kagent/helm/kagent-crds:0.7.9` | kagent |
| 3 | kagent (operator + UI) | OCI: `ghcr.io/kagent-dev/kagent/helm/kagent:0.7.9` | kagent |
| 3 | kagent-setup (ModelConfig) | Local chart | kagent |
| 3 | litellm (LLM gateway) | Local chart | kagent |
| 5 | langfuse (LLM tracing + PostgreSQL) | Local chart | langfuse |
| 5 | jaeger (distributed tracing) | Helm: `jaegertracing/jaeger:3.4.1` | jaeger |
| 5 | prometheus-operator-crds | Helm: `prometheus-community/prometheus-operator-crds:28.0.1` | kagent |
| 6 | kagent-monitoring (ServiceMonitor) | Local chart | kagent |
| 7 | gateway-api-crds | Local chart (Job) | agentgateway-system |
| 7 | agentgateway-crds | OCI: `cr.agentgateway.dev/charts/agentgateway-crds:v1.1.0` | agentgateway-system |
| 8 | agentgateway (control plane) | OCI: `cr.agentgateway.dev/charts/agentgateway:v1.1.0` | agentgateway-system |
| 9 | agent-gateway (Gateway + Policies) | Local chart | agent-core-infra |

AgentCore resources (Memory, Browser, Code Interpreter) are provisioned via Crossplane compositions — see the `crossplane-compositions/` directory (Phase 2, coming soon).

## Deployment via appmod-blueprints

When deployed through the [appmod-blueprints](https://github.com/aws-samples/appmod-blueprints) platform, set `agent_platform: true` in `enabled-addons.yaml`. The appmod-blueprints bootstrap chart handles everything — see `gitops/AGENT-PLATFORM.md` in that repo.

## Standalone Deployment

### Prerequisites

- EKS cluster with ArgoCD EKS Capability active
- ArgoCD Capability Role with `AmazonEKSClusterAdminPolicy` on the local cluster
- Local cluster registered in ArgoCD using its EKS ARN
- `kubectl` and `aws` CLI configured
- Crossplane installed with `provider-aws-bedrockagentcore` (for AgentCore resources)

### Pod Identity (EKS Auto Mode)

LiteLLM needs Bedrock access. Create an IAM role with Pod Identity:

```bash
CLUSTER_NAME="<your-cluster>"
REGION="<your-region>"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

aws iam create-role --role-name ${CLUSTER_NAME}-LiteLLMBedrockRole \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "pods.eks.amazonaws.com"},
      "Action": ["sts:AssumeRole", "sts:TagSession"]
    }]
  }'

aws iam put-role-policy --role-name ${CLUSTER_NAME}-LiteLLMBedrockRole --policy-name BedrockInvoke \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": ["arn:aws:bedrock:*::foundation-model/*",
                    "arn:aws:bedrock:*:'${ACCOUNT_ID}':inference-profile/*"]
    }]
  }'

aws eks create-pod-identity-association \
  --cluster-name $CLUSTER_NAME --region $REGION \
  --namespace kagent --service-account litellm \
  --role-arn arn:aws:iam::${ACCOUNT_ID}:role/${CLUSTER_NAME}-LiteLLMBedrockRole
```

### Deploy

The `application-sets` chart generates one ApplicationSet per addon. Deploy it as an ArgoCD Application:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: agent-platform-addons
  namespace: argocd
spec:
  project: default
  sources:
    - ref: values
      repoURL: https://github.com/aws-samples/sample-agent-platform-on-eks.git
      targetRevision: main
    - repoURL: https://github.com/aws-samples/sample-agent-platform-on-eks.git
      path: gitops/addons/charts/application-sets
      targetRevision: main
      helm:
        releaseName: agent-platform-addons
        ignoreMissingValueFiles: true
        valueFiles:
          - $values/gitops/addons/bootstrap/default/addons.yaml
          - $values/gitops/addons/environments/control-plane/addons.yaml
        valuesObject:
          useSelectors: false
          globalSelectors:
            enable_agent_platform: "true"
          litellm:
            valuesObject:
              global:
                awsRegion: "<REGION>"
  destination:
    namespace: argocd
    name: "<REGISTERED_CLUSTER_NAME>"
  syncPolicy:
    automated:
      selfHeal: true
      prune: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
```

The hub cluster secret must have `enable_agent_platform: "true"` label for the generated ApplicationSets to match.

## How the Agent Platform Works

### Path 1: Agent A2A (direct chat, no auth for internal access)

```
┌──────────┐     ┌───────────────────┐     ┌──────────────────┐     ┌─────────────┐     ┌─────────┐
│  Client  │────▶│  Agent Pod        │────▶│ kagent-controller│     │   LiteLLM   │────▶│ Bedrock │
│  (curl/  │ A2A │  (bedrock-asst    │     │  (session mgmt)  │     │  (proxy)    │     │  (LLM)  │
│   UI)    │     │   or k8s-ops)     │     │                  │     │             │     │         │
└──────────┘     └───────┬───────────┘     └──────────────────┘     └─────────────┘     └─────────┘
                         │  OpenAI-compatible API                           ▲
                         └─────────────────────────────────────────────────┘
```

1. Client sends JSON-RPC `message/send` to the agent's Service (port 8080)
2. Agent framework calls kagent-controller to create/manage sessions
3. Agent calls LiteLLM (OpenAI-compatible) which routes to Bedrock via Pod Identity
4. For tool-using agents (k8s-ops), the agent also calls `kagent-tool-server` via MCP

### Path 2: Authenticated MCP via AgentGateway + KeyCloak

```
┌──────────┐  1.Get Token  ┌──────────────┐
│  Client  │──────────────▶│  KeyCloak    │
│          │◀──────────────│  (platform   │
│          │   JWT Token   │   realm)     │
└────┬─────┘               └──────────────┘
     │
     │ 2. MCP request + JWT
     ▼
┌──────────────────┐  3. Validate JWT   ┌──────────────┐
│  AgentGateway    │───────────────────▶│  KeyCloak    │
│  Proxy (:8080)   │   (JWKS fetch)     │  (JWKS)      │
│  - JWT validation│◀───────────────────│              │
│  - Group authz   │                    └──────────────┘
└────────┬─────────┘
         │ 4. Forward (if in "admin" group)
         ▼
┌─────────────────────────────────────┐
│  MCP Servers (code/browser/memory)  │
└─────────────────────────────────────┘
```

### Testing

```bash
# Chat with an agent (A2A, no auth)
kubectl run chat --rm -i --restart=Never --image=curlimages/curl -n kagent -- \
  -s -X POST http://bedrock-assistant.kagent.svc.cluster.local:8080/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","messageId":"msg-1","parts":[{"type":"text","text":"Hello"}]}}}'

# Get JWT from KeyCloak and test AgentGateway
TOKEN=$(curl -s -X POST "https://<DOMAIN>/keycloak/realms/platform/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=mcp-client&username=user1&password=<PASSWORD>" | jq -r .access_token)

curl -N http://agentgateway-proxy.agentgateway-system.svc.cluster.local:8080/sse \
  -H "Authorization: Bearer $TOKEN"
```

## EKS ArgoCD Capability Notes

- Custom Lua health checks are not supported
- Sync timeout is fixed at 120 seconds
- Git cache refreshes every 3-10 minutes
- Cluster secrets must use EKS ARNs, not `kubernetes.default.svc`
- Pod Identity (not IRSA) for AWS credentials on EKS Auto Mode
- Duplicate cluster secrets with the same ARN are rejected

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| LiteLLM "Unable to locate credentials" | Missing Pod Identity | Create Pod Identity association, restart LiteLLM |
| LiteLLM "model version has reached end of life" | Outdated model IDs | Update to `us.anthropic.*` inference profiles in litellm chart |
| kagent-controller CrashLoop | Startup probe timeout | Upstream kagent chart issue — may need resource tuning |
| ApplicationSet "map has no entry" | Cluster secret missing annotations | Use `useSelectors: false` with `globalSelectors` |
| Gateway API CRDs Job fails | No outbound internet or image pull issue | Verify NAT gateway, check `bitnami/kubectl:latest` availability |
| AgentGateway proxy not starting | Missing Gateway API CRDs or JWKS fetch failure | Verify CRDs installed, check KeyCloak reachability |
| JWT validation fails | Wrong issuer URL | Ensure issuer matches `iss` claim (`https://<domain>/keycloak/realms/platform`) |
| ArgoCD reverts manual changes | selfHeal enabled | Push changes to git instead of patching directly |
