# Agent Platform GitOps Deployment Guide

Deploy the agent platform addons on an existing EKS hub cluster using the ArgoCD EKS Capability.

## Prerequisites

- EKS cluster with ArgoCD EKS Capability active
- `kubectl` configured to communicate with the cluster
- `aws` CLI configured with appropriate credentials
- ArgoCD Capability Role with `AmazonEKSClusterAdminPolicy` associated on the local cluster
- Local cluster registered in ArgoCD using its EKS ARN

## Architecture

```
agent-platform Secret (argocd namespace)
  └─ enable_* labels control which addons deploy
       │
       ▼
agent-platform-addons ApplicationSet
  └─ renders application-sets chart
       └─ generates one ApplicationSet per enabled addon
            └─ each ApplicationSet creates an Application
                 └─ ArgoCD syncs to cluster
```

## Step 1: Create the Cluster Secret

The cluster secret tells ArgoCD where to find the addon charts and which addons to enable.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: agent-platform
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
    fleet_member: control-plane
    platform: agent-platform
    environment: dev
    tenant: default
    # Core addons
    enable_kagent: "true"
    enable_litellm: "true"
    enable_langfuse: "true"
    enable_jaeger: "true"
    # Uncomment when Prometheus Operator CRDs are available
    # enable_kagent_monitoring: "true"
    # Uncomment when agent-core prerequisites are ready
    # enable_flux: "true"
    # enable_tofu_controller: "true"
    # enable_agent_core: "true"
  annotations:
    addons_repo_url: "https://github.com/aws-samples/sample-agent-platform-on-eks.git"
    addons_repo_revision: "feature/gitops-agent-platform"
    addons_repo_basepath: "gitops/addons/"
    aws_region: "<AWS_REGION>"
    aws_account_id: "<AWS_ACCOUNT_ID>"
    aws_cluster_name: "<EKS_CLUSTER_NAME>"
    # Required for agent-core (uncomment when ready)
    # tofu_controller_role_arn: "<TOFU_CONTROLLER_ROLE_ARN>"
    # agent_core_project_name: "agent-core"
    # agent_core_network_mode: "PUBLIC"
    # agent_core_mcp_image: "<ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/agent-core-mcp"
    # agent_core_mcp_image_tag: "latest"
    # agent_core_terraform_repo_url: "https://github.com/<ORG>/eks-agent-core-pocs.git"
    # agent_core_terraform_repo_revision: "main"
type: Opaque
stringData:
  name: agent-platform
  server: "arn:aws:eks:<REGION>:<ACCOUNT_ID>:cluster/<CLUSTER_NAME>"
  config: |
    {}
```

> **EKS ArgoCD Capability**: The `server` field must use the EKS cluster ARN,
> not `https://kubernetes.default.svc`. The managed capability requires ARNs.

Apply:
```bash
kubectl apply -f cluster-secret.yaml
```

## Step 2: Deploy the Bootstrap ApplicationSet

The bootstrap ApplicationSet renders the `application-sets` chart, which generates
one ApplicationSet per enabled addon based on the `enable_*` labels.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: agent-platform-addons
  namespace: argocd
spec:
  syncPolicy:
    preserveResourcesOnDeletion: false
  goTemplate: true
  goTemplateOptions:
    - missingkey=error
  generators:
    - clusters:
        selector:
          matchLabels:
            platform: agent-platform
        values:
          addonChart: application-sets
  template:
    metadata:
      name: agent-platform-addons
    spec:
      project: default
      sources:
        - ref: values
          repoURL: '{{.metadata.annotations.addons_repo_url}}'
          targetRevision: '{{.metadata.annotations.addons_repo_revision}}'
        - repoURL: '{{.metadata.annotations.addons_repo_url}}'
          path: '{{.metadata.annotations.addons_repo_basepath}}charts/{{.values.addonChart}}'
          targetRevision: '{{.metadata.annotations.addons_repo_revision}}'
          helm:
            releaseName: agent-platform-addons
            ignoreMissingValueFiles: true
            valueFiles:
              - $values/{{.metadata.annotations.addons_repo_basepath}}bootstrap/default/addons.yaml
              - $values/{{.metadata.annotations.addons_repo_basepath}}environments/{{ .metadata.labels.environment }}/addons.yaml
      destination:
        namespace: argocd
        name: '{{.name}}'
      syncPolicy:
        automated:
          selfHeal: true
          allowEmpty: true
          prune: true
        retry:
          limit: 100
        syncOptions:
          - CreateNamespace=true
          - ServerSideApply=true
```

> **Note**: This uses `platform: agent-platform` selector to avoid conflicts with
> other addon pipelines (e.g., appmod-blueprints) that use `fleet_member: control-plane`.

Apply:
```bash
kubectl apply -f bootstrap-appset.yaml
```

## Step 3: Verify Deployment

```bash
# Check ApplicationSets generated
kubectl get applicationsets -n argocd | grep agent-platform

