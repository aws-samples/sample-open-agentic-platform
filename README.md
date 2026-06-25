# Open Agentic Platform on Amazon EKS

A production-ready AI agent platform built on Amazon EKS, featuring LiteLLM gateway, Langfuse observability, AgentGateway (MCP auth), and multi-agent orchestration.

## Quick Start

### Prerequisites

- AWS account with Bedrock access
- [Task](https://taskfile.dev), kubectl, Helm 3.x, AWS CLI, `yq`
- Podman or Docker (for Kind-based bootstrap)

### Install

```bash
# 1. Configure
cp config.yaml config.local.yaml
# Edit config.local.yaml with your values

# 2. Install everything (platform + agentic components)
task install
```

That's it. The installer provisions an EKS hub cluster, deploys the base platform (ArgoCD, Crossplane, observability), then layers on the agentic components.

### Configuration

Edit `config.local.yaml`:

| Section | Key Fields | Description |
|---------|-----------|-------------|
| `platform` | `repo`, `ref` | Base platform repo and version tag |
| `aws` | `region`, `accountId`, `profile` | AWS settings |
| `hub` | `clusterName`, `kubernetesVersion` | Hub cluster config |
| `domain` | | Ingress domain (must have ACM cert + Route53 zone) |
| `identityCenter` | `instanceArn`, `region`, `adminGroupId` | SSO for ArgoCD |
| `agenticRepo` | `url`, `revision`, `basepath` | This repo's git coordinates (for ArgoCD) |
| `spokes` | | Optional spoke clusters (see below) |

### Spoke Clusters

Add spoke clusters for workload environments:

```yaml
spokes:
  dev:
    region: us-west-2
    kubernetesVersion: "1.35"
    vpcCidr: "10.1.0.0/16"
    autoMode: true
  prod:
    region: us-west-2
    kubernetesVersion: "1.35"
    vpcCidr: "10.2.0.0/16"
    autoMode: true
```

Spokes are provisioned via Crossplane from the hub. Agentic components deploy to all clusters automatically.

### Fleet Management & Targeting

This repo controls which clusters receive the agentic platform via `gitops/overlays/environments/*/enabled-addons.yaml`:

```yaml
# gitops/overlays/environments/dev/enabled-addons.yaml
enabledAddons:
  agent_platform: true   # deploy agentic components to dev clusters
```

Set `agent_platform: false` to exclude an environment. Fleet member definitions in `gitops/fleet/members/` control spoke discovery.

## Available Commands

| Command | Description |
|---------|-------------|
| `task install` | Full install (platform + spokes + agentic) |
| `task platform:install` | Provision base EKS platform only |
| `task spokes:install` | Provision spoke clusters only |
| `task spokes:status` | Check spoke provisioning progress |
| `task agentic:install` | Deploy agentic components only |
| `task status` | Show ArgoCD application status |
| `task upgrade` | Upgrade everything |
| `task destroy` | Remove agentic components (keeps base platform) |
| `task spokes:destroy` | Delete spoke clusters |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  open-agentic-platform (this repo)                      │
│  config.local.yaml → task install                       │
└────────────┬────────────────────────────┬───────────────┘
             │                            │
    ┌────────▼────────┐         ┌────────▼────────┐
    │ appmod-blueprints│         │ ArgoCD Application│
    │ (base platform) │         │ (agentic addons)  │
    │ read-only clone │         │ points to this repo│
    └────────┬────────┘         └────────┬──────────┘
             │                            │
             ▼                            ▼
    ┌─────────────────────────────────────────────────┐
    │              EKS Hub Cluster                     │
    │  ArgoCD ─── watches both repos (read-only)      │
    │  Crossplane ─── provisions spoke clusters       │
    │                                                  │
    │  Agentic: LiteLLM, Langfuse, Jaeger,            │
    │           AgentGateway, Bifrost, AgentCore      │
    └─────────────────────────────────────────────────┘
```

## Components

| Component | Purpose |
|-----------|---------|
| **LiteLLM** | LLM gateway with rate limiting, caching, fallbacks |
| **Langfuse** | LLM observability — traces, costs, analytics |
| **Jaeger** | Distributed tracing for agent interactions |
| **AgentGateway** | MCP auth gateway with Keycloak OIDC |
| **Bifrost** | AI gateway for model routing |
| **AgentCore** | Crossplane compositions for Bedrock AgentCore |

## Workshop

The `workshop/` directory contains hands-on examples:

| Module | Description |
|--------|-------------|
| `00-initial-setup` | Bedrock + LiteLLM configuration |
| `01-first-agent` | Basic KAgent with Bedrock |
| `02-k8s-ops-agent` | Kubernetes operations agent |
| `03-multi-tool-agent` | Agent with MCP tool servers |
| `04-multi-agents` | Financial services multi-agent system |
| `05-observability` | Monitoring and tracing setup |

## Resources

- [LiteLLM](https://docs.litellm.ai)
- [Langfuse](https://langfuse.com/docs)
- [Amazon Bedrock](https://aws.amazon.com/bedrock)
- [appmod-blueprints](https://github.com/aws-samples/appmod-blueprints) (base platform)

## Design & Architecture

Design documents and open work items — check these before starting a new feature:

| Document | What it covers | Open items |
|---|---|---|
| [gitops/addons/charts/bifrost/DESIGN.md](gitops/addons/charts/bifrost/DESIGN.md) | Bifrost AI Gateway architecture, current state (no auth), and **per-workload Virtual Key minting** target design | ⚠️ `is_vk_mandatory` is disabled — implement per-workload VK minting via KubeVela workflow step before enabling |
| [platform/oam/DESIGN.md](platform/oam/DESIGN.md) | KubeVela OAM `agent` and `mcp-server` ComponentDefinition design decisions | — |
| [applications/strands-agent-base/ARCHITECTURE.md](applications/strands-agent-base/ARCHITECTURE.md) | Strands agent internals, LLM gateway integration, A2A protocol | References LiteLLM — superseded by Bifrost (`OpenAIModel` + `x-bf-vk`) |
| [gitops/DEPLOYMENT.md](gitops/DEPLOYMENT.md) | GitOps deployment runbook: ArgoCD bootstrap, addon enablement, Pod Identity setup | LiteLLM Pod Identity step is superseded by declarative Crossplane in bifrost chart |
