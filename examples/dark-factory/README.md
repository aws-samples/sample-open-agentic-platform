# Dark Factory — Flow B, Phase P1 (reference implementation — superseded)

> ⚠️ **Superseded by the Argo Workflows design.** This directory is the **P1 reference**: a bespoke
> long-running **Node orchestrator** that imperatively drives claim → coder → PR → teardown. The
> current design orchestrates Flow B with **Argo Workflows on the hub** (see
> [`docs/dark-factory/README.md`](../../docs/dark-factory/README.md) §4 and
> [`diagrams/flow-b-dark-factory.md`](../../docs/dark-factory/diagrams/flow-b-dark-factory.md)).
> Under that design this code is **not deployed as a service** — instead its pieces become **Argo
> workflow step-containers**:
> - `orchestrator/lib/github.js` — the sticky-comment upsert + PR creation (reused verbatim as a step).
> - `orchestrator/lib/k8s.js` — the `SandboxClaim` shape / bind-poll (Argo does most of this
>   declaratively via a `resource` template; the shape is the reference).
> - `coder/agent.js` — the in-VM coder workload, **unchanged** (it's behind the SandboxTemplate,
>   independent of who orchestrates).
>
> Kept for reference and reuse; not deleted. The sections below describe the original P1 service.

**Trigger → claim warm sandbox → drive the coder → open a PR with a live sticky status → manual
teardown.** The first independently-useful slice of the [Dark Factory pattern](../../docs/dark-factory/README.md)
and the first real consumer of **[Flow A](../../docs/dark-factory/diagrams/flow-a-sandbox-capability.md)**'s
Kata micro-VM warm pool.

Autonomy is bounded here: P1 opens a PR and **stops** — a human still reviews and merges. The
verification gates (holdout, Security/DevOps agents) arrive in P2/P3.

## Components

| Path | Role | Trust |
|---|---|---|
| `.github/workflows/dark-factory.yml` | GitHub Action — gates on the `dark-factory` label, mints a short-TTL token, POSTs to the orchestrator | trigger |
| `orchestrator/server.js` | HTTP service: `/run` drives the pipeline, `/teardown` releases the sandbox | **trusted** (holds the GH token; in later phases, AWS IAM) |
| `orchestrator/lib/k8s.js` | Claims a warm sandbox via a `SandboxClaim(warmPoolRef)`, waits for bind+Ready, releases on teardown | trusted |
| `orchestrator/lib/github.js` | The **one** sticky PR status comment (edited in place) + PR creation | trusted |
| `orchestrator/lib/coder.js` | Drives the pluggable coder inside the sandbox over its `:8080` control endpoint | trusted → boundary |
| `coder/agent.js` | The in-VM coder agent: writes `SPEC.md`, checks out `df/issue-<n>`, runs Claude Code headless via Bifrost, builds+tests, returns `result.json` | **untrusted** (Kata VM, no cloud creds) |
| `orchestrator/k8s/*` | Deployment + Service + narrowly-scoped RBAC (SandboxClaims only) | — |
| `gitops-app.yaml` | ArgoCD Application pinning the orchestrator to **spoke-dev** | — |

## Request flow

```
GitHub issue (label: dark-factory)
  → GitHub Action (gate on label, mint short-TTL token)
  → orchestrator POST /run   ← trusted; holds GH token, narrow RBAC
       ├─ SandboxClaim(warmPoolRef=coder-warmpool)   ← binds a warm Kata VM (Flow A)
       ├─ wait for status.sandbox {name, podIPs} + Ready
       ├─ POST run spec to coder agent in the VM (SPEC.md + branch df/issue-N)
       │     coder: implement → build → unit tests until green → push branch
       ├─ open PR + maintain ONE sticky status comment (⏳→✅)
       └─ (P2/P3) holdout gate + Security/DevOps agents — pending
  → human reviews evidence, approves, merges
  → orchestrator POST /teardown → delete SandboxClaim (pool refills)
```