# Check Applications created and syncing
kubectl get applications -n argocd | grep agent-platform

# Check pods
kubectl get pods -n kagent
kubectl get pods -n langfuse
kubectl get pods -n jaeger
```

## Addon Sync-Wave Order

| Wave | Addon | Namespace | Source |
|------|-------|-----------|--------|
| 0 | flux | flux-system | Helm repo (fluxcd-community) |
| 1 | tofu-controller | flux-system | Helm repo (flux-iac) |
| 2 | kagent-crds | kagent | OCI (ghcr.io/kagent-dev) |
| 3 | kagent | kagent | OCI (ghcr.io/kagent-dev) |
| 3 | kagent-setup | kagent | Git path (local chart) |
| 3 | litellm | kagent | Git path (local chart) |
| 4 | agent-core | agent-core-infra | Git path (local chart) |
| 5 | langfuse | langfuse | Git path (local chart) |
| 5 | jaeger | jaeger | Helm repo (jaegertracing) |
| 6 | kagent-monitoring | kagent | Git path (local chart) |

## Enabling Agent-Core

Agent-core requires additional prerequisites before enabling:

### 1. Create IAM Role for Tofu Controller

```bash
# Get OIDC provider
OIDC_ID=$(aws eks describe-cluster --name <CLUSTER_NAME> --region <REGION> \
  --query 'cluster.identity.oidc.issuer' --output text | sed 's|https://||')

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
```

Create trust policy (`tofu-trust-policy.json`):
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/<OIDC_ID>"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "<OIDC_ID>:aud": "sts.amazonaws.com",
          "<OIDC_ID>:sub": "system:serviceaccount:agent-core-infra:tf-runner"
        }
      }
    }
  ]
}
```

```bash
aws iam create-role \
  --role-name TofuControllerRole \
  --assume-role-policy-document file://tofu-trust-policy.json

aws iam put-role-policy \
  --role-name TofuControllerRole \
  --policy-name TofuControllerPolicy \
  --policy-document file://tofu-controller-policy.json
```

### 2. Build and Push MCP Server Image

```bash
cd mcp-server
aws ecr create-repository --repository-name agent-core-mcp --region <REGION>

aws ecr get-login-password --region <REGION> | \
  docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com

docker build --platform linux/amd64 -t agent-core-mcp:latest .
docker tag agent-core-mcp:latest <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/agent-core-mcp:latest
docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/agent-core-mcp:latest
```

### 3. Enable on Cluster Secret

Add labels and annotations to the `agent-platform` secret:

```bash
# Add enable labels
kubectl label secret agent-platform -n argocd \
  enable_flux="true" \
  enable_tofu_controller="true" \
  enable_agent_core="true"

# Add annotations
kubectl annotate secret agent-platform -n argocd \
  tofu_controller_role_arn="arn:aws:iam::<ACCOUNT_ID>:role/TofuControllerRole" \
  agent_core_project_name="agent-core" \
  agent_core_network_mode="PUBLIC" \
  agent_core_mcp_image="<ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/agent-core-mcp" \
  agent_core_mcp_image_tag="latest" \
  agent_core_terraform_repo_url="https://github.com/<ORG>/eks-agent-core-pocs.git" \
  agent_core_terraform_repo_revision="main"
```

ArgoCD will automatically detect the label changes and deploy flux, tofu-controller,
and agent-core.

## EKS ArgoCD Capability Considerations

- **Custom Lua health checks are not supported**: The agent-core chart includes a
  custom health check for Terraform CRDs (`argocd-health-check.yaml`). This ConfigMap
  will be ignored by the managed capability. Terraform resources may show as
  "Progressing" or "Unknown" in the ArgoCD UI but will still function correctly.
- **Sync timeout is fixed at 120 seconds**: Long-running Terraform applies may
  appear to time out in the UI but will continue in the background.
- **Cluster registration uses ARNs**: Always use `arn:aws:eks:...` in the `server`
  field, not `https://kubernetes.default.svc`.

## Fixes Applied

| File | Fix | Reason |
|------|-----|--------|
| `bootstrap/default/addons.yaml` | flux: Helm repo instead of git path | ArgoCD cannot build Helm dependencies from git-sourced charts |
| `bootstrap/default/addons.yaml` | kagent: `ghcr.io` instead of `public.ecr.aws` | Chart registry moved |
| `charts/litellm/values.yaml` | Memory 512Mi/1Gi | Prevents OOMKill |
| `charts/langfuse/templates/langfuse.yaml` | Added PGDATA env var | Fixes `lost+found` directory conflict on PVC mount |
