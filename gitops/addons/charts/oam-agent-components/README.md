# oam-agent-components

Helm chart that registers three KubeVela `ComponentDefinition`s on the cluster:

| ComponentDefinition | What it abstracts |
|---|---|
| `agent` | A2A agent deployed as `argoproj.io/v1alpha1.Rollout` with blue-green strategy and pluggable memory backends |
| `mcp-server` | MCP server deployed as a `Rollout` with blue-green strategy and AgentGateway backend registration |
| `agentcore-memory` | Bedrock AgentCore Memory provisioned via the `AgentCoreMemory` Crossplane Composition (from the `crossplane-agentcore` addon) |

The CUE source for these definitions lives at `platform/oam/definitions/components/` and is rendered into the chart's `templates/` directory by `platform/oam/generate.sh`.

## Role in the platform

This is a **wave-5 declarative consumer**. The convention, documented in [appmod-blueprints/gitops/addons/registry/README.md](https://github.com/aws-samples/appmod-blueprints/blob/feature/agent-platform-shapirov/gitops/addons/registry/README.md), is that a chart's sync-wave reflects the highest wave it consumes — not the resources it emits. Adding new ComponentDefinitions here does not change the wave; only changes to the set of consumed addons do.

```
wave 3   argo-rollouts          (Rollout CRD)
wave 3   crossplane             (Composition / claim machinery, used by agentcore-memory)
wave 4   kubevela               (ComponentDefinition CRD + admission webhook;
                                  itself depends on wave-3 argo-rollouts because its
                                  built-in appmod-service ComponentDefinition emits Rollout)
wave 5   oam-agent-components   ← this chart
```

## Prerequisites

The following addons must be enabled in the cluster overlay (`gitops/overlays/environments/<env>/enabled-addons.yaml`) before this chart can sync cleanly:

- `argo_rollouts: true` — without this, KubeVela's admission webhook rejects the `agent` and `mcp-server` ComponentDefinitions with `no matches for kind "Rollout" in version "argoproj.io/v1alpha1"`.
- `kubevela: true` — provides the `ComponentDefinition` CRD and the mutating webhook that does the pre-render validation. Without this addon, the chart's manifests have no API to register against.
- `crossplane: true` — required only for `agentcore-memory`, which creates an `AgentCoreMemory` claim handled by the `crossplane-agentcore` addon's Composition.

These prerequisites are enforced by ArgoCD sync-wave ordering, not by Helm chart `dependencies:` (which would imply bundling — not what we want here, since each addon is a separate ArgoCD Application).

## Lifecycle

- **Install**: ArgoCD applies all three ComponentDefinitions in a single sync. KubeVela's mutating webhook attaches `spec.workload.type: rollouts.argoproj.io` and creates the shared `WorkloadDefinition` if it doesn't already exist (it does — the `kubevela` chart's `appmod-service` ComponentDefinition creates it first).
- **Upgrade**: regenerate from CUE (`./platform/oam/generate.sh` — outputs into `gitops/addons/charts/oam-agent-components/templates/`), commit, push. ArgoCD reconciles.
- **Uninstall**: removing the chart deletes the ComponentDefinitions; existing OAM `Application` instances using them break and must be cleaned up first.

## Used by

OAM `Application` examples in `platform/oam/examples/` reference these ComponentDefinitions by name (`type: agent`, `type: mcp-server`, `type: agentcore-memory`). Once registered, customer-authored OAM `Application` manifests in their own GitOps trees can use the same component types.