## The SandboxClaim contract (verified against the live v1beta1 CRD)

The orchestrator claims from Flow A's `SandboxWarmPool` rather than creating sandboxes:

```yaml
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxClaim
metadata: { name: df-issue-42, namespace: agent-sandbox-system }
spec:
  warmPoolRef: { name: coder-warmpool }   # bind a pre-warmed idle sandbox
  env:                                     # per-container, NON-secret
    - { containerName: coder, name: BIFROST_URL, value: http://bifrost.bifrost.svc.cluster.local:8080 }
  lifecycle: { ttlSecondsAfterFinished: 10800 }   # safety-net TTL
# status.sandbox.{name, podIPs[]} + status.conditions[Ready] → the bound VM
```

## Trust boundary (§10)

- The **orchestrator** is trusted and runs on general Auto Mode nodes (not the kata MNG). It holds
  the GitHub token (handed per-run by the Action) and — in later phases — AWS IAM. Its RBAC is
  scoped to `sandboxclaims` (+ read `sandboxes`) in one namespace; no pod/exec, no secrets, no
  cluster scope.
- The **coder** is untrusted: it runs in a **Kata micro-VM**, holds only a Bifrost API key + a
  short-TTL GitHub token via **projected tmpfs (mode 0400)** — read at point of use, never in env —
  and reaches models only through **Bifrost**. Flow A's NetworkPolicy locks egress to
  Bifrost + DNS + GitHub.
- This breaks the **lethal trifecta** (untrusted issue text + credentials + egress): credentials are
  never in the issue-ingesting sandbox context, and egress is denied by default.

## Build & deploy (staged — not auto-deployed)

```bash
# 1) Build + push both images to ECR, pin the tags.
docker build -t <ecr>/dark-factory-orchestrator:0.1.0 examples/dark-factory/orchestrator
docker build -t <ecr>/dark-factory-coder:0.1.0        examples/dark-factory/coder
#    → set the coder image on the Flow A SandboxTemplate (coderTemplate.image)
#    → set the orchestrator image in orchestrator/k8s/deployment.yaml

# 2) Deploy the orchestrator onto spoke-dev.
kubectl --context hub apply -f examples/dark-factory/gitops-app.yaml   # ArgoCD (recommended)
# or directly:
kubectl --context spoke-dev apply -f examples/dark-factory/orchestrator/k8s/

# 3) Wire the trigger.
#    repo/org variable  DARK_FACTORY_ORCHESTRATOR_URL  = https://<orchestrator ingress>
#    repo/org secret     DARK_FACTORY_DISPATCH_TOKEN    = shared dispatch secret
#    Label an issue `dark-factory` to fire a run.
```

## Configuration (orchestrator env)

| Var | Default | Purpose |
|---|---|---|
| `SANDBOX_NAMESPACE` | `agent-sandbox-system` | Where the warm pool + claims live |
| `WARM_POOL_NAME` | `coder-warmpool` | Flow A `SandboxWarmPool` to claim from |
| `CLAIM_READY_TIMEOUT_MS` | `120000` | Max wait for a claim to bind + Ready |
| `CLAIM_TTL_SECONDS` | `10800` | Safety-net TTL on the claim (reaper backstop) |
| `BIFROST_URL` | `http://bifrost.bifrost.svc.cluster.local:8080` | LLM gateway the coder uses |
| `CODER_PROFILE` | `claude-code` | `claude-code` (primary) or `kiro` |

## Not in P1 (by design)

- **Holdout gate** (P2), **AWS Security/DevOps agents** (P3) — rendered as pending in the sticky
  comment so the surface is stable.
- **Auto-teardown on merge** + reaper (P4) — P1 teardown is the manual `/teardown` call.
- **Iterative comment loop** — P1 opens the PR and stops; the human drives from there.

## Status

Code + manifests validated (JS syntax, server-side `kubectl --dry-run` against spoke-dev). Images
are **not** built/pushed and nothing is deployed yet — this is the staged P1 implementation.
