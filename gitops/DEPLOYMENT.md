# Agent Platform GitOps Deployment Guide

Deploy the AI agent platform on an EKS cluster using the ArgoCD EKS Capability.

## What Gets Deployed

| Wave | Addon | Source | Namespace |
|------|-------|--------|-----------|
| 0 | flux (source-controller) | Helm: `fluxcd-community/flux2:2.12.4` | flux-system |
| 1 | tofu-controller | Helm: `flux-iac/tf-controller:0.16.0-rc.4` | flux-system |
| 2 | kagent-crds | OCI: `ghcr.io/kagent-dev/kagent/helm/kagent-crds:0.7.9` | kagent |
| 3 | kagent (operator + UI) | OCI: `ghcr.io/kagent-dev/kagent/helm/kagent:0.7.9` | kagent |
| 3 | kagent-setup (ModelConfig) | Local chart | kagent |
| 3 | litellm (LLM gateway) | Local chart | kagent |
| 4 | agent-core (Terraform + MCP + Agent) | Local chart | agent-core-infra |
| 5 | langfuse (LLM tracing + PostgreSQL) | Local chart | langfuse |
| 5 | jaeger (distributed tracing) | Helm: `jaegertracing/jaeger:3.4.1` | jaeger |
| 5 | prometheus-operator-crds | Helm: `prometheus-community/prometheus-operator-crds:28.0.1` | kagent |
| 6 | kagent-monitoring (ServiceMonitor) | Local chart | kagent |
| 7 | gateway-api-crds | Local chart (Job) | agentgateway-system |
| 7 | agentgateway-crds | OCI: `cr.agentgateway.dev/charts/agentgateway-crds:v1.1.0` | agentgateway-system |
| 8 | agentgateway (control plane) | OCI: `cr.agentgateway.dev/charts/agentgateway:v1.1.0` | agentgateway-system |
| 9 | agent-gateway (Gateway + Policies) | Local chart | agent-core-infra |

## Deployment via appmod-blueprints

When deployed through the [appmod-blueprints](https://github.com/aws-samples/appmod-blueprints) platform, set `agent_platform: true` in `enabled-addons.yaml`. The appmod-blueprints bootstrap chart handles everything — see `gitops/AGENT-PLATFORM.md` in that repo.

## Standalone Deployment

### Prerequisites

- EKS cluster with ArgoCD EKS Capability active
- ArgoCD Capability Role with `AmazonEKSClusterAdminPolicy` on the local cluster
- Local cluster registered in ArgoCD using its EKS ARN
- `kubectl` and `aws` CLI configured

### Pod Identity (EKS Auto Mode)

LiteLLM needs Bedrock access. Create an IAM role with Pod Identity:

```bash
CLUSTER_NAME="<your-cluster>"
REGION="<your-region>"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

aws iam create-role --role-name LiteLLMBedrockRole \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "pods.eks.amazonaws.com"},
      "Action": ["sts:AssumeRole", "sts:TagSession"]
    }]
  }'

aws iam put-role-policy --role-name LiteLLMBedrockRole --policy-name BedrockInvoke \
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
  --role-arn arn:aws:iam::${ACCOUNT_ID}:role/LiteLLMBedrockRole
```

For agent-core, also create the Tofu Controller IAM role:

```bash
aws iam create-role --role-name AgentCoreTofuRunner \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "pods.eks.amazonaws.com"},
      "Action": ["sts:AssumeRole", "sts:TagSession"]
    }]
  }'

aws iam put-role-policy --role-name AgentCoreTofuRunner --policy-name AgentCoreTofuRunnerPolicy \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": [
        "bedrock:*", "bedrock-agentcore:*", "s3:*",
        "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:PassRole",
        "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy",
        "iam:DeleteRolePolicy", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies",
        "iam:ListRolePolicies", "iam:UpdateAssumeRolePolicy", "iam:ListInstanceProfilesForRole",
        "aoss:*", "ec2:DescribeVpcs", "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups",
        "eks:DescribeCluster", "eks:CreatePodIdentityAssociation",
        "eks:DeletePodIdentityAssociation", "eks:DescribePodIdentityAssociation",
        "eks:ListPodIdentityAssociations"
      ],
      "Resource": "*"
    }]
  }'

aws eks create-pod-identity-association \
  --cluster-name $CLUSTER_NAME --region $REGION \
  --namespace agent-core-infra --service-account tf-runner \
  --role-arn arn:aws:iam::${ACCOUNT_ID}:role/AgentCoreTofuRunner
```

### MCP Server Image (agent-core only)

```bash
cd mcp-server
aws ecr create-repository --repository-name agent-core-mcp --region $REGION
aws ecr get-login-password --region $REGION | \
  docker login --username AWS --password-stdin ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com
docker build --platform linux/amd64 -t agent-core-mcp:latest .
docker tag agent-core-mcp:latest ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/agent-core-mcp:latest
docker push ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/agent-core-mcp:latest
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
          agent-core:
            valuesObject:
              global:
                awsRegion: "<REGION>"
                eksClusterName: "<CLUSTER_NAME>"
                terraformRepoUrl: "https://github.com/aws-samples/sample-agent-platform-on-eks.git"
                terraformRepoRevision: "main"
              mcpServer:
                image:
                  repository: "<ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/agent-core-mcp"
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

## EKS ArgoCD Capability Notes

- Custom Lua health checks are not supported (Terraform health may show as Unknown)
- Sync timeout is fixed at 120 seconds
- Git cache refreshes every 3-10 minutes
- Cluster secrets must use EKS ARNs, not `kubernetes.default.svc`
- Pod Identity (not IRSA) for AWS credentials on EKS Auto Mode
- Duplicate cluster secrets with the same ARN are rejected

## AgentGateway Configuration

AgentGateway provides MCP authentication via KeyCloak JWT validation. It deploys:

1. **Gateway API CRDs** — Standard Kubernetes Gateway API resources (via Job)
2. **AgentGateway CRDs** — Custom resources for AgentgatewayBackend and AgentgatewayPolicy
3. **AgentGateway control plane** — Watches Gateway API resources and provisions proxy instances
4. **Platform resources** — Gateway, Backend, HTTPRoute, and JWT/MCP authentication policies

### KeyCloak Integration

The agent-gateway chart requires KeyCloak configuration via cluster secret annotations:

| Annotation | Default | Purpose |
|---|---|---|
| `keycloak_issuer_url` | (required) | External KeyCloak issuer URL (must match JWT `iss` claim) |
| `keycloak_service_name` | `keycloak-service` | Kubernetes Service name for JWKS fetching |
| `keycloak_namespace` | `keycloak` | Namespace where KeyCloak is deployed |
| `agent_gateway_resource_url` | (optional) | MCP resource identifier for OAuth discovery |

When deployed via appmod-blueprints, the KeyCloak issuer URL is derived from the `ingress_domain_name` annotation.

### Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  MCP Client │────▶│  AgentGateway    │────▶│  MCP Servers        │
│  (Agent)    │     │  Proxy           │     │  (code/browser/mem) │
│             │     │  - JWT validation│     │                     │
│             │     │  - MCP auth      │     │                     │
└─────────────┘     └──────────────────┘     └─────────────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  KeyCloak    │
                    │  (JWKS)      │
                    └──────────────┘
```

Agents connect to the AgentGateway proxy (port 8080) which validates JWT tokens against KeyCloak before forwarding requests to the MCP backend servers.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| LiteLLM "Unable to locate credentials" | Missing Pod Identity | Create Pod Identity association, restart LiteLLM |
| LiteLLM "model version has reached end of life" | Outdated model IDs | Update to `us.anthropic.*` inference profiles in litellm chart |
| Terraform "path not found" | Wrong branch on GitRepository | Verify `terraformRepoRevision` matches the branch with `terraform/` directory |
| MCP server CreateContainerConfigError | Terraform outputs secret missing | Wait for Terraform to complete |
| MCP server OOMKilled | Insufficient memory | Increase limits in agent-core values (default 512Mi/1Gi) |
| Jaeger OOMKilled | No resource limits | Jaeger chart includes 256Mi/512Mi limits |
| kagent-controller CrashLoop | Startup probe timeout | Upstream kagent chart issue — may need resource tuning |
| ApplicationSet "map has no entry" | Cluster secret missing annotations | Use `useSelectors: false` with `globalSelectors` |
| Gateway API CRDs Job fails | No outbound internet | Ensure NAT gateway is configured for EKS nodes |
| AgentGateway proxy not starting | Missing Gateway API CRDs | Verify gateway-api-crds Job completed successfully |
| JWT validation fails | Wrong issuer URL | Ensure `keycloak_issuer_url` matches the `iss` claim in tokens |
| AgentGateway "no backends" | MCP servers not running | Verify agent-core MCP pods are healthy in agent-core-infra namespace |
