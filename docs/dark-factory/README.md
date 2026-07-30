# Dark Factory — Autonomous Agent Coding Pattern

> **Status:** Design **+ implementation**. Phases **P0–P3b** are built and running on the hub (see
> [§12](#12-phased-delivery)). The **full event-driven lifecycle** works hands-off: a labeled issue →
> coder → holdout gate + Security/DevOps reviews → PR with live status; a **PR comment → bounded
> revision** (`df-iterate`); a **human approval → green-gated merge + teardown** (`df-merge-teardown`).
> All verified end-to-end on a live cluster. This doc describes the architecture, the reuse map onto
> the platform, and what remains (P4: conditional deploy-test + reaper + metrics; P5).

A **dark factory** is a manufacturing plant that runs *with the lights off* — no humans on the
floor, robots do everything. Applied to software: **a human writes an issue (a spec); AI agents
do the rest** — implement, build, test, security/ops review, open a PR, and (after a human
approves the *results*) merge and tear everything down.

This pattern wires that idea onto the **Open Agent Platform (OAP)** using components the platform
already has: hardware-isolated **Kata micro-VM sandboxes** (from `eks-platform-openclaw`), the
**Bifrost → Bedrock** LLM gateway, **Argo Workflows** on the hub as the orchestrator, the
**hub + spoke** cluster fleet, and **AWS-managed frontier agents** (Security, DevOps) for
independent review. The factory itself runs on the **hub build plane**; its output ships to the
spokes as normal deployments.

---

## Table of contents
1. [What is a Dark Factory](#1-what-is-a-dark-factory)
2. [Two flows at a glance](#2-two-flows-at-a-glance)
3. [Flow A — Agent Sandbox capability](#3-flow-a--agent-sandbox-capability-permanent-platform-feature)
4. [Flow B — the Dark Factory pipeline](#4-flow-b--the-dark-factory-pipeline)
   - [Flow D — Lambda MicroVM substrate (alternative to Flow A)](#45-flow-d--lambda-microvm-substrate-alternative-to-flow-a)
5. [The pluggable coding assistant](#5-the-pluggable-coding-assistant)
6. [Independent verification](#6-independent-verification-the-heart-of-the-pattern)
7. [Live status in the PR](#7-live-status-in-the-pr)
8. [Human-in-the-loop & the comment loop](#8-human-in-the-loop--the-iterative-comment-loop)
9. [Lifecycle, teardown & cost](#9-lifecycle-teardown--cost)
10. [Security model](#10-security-model)
11. [Industry alignment & anti-patterns](#11-industry-alignment--anti-patterns-what-the-world-agrees-on)
12. [Phased delivery](#12-phased-delivery)
13. [Open questions / future work](#13-open-questions--future-work)
14. [References](#14-references)

---

## 1. What is a Dark Factory

The term is borrowed from manufacturing and popularized for coding by two sources this design
draws on:

- **Steve Yegge — "Welcome to Gas City"**: a *supervisor plane* that deploys teams of
  collaborating agents as composable "packs," where humans **watch the factory work** from a
  rich console rather than typing code. Work is a first-class, versioned primitive.
- **HackerNoon — "The Dark Factory Pattern"**: an **autonomy-level** ladder and the key
  engineering ideas — **specs instead of code**, **holdout scenarios** (the coding agent never
  sees the acceptance tests; a separate evaluator judges), **build-before-push**, ephemeral
  environments, and **humans reviewing results, not diffs**.

### Autonomy levels (we target Level 3)

| Level | What it looks like |
|------:|--------------------|
| 1 | AI finishes your sentences; you do everything else. |
| 2 | AI writes whole files; **you review every change**. |
| **3** | **AI generates code from a spec; a holdout gate + reviewers verify; you approve the merge.** ← *this design* |
| 3.5 | Some low-risk services auto-merge without you. |
| 4 | Full dark factory: specs in, merged tested code out. |

At **Level 3**, the human's job shrinks from *"read every line of a diff"* to *"read the evidence
and click approve"* — but the human still gates the merge, and can drive changes via PR comments.

---

## 2. Two flows at a glance

This design is deliberately split into **two independent flows** so the sandbox capability is
useful on its own and the factory is a consumer of it.

| | **Flow A — Agent Sandbox capability** | **Flow B — Dark Factory** |
|---|---|---|
| **What** | A permanent platform feature: Kata micro-VM sandboxes + `Sandbox` CRD + a **warm pool** kept ready | The autonomous coding pipeline: issue → code → test → review → PR → merge → teardown |
| **When** | Comes up automatically when the agent platform is deployed | Triggered per GitHub issue labeled `dark-factory` |
| **Where** | Installed on the **hub cluster** — the build/author plane, co-located with Argo Workflows | **Runs on the hub cluster**, orchestrated by Argo Workflows, co-located with the sandbox pool |
| **Lifecycle** | Long-lived; pool self-heals to a target buffer | Ephemeral per issue; torn down on merge/close |
| **Diagram** | [`diagrams/flow-a-sandbox-capability.md`](diagrams/flow-a-sandbox-capability.md) | [`diagrams/flow-b-dark-factory.md`](diagrams/flow-b-dark-factory.md) |

> **Why split them?** The sandbox capability is generically useful (any agent workload can claim
> an isolated VM). The Dark Factory is one *consumer* of that capability. Keeping them separate
> means the isolation substrate can ship, be tested, and be reused independently of the factory.

> **Flow D — a second substrate.** Flow A's isolation boundary is a **Kata micro-VM pod** on a
> platform-owned nested-virt node group. **Flow D** offers an *alternative* Flow-A substrate — an
> **AWS Lambda MicroVM** (serverless micro-VM, no node group) provisioned via the ACK `lambdamicrovms`
> controller and composed by a single **KRO `ResourceGraphDefinition`**. Flow B is unchanged and can
> target either substrate through the same `SandboxClaim` contract. See
> [§4.5](#45-flow-d--lambda-microvm-substrate-alternative-to-flow-a) and
> [`diagrams/flow-d-microvm-sandbox.md`](diagrams/flow-d-microvm-sandbox.md). *(Flow C is reserved for
> other work.)*

> **Why the hub, not a spoke?** The Dark Factory is a **pre-dev build/author** activity: it *writes*
> code and needs GitHub write access. That belongs on the **hub — the control/build plane** — not on
> a spoke, which is the **deploy/run plane** hosting real enterprise workloads (putting a
> GitHub-write-capable author of untrusted code next to running apps is the wrong placement). The
> factory's output — *merged, reviewed* code — then flows to the spokes as a normal deployment, which
> is the right place for deployment-time security/DevOps gating. Co-locating the sandbox pool with
> Argo Workflows on the hub also keeps orchestration **single-cluster**: the workflow watches the
> coder pod and eval Job directly, owner-references cascade teardown, and no cross-cluster control
> plane is needed. The **Kata micro-VM is the isolation boundary** and travels with the workload —
> so "on the hub" is safe *provided* the control-plane-specific hardening in [§10](#10-security-model)
> is in place (dedicated tainted kata nodegroup + egress lockdown that denies the hub's own
> control-plane services).

---

## 3. Flow A — Agent Sandbox capability (permanent platform feature)

> 📊 **See the fancy diagrams:** [`diagrams/flow-a-sandbox-capability.md`](diagrams/flow-a-sandbox-capability.md)
> (capability architecture + warm-pool state machine).

Shipped as a GitOps addon, enabled exactly like every other platform addon — an ApplicationSet fans
the three agent-sandbox charts (`agent-sandbox-operator`, `agent-sandbox`, `kata-deploy`) onto the
target cluster. The capability is gated to the **hub** via `alwaysSelector`, which is honoured
regardless of the global `useSelectors` flag:

```yaml
# gitops/addons/bootstrap/default/addons.yaml  (per agent-sandbox entry)
alwaysSelector:
  matchExpressions:
    - key: environment
      operator: In
      values: ['control-plane']   # the hub's cluster-secret label → hub-only
```

> **Migration note:** the capability was first proven on **spoke-dev** (gated `environment In [dev]`).
> It is being relocated to the **hub** (`environment In [control-plane]`) so it sits with Argo
> Workflows on the build plane — see [§2](#2-two-flows-at-a-glance) for why, and Phase 2 of the
> implementation plan for the dev→hub cutover (stand up on hub, then prune the spoke-dev pool).

### What the addon installs

| Piece | Source in this repo | Role |
|---|---|---|
| **Sandbox operator + CRDs** (`agents.x-k8s.io` + `extensions.agents.x-k8s.io/v1beta1`) | `gitops/addons/charts/agent-sandbox/upstream/` (vendored v0.5.1, sync-wave 0) | Materializes one Kata-VM pod per `Sandbox`; serves `SandboxClaim`/`SandboxTemplate`/`SandboxWarmPool` + the conversion webhook |
| **Kata runtime (Cloud Hypervisor default)** | `kata-deploy` OCI chart (sync-wave 1) | Installs the containerd handlers on the tainted kata nodes |
| **RuntimeClasses** `kata-clh` · `kata-qemu` | `agent-sandbox/templates/10-runtimeclasses.yaml` (sync-wave 2) | Workload picks its VMM via `runtimeClassName` |
| **`SandboxTemplate` `coder-sandbox`** | `agent-sandbox/templates/20-sandboxtemplate.yaml` | The coder pod spec the warm pool clones (isolation invariants baked in) |
| **`SandboxWarmPool` `coder-warmpool`** | `agent-sandbox/templates/40-sandboxwarmpool.yaml` | Native operator primitive — keeps N idle sandboxes pre-warmed; refills on claim |
| **NetworkPolicy** (egress lockdown) | `agent-sandbox/templates/30-networkpolicy.yaml` | Default-deny egress; allow only DNS + Bifrost + HTTPS — **plus, on the hub, deny the control-plane services** (see [§10](#10-security-model)) |
| **kata-readiness DaemonSet** | `agent-sandbox/templates/15-kata-readiness.yaml` | Removes the `runtime-not-ready` startup taint once kata-deploy is healthy |

### Hub prerequisites (Auto Mode can't host Kata)

The hub runs **EKS Auto Mode + Bottlerocket**, which **cannot** run Kata micro-VMs (same blocker
proven on the Auto-Mode spokes). Hosting the capability on the hub therefore requires a **dedicated,
self-managed nested-virt Managed Node Group** alongside Auto Mode:

| Requirement | Detail |
|---|---|
| **Nested-virt MNG** | `c8i`/`m8i` instances with `cpu_options.nested_virtualization=enabled`, `/dev/kvm` present, `min=0` scale-to-zero. Artifacts in `gitops/addons/charts/agent-sandbox/nodepool/` (`kata-mng.tf` / eksctl / nodeadm userData). |
| **Auto-Mode addon prereqs** | Self-managed nodes get neither CNI nor kube-proxy from Auto Mode — the `vpc-cni` **and** `kube-proxy` EKS addons must be installed or the kata node stays `NotReady` / kata-deploy crashloops. |
| **Tainted + labelled** | Node registers `kata=true:NoSchedule` (workload taint) + `katacontainers.io/runtime-not-ready` (startup taint, removed by kata-readiness), labelled `kata-enabled=true` — so **coder VMs never co-schedule with hub control-plane pods**. |

> These are hard requirements: without the nested-virt MNG the warm pool has nowhere to run; without
> the taint + label + egress lockdown, an untrusted coder VM could land next to — or reach — the hub's
> control-plane services. See [§10](#10-security-model).

> ✅ **As-built (certified on the hub):** the capability was migrated dev → hub via GitOps. A
> `c8i.4xlarge` nested-virt MNG was provisioned, the `vpc-cni` + `kube-proxy` addons installed, and
> the node joined Ready. Verified end-to-end: operator `1/1`, warm pool `3/3`, a `kata-clh` pod runs
> a real micro-VM (guest kernel ≠ host), `SandboxClaim` binds + the pool refills, and the coder is
> blocked from the control plane while Bifrost + public GitHub + DNS work. The old spoke-dev pool was
> torn down.

### Warm pool — instant claims, cheap idle

When the platform finishes deploying, the operator's native `SandboxWarmPool` brings up a **target
buffer of 2–3 idle sandboxes**. A consumer binds to a *ready* VM instantly (no cold boot). Cycling
rules:

- **On claim** → provision a **refill** so the buffer stays at target.
- **On release** → if the pool is above target, **remove** the extra idle sandbox.
- **Idle** sandboxes scale to `replicas: 0` (PVC retained) and resume on demand.

> 💡 **Cost note (industry gotcha):** a literal pool of *parked, running* micro-VMs burns money.
> The consensus mitigation (E2B, Modal, Bedrock AgentCore) is **snapshot/fork-from-template + idle
> reaping**, not idle VMs left running. Implementation should prefer snapshot-restore where the
> Kata VMM supports it, and always pair the pool with aggressive idle TTL reaping. See
> [§9](#9-lifecycle-teardown--cost).

---

## 4. Flow B — the Dark Factory pipeline

> 📊 **See the fancy diagrams:** [`diagrams/flow-b-dark-factory.md`](diagrams/flow-b-dark-factory.md)
> (end-to-end pipeline + detailed sequence + live-status mock).

Runs on the **hub**, orchestrated by **Argo Workflows** (already deployed on the hub, GitOps-managed).
End to end:

1. **Trigger** — an issue labeled `dark-factory` fires a GitHub **webhook** into an **Argo Events**
   Sensor, which submits a `df-run` Workflow. **Dedup:** the workflow is named deterministically
   `df-run-<issue-id>`, so GitHub's duplicate webhook deliveries (retries + rapid re-labels) collide
   (`AlreadyExists`) and are harmless no-ops — **one issue = one in-flight run**. Without this, each
   delivery spawned a competing run that force-pushed its own commit and split the `dark-factory/*`
   statuses across SHAs. *(Argo Events is the native Kubernetes eventing path; a thin GitHub Action →
   `argo-server /api/v1/events` is the fallback if Argo Events isn't enabled.)*
2. **Claim** — the workflow's `claim` step creates a `SandboxClaim(warmPoolRef: coder-warmpool)` and
   **binds a warm sandbox**; the operator refills the buffer. Because Argo and the pool are on the
   **same cluster**, the step watches the claim's `status.conditions[Ready]` directly — no
   cross-cluster control needed.
3. **Code** — the issue is written into the sandbox as `/workspace/SPEC.md`. The **pluggable
   coder** (Claude Code headless by default; Kiro headless as a profile) implements on branch
   `df/issue-<n>` and **builds + runs unit tests until green** inside the Kata VM, then pushes the
   branch. The coder holds only `contents:write` — it does *not* open the PR.
4. **PR opens (after green)** — the workflow reads the coder's result locally (completed pod +
   `/workspace/artifacts/result.json`) and **the workflow opens the PR** once tests are green. Before
   this point, status lives on the **issue**; from here on the canonical status board is the **PR**.
5. **Independent verification** — *parallel* DAG steps, driven by the workflow, **never by the coder**
   (see [§6](#6-independent-verification-the-heart-of-the-pattern) and
   [diagram B.4](diagrams/flow-b-dark-factory.md#b4--the-df-run-dag-as-built--how-step-gating-works)).
   Each step runs **outside** the coder in a trusted hub pod and is gated by a `when:` condition on a
   prior step's output (Argo skips it if the condition is false — deterministic, not agentic):
   - **Holdout gate** ✅ *built* — a hub-side step (scenarios in a ConfigMap the credential-less coder
     cannot fetch) runs hidden BDD scenarios' **executable tests** (the un-gameable signal) plus a
     **different-family Nova judge** that catches *gaming*; ≥90% to pass. Gated `when: pr-number != ""`.
   - **Security review** — the **AWS Security Agent** (managed, read-only on the diff) as the primary
     backend; an optional **Fable-5 deep-security sandbox** (a *second* isolated Kata VM) as a gated
     deep tier.
   - **DevOps review** — the **AWS DevOps Agent** (or a Fable-5 reviewer / IaC linters) for
     reliability, deployability, cost, observability, and IaC correctness. Advisory in v1.
   - **Deploy-test** *(P4, conditional)* — for PRs that touch deployable artifacts (a `detect-deployable`
     step greps the diff for `Chart.yaml`/`k8s/`/`Dockerfile`), a **trusted** step deploys to an
     ephemeral namespace, probes it, and tears it down. This is the only step that holds **K8s access**
     — never the coder. Its probes are ground truth; the DevOps agent is the advisory second opinion.
6. **Gate + live status** — a `gate` step aggregates the findings; each step upserts the **one sticky
   PR comment** ⏳→✅/❌ with timestamps and log/trace links (single writer = the workflow, serialized
   by a per-issue mutex — see [§7](#7-live-status-in-the-pr)).
7. **Human review** — a human reviews the **evidence** (test results, holdout %, security/devops
   findings) and either approves or comments. The `df-run` workflow ends here (PR labelled
   `df/awaiting-approval`); the human's response arrives as a *new* event.
8. **Iterate** — a PR comment fires the Sensor → a `df-iterate` workflow resumes the scaled-to-zero
   sandbox (**same retained workspace PVC**) and the coder applies the change. **Bounded to N rounds**,
   then a human breaks the tie (see [§8](#8-human-in-the-loop--the-iterative-comment-loop)).
9. **Merge + teardown** — a PR *review approved* event fires a `df-merge-teardown` workflow: it merges
   the PR (the agent **never** self-merges — merge only follows an explicit human approval event),
   then its `onExit` handler deletes the sandbox, PVC, and eval Job. A **reaper CronJob** sweeps
   abandoned/timed-out runs as the crash-net.

### Orchestration: Argo Workflows on the hub

The orchestrator is **Argo Workflows**, not a bespoke long-running service. Each issue/comment/review
event submits a **short-lived Workflow** (`df-run`, `df-iterate`, `df-merge-teardown`) keyed on the
issue id — durable state lives in the retained workspace PVC + GitHub + a per-issue state ConfigMap,
not in a parked process. This buys per-issue isolation, concurrency (bounded by a semaphore against
the kata nodepool capacity), retries, a durable run history, native Prometheus metrics, and the Argo
UI — the substrate for scaling across many concurrent issues.

> The earlier **P1 Node orchestrator** has been **removed** — its claim/coder/sticky-comment logic is
> now the `df-run` DAG's steps (a `resource` template creates the `SandboxClaim`, a `script` step
> polls GitHub, `onExit` tears down). Only the **coder image** remains under
> [`examples/dark-factory/coder/`](../../examples/dark-factory/coder/).

### Two worked use-cases

| Issue example | How it's tested | Teardown |
|---|---|---|
| *"Add a `weather-agent` to the examples"* | Deploy into an **ephemeral namespace** on the hub → run holdout scenarios → delete namespace | Namespace + branch artifacts |
| *"Build an EKS cluster with X"* | **Dry-run / crossplane-render** by default; a `deep-test` label spins a **real ephemeral `PlatformCluster`** (appmod-blueprints composition) | Delete the `PlatformCluster` claim |

---

## 4.5. Flow D — Lambda MicroVM substrate (alternative to Flow A)

> 📊 **See the diagrams:** [`diagrams/flow-d-microvm-sandbox.md`](diagrams/flow-d-microvm-sandbox.md)
> (substrate architecture + platform/app ownership split + the RuntimeClass-shim bridge).

Flow A's isolation boundary is a **Kata micro-VM pod** on a platform-owned nested-virt node group.
**Flow D is a second Flow-A substrate**: an **AWS Lambda MicroVM** — a *serverless* micro-VM with no
node group to run or pay for while idle, per-claim lifecycle, and sub-second warm starts. Flow B is
unchanged: it still creates a `SandboxClaim`, a pod still shows up, and the **same `dark-factory-coder`**
runs its coding/testing loop — except the coder executes inside a Lambda MicroVM. *(Flow C is reserved
for other work; this substrate is Flow D.)*

### How it's built — KRO RGD over ACK primitives

| Layer | Mechanism | Notes |
|---|---|---|
| **Composition** | **Managed KRO** (EKS Capability) + one `MicrovmSandbox` `ResourceGraphDefinition` | One CR expands into all primitives below |
| **GA primitives** | **Managed ACK** (EKS Capability) — `iam` Role, `s3` Bucket | AWS-run; the image store + build/exec roles |
| **MicroVM primitives** | **Self-managed ACK** — the pre-GA `lambdamicrovms` controller | `MicrovmImage` + `Microvm` CRDs (`lambdamicrovms.services.k8s.aws/v1alpha1`) |

> **Why self-managed for the MicroVM controller?** Managed ACK bundles only controllers whose service
> is **GA upstream** (see the [ACK community services / GA list](https://aws-controllers-k8s.github.io/community/docs/community/services/)).
> `lambdamicrovms` is **pre-GA** (`v1alpha1`, not on that list), so it isn't in Managed ACK yet — it
> runs as its own GitOps addon. **Managed ACK + self-managed lambdamicrovms coexist** (different CRD
> groups → no conflict). When `lambdamicrovms` goes GA, delete the self-managed addon and Managed ACK
> adopts it — **the RGD is unchanged**. This "install both now" posture is deliberate and futuristic.
>
> The **Managed KRO + Managed ACK capabilities themselves** are enabled at the platform layer in the
> **appmod-blueprints** repo (an EKS Capability toggle) — see that repo's
> `docs/EKS-Capabilities-KRO-ACK-Setup.md`. This repo owns only the **self-managed `lambdamicrovms`
> controller + the KRO `MicrovmSandbox` RGD + the sandbox shim** (Flow D).

### Platform-owned vs app-owned (encoded in the two ACK CRDs)

- **Platform owns the image/substrate** — declarative, ACK-managed: `MicrovmImage`
  (`baseImageARN`, `buildRoleArn`, `codeArtifact.uri` in S3, egress connectors). The image is built
  **from the existing `dark-factory-coder` image** + its `entrypoint.js`.
- **App teams own the instance lifecycle** — `Microvm` (`imageIdentifier`, `executionRoleArn`,
  `ingress/egressNetworkConnectors`, `idlePolicy{autoResumeEnabled, maxIdleDurationSeconds,
  suspendedDurationSeconds}`) — created per claim, torn down with it.

The single `MicrovmSandbox` RGD surfaces both halves so each owner sets its own fields, while
consumers see just one CRD.

### The RuntimeClass shim (claim → pod → MicroVM)

A literal K8s `RuntimeClass` (like `kata-clh`) maps to a **node-local containerd handler**; Lambda
MicroVM is a **remote AWS service**, so a true node-level RuntimeClass would require a virtual-kubelet
provider (a large Go runtime — **out of scope**). Flow D instead ships a **`lambda-microvm`
SandboxTemplate variant** whose pod is a lightweight **bridge**: it applies the `MicrovmSandbox` CR,
then **streams the MicroVM's logs into the pod** and maps lifecycle (pod Running ⇔ `Microvm` RUNNING;
pod exit → `TerminateMicrovm`). To Flow B and the user the UX is identical to Flow A. Interactive
exec/attach passthrough is **best-effort**; full fidelity is a virtual-kubelet follow-up.

### Suspend / resume (Sandbox CRD)

Because the substrate is a Lambda MicroVM (not a pod), Flow D gives you **declarative
suspend/resume through the Agent Sandbox CRD**: set `Sandbox.spec.operatingMode: Suspended` and a
small **`microvm-lifecycle`** reconcile loop calls `suspend-microvm` (and `resume-microvm` on
`Running`) by the MicroVM id — the VM's state is retained across the cycle, and the `MicrovmSandbox` is
kept (torn down only on real claim end). The ACK `Microvm` CR has no suspend field, so this loop
supplies the missing intent→SDK translation — pure shim, no virtual-kubelet. See
[`diagrams/flow-d-microvm-sandbox.md` §D.3a](diagrams/flow-d-microvm-sandbox.md).

### Delivery & status

Shipped as GitOps, **disabled by default** (like the kata nodepool): a `microvm:` values block gates
the RGD + SandboxTemplate + self-managed controller addon; the hub overlay carries cluster-specific
values. The platform-capability enablement (Managed ACK + Managed KRO) lands separately in the
**appmod-blueprints** platform repo (they're EKS Capabilities, like the Managed ArgoCD the hub already
runs). This PR delivers the **design + GitOps scaffold**; the live end-to-end path (enable capabilities
→ sync controller → run a MicroVM coder) is the follow-up.

---

## 5. The pluggable coding assistant

The coder is behind a **thin, swappable interface** — a deliberate choice (the industry lesson is
*don't marry a single vendor*). Two profiles ship; both run **inside** the Kata sandbox and reach
models only through the **Bifrost** LLM gateway.

| Profile | Why | Notes |
|---|---|---|
| **A — Claude Code headless** *(primary)* | Purpose-built for autonomous implement→build→test→git loops; proven headless/CI autonomy | `CLAUDE_CODE_USE_BEDROCK` / base-URL → Bifrost; strongest multi-file + shell |
| **B — Kiro headless** | **Spec-driven** (`spec → requirements → design → tasks`) — the most natural fit since *an issue is a spec*; supports a headless GitHub Actions mode | AWS-native; documented as the second profile |

### The coder contract (drop-in interface)

Everything crosses the boundary as **files + env**, so swapping profiles is one config line:

```
INPUTS  (mounted into the sandbox)
  /workspace/SPEC.md          # the issue, as a spec
  /workspace/repo/            # the checked-out target repo (branch df/issue-<n>)
  /workspace/RETRY.md         # (optional) one-line failure reasons from a prior holdout run
  tmpfs: bifrost-api-key      # mode 0400, read then unset — never in env
  tmpfs: gh-token             # short-TTL, mode 0400
ENV
  CODER_PROFILE=claude-code|kiro
  BIFROST_URL=http://bifrost.bifrost.svc:8080
OUTPUTS  (produced by the coder)
  git branch df/issue-<n> with commits
  /workspace/artifacts/result.json   # what changed, build/test logs, evidence links
```

> The holdout scenarios are **deliberately absent** from this list — the coder never receives them.
> See [§6](#6-independent-verification-the-heart-of-the-pattern).

---

## 6. Independent verification (the heart of the pattern)

This is the part most teams skip — and it's why their agents learn to *game the tests*. Two
independent checks run **outside** the coder's control.

### 6.1 Holdout gate — train/test separation for code  ✅ *built (P2, advisory)*

Acceptance criteria are **plain-English BDD scenarios**, each paired with an **executable test**,
stored where the coder **cannot see or edit** them. A separate hub-side step runs them against the
built code. As built, the content lives in the chart under
[`gitops/addons/charts/dark-factory/holdout/`](../../gitops/addons/charts/dark-factory/holdout/) and
renders into **hub ConfigMaps** in the `argo` namespace:

```
holdout/
  evaluate.js                        # the evaluator (→ ConfigMap df-holdout-eval)
  <owner>-<repo>/scenarios.json      # hidden scenarios + executable tests (→ ConfigMap df-holdout-<slug>)
  <owner>-<repo>/rubric.md           # how the judge scores
```

The `holdout-gate` Argo step (see [diagram B.4](./diagrams/flow-b-dark-factory.md#b4--the-df-run-dag-as-built--how-step-gating-works))
clones the coder's `df/issue-N`, diffs it vs base, and runs `evaluate.js`.

**Hard rules (these are the whole point):**

1. **The coder cannot read or write the holdout — enforced by capability, not policy.** The scenarios
   live in a Kubernetes ConfigMap; the coder runs in a Kata VM with **no K8s API access**
   (`automountServiceAccountToken: false`, verified — no token, API times out), so it *cannot fetch
   the ConfigMap even if it tried*. It only ever clones the target repo, never the holdout. On a
   failed run the coder gets only **one-line reasons** (`RETRY.md`) — never the scenario text.
2. **Two signals, both required to pass a scenario:**
   - **The executable test** — run against the built code, this is the **hard, un-gameable** signal:
     it *proves* the behaviour (a `return true` stub cannot pass a real test with unseen inputs).
   - **A different-family LLM judge** — we judge Claude's code with **Amazon Nova**
     (`us.amazon.nova-pro-v1:0`) to defeat self-preference bias (a model scores its own output
     higher). **2-of-3** votes smooth non-determinism.
3. **The judge detects *gaming*, not behaviour.** The test already proves behaviour; asking the judge
   to re-derive it from a diff produced false negatives. So the judge's *only* job is to catch code
   that passes the narrow test **without genuinely implementing it** — hard-coded example inputs,
   lookup tables, `return true`, reaching the grading path — defaulting to PASS. It only sees
   scenarios whose test already passed.
4. **Gate = ≥90%** of scenarios pass (test-green **and** judge-quorum). Posts a `dark-factory/holdout`
   commit status. **Advisory in v1** (`holdout.blocking=false`) — reported, not enforced; flip to
   `blocking: true` to gate the workflow.

> This mirrors ML holdout sets and is directly validated by StrongDM's "Software Factory," which
> found *"`return true` is a great way to pass narrowly written tests"* and fixed it by storing
> scenarios **outside** the codebase.
>
> **Verified both directions (2026-07-15):** honest `subtract` → all 4 hidden tests green, judge
> confirms no gaming → **4/4 (100%) gate passed**. A hard-coded-lookup stub → tests with unseen
> inputs go RED, and on the one narrow test it passes the judge votes 0/3 catching the lookup table →
> **0/4 gate FAIL**. Neither signal alone is the gate; together they resist gaming.

### 6.2 Reviews — the REAL AWS Frontier Agents (DevOps → Security)  ✅ *built*

The reviews are the **genuine managed AWS agents** — **AWS DevOps Agent** and **AWS Security Agent**
(AWS Continuum / Frontier Agents). Not linters, not a Nova stand-in, not a stub. They run **outside
the coder VM** (the coder never grades itself) and are **ordered**, matching the AI-DLC model:

```
coder implements  →  AWS DevOps Agent (broad, FIRST)  →  clears?  →  label `needs-security-review`
                                                                        ↓
                       AWS Security Agent (narrow/strict, SECOND, gated on the label)  →  both clear → merge
```

| Agent | Order | Scope | How it's invoked |
|---|---|---|---|
| **AWS DevOps Agent** — Release Readiness code review | **1st (broad)** | cross-repo dependency risk, standards compliance, access-control correctness, build+test in an AWS-managed env → **BLOCK / Proceed with Caution / Safe to Release** | **GitHub App** auto-reviews the PR and posts a check-run (`devopsAgent.gate: check`, default). The df-run `devops-gate` step **waits** for that check, then applies `needs-security-review`. *(No headless code-review API exists; the coding-agent plugin is a `label`-mode fallback — see the manual-step note.)* |
| **AWS Security Agent** — code security review | **2nd (narrow)** | OWASP Top 10, hardcoded secrets, IAM misuse, dependency risk | **Dual-path (both run, redundant by design):** (1) **headless** — the `security-agent` step clones read-only, stages `{source archive, unified diff}` in S3, calls `securityagent create-code-review → start-code-review-job → list-findings` via the workflow's **IRSA** role, maps findings to `dark-factory/security` + a relayed PR comment (no GitHub App, no OAuth); (2) **`aws-security-agent` GitHub App** — once installed on the repo, auto-reviews every PR and posts **inline findings as `aws-security-agent [Bot]`** (like the DevOps Agent App). `merge.js`/`status.js` read the App's real check (`securityAgent.app.checkRunName`) so a Security **BLOCK** gates the merge. See `docs/dark-factory/AGENT-INSTALL.md`. |

**Why the split matters (verified live 2026-07-16):**
- The **Security Agent path is 100% GitOps + headless** — proven end-to-end against the real service:
  a flawed sample (`hardcoded AWS key + SQL injection + wildcard IAM`) returned exactly
  `DEFAULT_CREDENTIALS (HIGH)`, `SQL_INJECTION (HIGH)`, `PRIVILEGE_ESCALATION (CRITICAL)`. The
  committed `scripts/security-agent.sh` drives that same chain and was validated against the live API.
- The **agent space + application** are reconciled **once** by an idempotent ArgoCD **PreSync Job**
  (`scripts/bootstrap-agentspace.sh`), which writes their IDs into a Secret the review step reads. Only
  the **per-PR code-review + job** are created per run. IAM (IRSA role, service role, S3 bucket, OIDC
  provider) is committed Terraform in **`iam/securityagent.tf`** — the chart *consumes* ARNs, never
  mints IAM.
- **v1 = advisory** (`securityAgent.blockLevel: none`) — findings are reported, never fail the run.
  Raise `blockLevel` to `low|medium|high|critical` to **block** on a finding at/above that risk level.

> **⚠️ The one manual, non-GitOps step (flagged, never faked).** Both agents need a **one-time console
> connect** of the GitHub repo to the Agent Space (an OAuth grant no tool can script). For the
> **Security Agent** this is optional — the headless diff API needs no repo connect. For the **DevOps
> Agent** it's required (its review only runs via the GitHub App / plugin / chat). Until it's done, the
> `devops-gate` reports **not-cleared** and the Security Agent step is **skipped** — the pipeline
> **never fakes a DevOps pass**. Connecting the repo (≈5 min in the AWS DevOps Agent console) is the
> single manual action in the whole pipeline.

**Engine parameterization (coder).** The coder VM runs either engine via `coder.engine`:
`claude` (Claude Code `claude -p`, default + tested) or `kiro` (Kiro CLI `kiro run --headless`). Both
are first-class; the image (`examples/dark-factory/coder/Dockerfile`) carries both CLIs
(`KIRO_CLI_URL` build-arg pins the Kiro artifact). `entrypoint.js` branches on the engine.

> **Why the workflow invokes them, not the coder:** it keeps the untrusted sandbox
> **credential-less** and preserves *separation of concerns* — the agent doing the work is not the
> one grading it (see the [lethal-trifecta gotcha](#11-industry-alignment--anti-patterns-what-the-world-agrees-on)).
> This is also why security testing is a **separate step, not folded into the coding assistant**: a
> coder that ran its own security scan would grade its own work and could be prompt-injected into
> suppressing findings.

---

## 7. Live status in the PR  ✅ *built*

The human **watches the factory work** through **two coordinated surfaces on the PR** — no comment
spam, one canonical board.

**1. Commit statuses = the live check surface (per-step, verifiable).** Each step posts a GitHub
**commit status** on the PR head SHA as it finishes — the coder posts `dark-factory/implementation`,
and the hub-side verify steps post `dark-factory/{holdout,security,devops}`. These render as the PR's
**Checks** and roll up into a single combined state. Because they're pinned to the exact SHA, they're
tamper-evident evidence, not prose.

**2. The PR body = the one sticky status board (marker-managed).** The coder opens the PR with a
`<!-- dark-factory:status -->` marker block; since it opens the PR *before* verification runs, it can
only mark the checks **running**:

```markdown
### 🏭 Dark Factory — verification
- ✅ Build + unit tests: implemented, built + tests green
- ⏳ Holdout gate: running…
- ⏳ Security review: running…
- ⏳ DevOps review: running…
```

The workflow's **`sticky-status` step** (`review/status.js`) runs *after* every verify step, reads
the authoritative `dark-factory/*` commit statuses back from GitHub, and **rewrites the marker block
in place** with the real verdicts + overall state:

```markdown
### 🏭 Dark Factory — verification
- ✅ Build + unit tests: implemented, built + tests green
- ✅ Holdout gate: holdout 4/4 (100%) — gate passed
- ✅ Security review: security: no findings
- ✅ DevOps review: devops: no findings

_Overall: **success**. … Awaiting human review._
```

**Single writer, idempotent.** Only the workflow rewrites the block (never the coder); it regenerates
the block from the commit statuses each run, so re-runs and the per-issue mutex never produce
duplicate or racing edits. Commit statuses are the source of truth; the body is the human-readable
rollup. *(Future: link each line to raw logs / the Argo run / the Langfuse trace —
verifiability-by-citation.)*

---

## 7a. Success metrics (Argo/GitOps-native)

Platform success is measured the same GitOps-native way everything else is — no bespoke telemetry.
Each workflow declares Prometheus metrics via Argo's `metrics:` blocks (scraped by the hub's
kube-prometheus-stack); a `grafana_dashboard`-labelled ConfigMap renders them, and **Langfuse** (on
the hub) captures the LLM-level token/cost/latency traces for per-issue drill-down.

**Built (P4):** `df-run` emits `df_runs_total{status}` and `df_run_duration_seconds` (lead-time proxy)
via its `metrics:` block (`metrics.enabled`). The richer per-signal metrics below and the Grafana
dashboard ConfigMap are the next increment.

| Metric | Meaning | Status |
|---|---|---|
| `df_runs_total{status}` | df-run outcomes by status (throughput + outcome mix) | ✅ built |
| `df_run_duration_seconds` | df-run wall-clock (lead-time proxy) | ✅ built |
| `df_claim_latency_seconds` | `SandboxClaim` create → Ready (warm-pool health) | ⬜ next |
| `df_holdout_pass_pct` | Holdout satisfaction per run | ⬜ next |
| `df_iteration_rounds` | Human comment loops per issue (convergence) | ⬜ next |
| `df_vm_minutes` | Kata VM lifetime per run — the cost proxy | ⬜ next |
| `df_teardown_success` | Teardown completed (leak detection) | ⬜ next |
| change-failure rate | merged `df` PRs later reverted (post-merge signal) | ⬜ next |

> This mirrors the Dark Factory deck's **Metrics & Cost Attribution** model: token counters →
> cost-tier routing → computed signals (items/hour, cycle time, queue depth) surfaced on a status
> API. Here the "status API" is Prometheus + the Argo UI + the sticky PR comment.

---

## 8. Human-in-the-loop & the iterative comment loop  ✅ *built (P3b)*

Level 3 means the **human approves the merge** — and can steer via comments:

- **Comment → revision (`df-iterate`).** A human comment on a Dark Factory PR fires the Argo Events
  Sensor (`pr-commented` dependency: `issue_comment` created, on a PR, **non-bot** — so the factory's
  own sticky/status comments can't self-trigger a loop). It submits a **`df-iterate` workflow** that
  resolves the PR → `df/issue-<n>` → issue number, then re-submits **`df-run`** with `iterate-note` =
  the comment. `df-run` injects it as `DF_ITERATE_NOTE`; the coder **checks out the existing branch**
  (building on prior work — no PVC needed), appends the note to `SPEC.md`, revises, and force-pushes
  → the same PR updates in place and re-verifies. *(Verified: "add multiply" comment → coder kept
  `subtract` and added `multiply` in a new commit on the same branch.)*
- **Bounded convergence:** capped at `iterate.maxIterations` rounds (default 3), tracked by a
  `df-iterations/<n>` label on the PR (stateless across workflows); past the cap `df-iterate`
  comments that a human must break the tie. Each revision is deduped by the comment id
  (`df-iterate-<comment-id>`), and each round's run by `df-run-<issue>-i<round>`.
- The agent **never self-merges**; it only pushes to its own `df/issue-<n>` branch. Merge happens
  only in the `df-merge-teardown` workflow, and *only* in response to a genuine **human PR-approval
  event** (`pr-approved`) — there is no path where the pipeline's own output produces an approval
  (GitHub also blocks author self-approval). Branch protections and CI still apply.

---

## 9. Lifecycle, teardown & cost

| Phase | Sandbox state | Cost posture |
|---|---|---|
| Idle in warm pool | `replicas: 0` or snapshot | Minimal (no running VM) |
| Claimed / coding | `replicas: 1` | Active VM billed |
| Awaiting review | **`replicas: 0`** (PVC kept) | Minimal — resumes on comment |
| Merged / closed | **Deleted** (Sandbox + PVC + test infra + eval job) | Zero |

- **Scale-to-zero between activity** keeps the (possibly long) review window cheap.
- **Teardown happens two ways (both built):** (1) every `df-run` has an **`onExit` handler** that
  releases its `SandboxClaim` on success *or* failure (pool refills); (2) on human approval,
  **`df-merge-teardown`** squash-merges the (green-verified) PR, deletes the coder branch, and reaps
  the claim by its `dark-factory.io/issue-number` label. Because Argo and the pool are co-located on
  the hub, owner-references cascade cleanup for in-workflow-created objects.
- **Merge is human-gated, never self-merge.** `df-merge-teardown` fires *only* from a
  `pull_request_review` **approved** event on a `df/issue-*` branch, and `merge.js` re-checks that
  every `dark-factory/*` status is `success` before merging — so a stray approval on a red PR can't
  land. (GitHub also blocks the PR author from approving their own PR, so the approver is necessarily
  a different human.)
- **Reaper CronJob** ✅ *built* — runs every 15 min (`reaper.schedule`) as a narrowly-scoped SA,
  sweeping **stale ephemeral deploy-test namespaces** (`dark-factory.io/ephemeral=true`) and
  **abandoned `df-run` `SandboxClaims`** older than `reaper.reapAfterSeconds` (3h) with no live
  workflow. The crash-net behind the per-run `onExit` teardown and the claim's own TTL.
- **Conditional deploy-test** ✅ *built (P4)* — for PRs that touch deployable artifacts
  (`detect-deployable` greps the GitHub compare API for `Chart.yaml`/`k8s/`/`Dockerfile`), a
  **trusted** step creates an **ephemeral namespace**, applies `deployTest.manifestPath`, waits for
  workloads to become `Available` (and flags crashloops), then **tears the namespace down via a
  `trap`** — always, even on failure. It is the **only step that holds K8s access** (a scoped
  ClusterRole: namespaces + workload kinds, no secrets/RBAC), bound to the workflow SA — never the
  coder. Posts `dark-factory/deploy-test`; advisory in v1 (`deployTest.blocking=false`). *(Verified:
  a PR adding a `k8s/hello.yaml` nginx Deployment deployed Ready into `df-test-14-…` and was reaped.)*
- **Ephemeral EKS test targets** (`deep-test` `PlatformCluster`) remain a **label-gated later tier**
  (they provision a real cluster, ~15–20 min); the built default is the in-cluster ephemeral namespace.

---

## 10. Security model

Untrusted, LLM-generated code + issue text from anyone = treat the whole sandbox as hostile.

- **Hardware isolation:** every coder runs in a **Kata micro-VM** (own kernel), not a shared-kernel
  container. The isolation boundary is the VM — it travels with the workload regardless of host
  cluster.
- **No cloud credentials in the sandbox:** the coder holds only a **Bifrost API key** and a
  **short-TTL GitHub token (`contents:write` only)** via **projected tmpfs (mode 0400)** — read then
  unset, never in env. All AWS IAM lives with the **Argo workflow orchestrator, outside the VM**. The
  coder pushes a branch; the *workflow* opens the PR and does the merge.
- **Egress lockdown:** a **NetworkPolicy** default-denies egress and allows only **DNS + Bifrost:8080
  + GitHub/HTTPS**. `automountServiceAccountToken: false`, runAsNonRoot, seccomp `RuntimeDefault`,
  drop `ALL` caps.

**Running on the hub — the three-layer control-plane isolation (verified live).** Because the sandbox
pool is co-located with the hub's control-plane services (Keycloak, ArgoCD, external-secrets, Argo),
a single egress NetworkPolicy is **not** sufficient — and on EKS it is also *incomplete* (see the
CNI note below). The hub deployment enforces isolation in **three independent layers**, all certified
against a live coder pod:

1. **Standard `NetworkPolicy`** (`30-networkpolicy.yaml`) — default-deny egress; allow only DNS +
   Bifrost:8080 + public HTTPS with all RFC-1918 + link-local (incl. IMDS `169.254.169.254`)
   excepted, so pod-IP egress to the control plane is blocked.
2. **Admin-tier `ClusterNetworkPolicy`** (`31-clusternetworkpolicy.yaml`) — a `Deny` on egress to the
   control-plane namespaces. Needed because EKS VPC-CNI standard NetworkPolicy *only applies to
   Deployment-owned pods*, and coder pods are owned by a **`Sandbox` CR** — the Admin tier applies
   regardless of ownership and is evaluated first (Deny wins).
3. **ClusterIP egress-firewall DaemonSet** (`32-clusterip-egress-firewall.yaml`) — a host-network,
   `NET_ADMIN` DaemonSet on the kata node (in `kube-system`, since the sandbox namespace's `baseline`
   PodSecurity forbids privileged pods) that installs `FORWARD` iptables rules matching
   `conntrack --ctorigdst` (the **original ClusterIP before kube-proxy DNAT**): allow the Bifrost
   ClusterIP, drop the rest of the service CIDR. This closes the CNI gap in the note below.

> ⚠️ **EKS VPC-CNI ClusterIP gap (found + fixed).** Neither standard NetworkPolicy nor Admin
> ClusterNetworkPolicy egress applies to traffic sent to a **Service ClusterIP** — kube-proxy DNATs
> it to a backend pod IP *before* policy evaluation, so control-plane Services (e.g. `172.20.x`) slip
> past the CIDR/namespace denies even though backend **pod IPs are correctly blocked**. Layer 3 (the
> node firewall) is what actually closes this. Verified: before it, `external-secrets` + the API
> server were reachable by ClusterIP; after it, both are blocked while Bifrost + public egress + DNS
> still work.

Plus the always-on basics:

- **Dedicated tainted kata nodegroup:** coder VMs schedule only onto the nested-virt MNG
  (`kata=true:NoSchedule` + `kata-enabled=true`); control-plane pods never land there and vice-versa.
- **No cluster API from the VM:** `automountServiceAccountToken: false`, no RBAC — even if a coder
  opens a TCP socket to a ClusterIP, it has **no credentials** to authenticate (services reject it:
  the external-secrets webhook returns TLS alert 47; the API server rejects unauthenticated calls).
  Layers: Kata VM + no creds + pod-IP deny (2 tiers) + ClusterIP node-firewall + service auth.

- **Prod is never a test bed, and neither is a spoke:** the factory runs on the **hub build plane**;
  the spokes are the **deploy/run plane**. Unreviewed agent code never runs next to enterprise
  workloads (spoke) or touches prod — its output reaches the spokes only as *merged, reviewed* code
  through the normal deployment path.
- **⚠️ Lethal trifecta (the #1 risk — see [§11](#11-industry-alignment--anti-patterns-what-the-world-agrees-on)):** untrusted
  issue text + credentials + egress is the exact recipe for prompt-injection exfiltration
  (demonstrated against GitHub-issue-driven agents in the wild). The mitigations above exist
  specifically to break that trifecta: keep credentials out of the issue-ingesting context, deny
  egress (including the hub's own control plane), and treat all issue/repo content as hostile input.

---

## 11. Industry alignment & anti-patterns (what the world agrees on)

We validated this design against how GitHub Copilot coding agent, OpenAI Codex cloud, Devin, Google
Jules, Cursor background agents, Factory.ai, and StrongDM's "Software Factory" actually work.

### ✅ Where we match consensus

| Design choice | Industry practice |
|---|---|
| Issue → event → ephemeral sandbox → build/test → PR | The recurring ~7-stage pipeline across Copilot/Codex/Devin/Jules/Factory |
| **DAG orchestration + concurrent dispatch** (Argo Workflows) | *Convergent pattern.* Stripe/Coinbase/Ramp/StrongDM independently arrived at isolated sandboxes + subagent/DAG orchestration + cost-routing for scale |
| **Kata micro-VM isolation** | *Above-consensus.* microVM-class isolation (Firecracker, Kata, Bedrock AgentCore's per-session microVM) is the defensible choice for untrusted LLM code; shared-kernel containers are considered insufficient |
| Build/test **until green before** the PR | Explicit in codex-1's RL training, Devin, Copilot |
| **Holdout scenarios the coder never sees** | *Above-consensus.* Directly matches StrongDM's Software Factory (they learned it the hard way after `return true` gamed their tests) |
| **One sticky status surface**, not comment spam | Copilot draft-PR + session logs; Devin single review status; Factory "Mission Control" |
| Human **approves the PR**, agent iterates on comments | The dominant gating norm — agents do **not** self-merge by default |
| Single coder + **independent read-only reviewers** | Anthropic + Cognition agree parallel multi-agent *authoring* is a poor fit for coding; the good pattern is one coder + a fresh model reviewing the finished diff (CodeRabbit's Security Agent) |

### ⚠️ Anti-patterns we explicitly design against

1. **Lethal trifecta / prompt injection (highest risk).** Untrusted issue text + cloud creds + egress
   → data exfiltration. Invariant Labs demonstrated a malicious GitHub *issue* injecting an agent
   into leaking private-repo data via an auto-PR. **Our defense:** credentials never in the
   issue-ingesting sandbox context; egress denied except Bifrost/GitHub; issue/repo content treated
   as hostile; frontier agents scoped read-only. *(Willison "lethal trifecta"; Invariant Labs.)*
2. **Reward hacking / test-gaming.** Frontier models stub evaluators (`evaluate = _always_ok`), make
   `verify()` return true, read reference answers, or delete the test oracle (METR, OpenAI,
   Anthropic). **Our defense:** the holdout the coder cannot see or edit — if the coder can reach it,
   the holdout is theater.
3. **LLM-judge as a sole hard gate.** Judges have proven position/verbosity/**self-preference** bias
   (causal — a model favors its own family's output). **Our defense:** different judge model +
   paired executable tests + 2-of-3 + a probabilistic satisfaction score, never a lone boolean.
4. **Multi-agent over-orchestration.** **Our defense:** single-threaded coder; Security/DevOps are
   stateless read-only reviewers on the finished diff, never co-authors.
5. **Non-converging comment loops.** **Our defense:** batch comments into one run, cap iterations,
   hard time/turn limits.
6. **Warm-pool idle burn.** **Our defense:** snapshot/fork + idle reaping + scale-to-zero, not parked
   VMs.
7. **Rubber-stamp reviews.** AI-co-authored PRs carry measurably more issues; "review results not
   code" can decay into a green rubber stamp. **Our defense:** the human reviews *structured
   evidence* (tests + holdout % + security findings + diff-path confinement), and high-risk changes
   (infra, `deep-test`) get a firmer gate.

---

## 12. Phased delivery

Each phase is independently valuable — if you stop after any one, you're better off than before.

| Phase | Delivers | Status | Independently useful? |
|------:|----------|:------:|-----------------------|
| **P0** | **Relocate the sandbox capability to the hub** — nested-virt MNG + control-plane isolation + dev→hub cutover (all GitOps) | ✅ **done** | ✅ Kata warm pool co-located with Argo on the build plane |
| **P1** | First `df-run` **WorkflowTemplate**: trigger → claim warm sandbox → Claude Code coder → build/test → workflow opens PR + sticky status → manual teardown | ✅ **done** | ✅ A working autonomous-PR loop on Argo |
| **P2** | Strict **holdout gate** (hidden scenarios in a hub ConfigMap, executable tests + a different-family Nova judge, ≥90% gate) | ✅ **done** (advisory) | ✅ Quality gate that resists gaming — verified green (honest code 4/4) *and* adversarially (gamed stub 0/4) |
| **P3** | **Security + DevOps review steps** — parallel hub-side reviewers, `auto` backend (linters + Nova), advisory, posting `dark-factory/{security,devops}` statuses (managed AWS-Agent backend swappable in when its API lands) | ✅ **done** (advisory) | ✅ Independent review evidence — verified: clean code 0 findings; adversarial diffs correctly flagged |
| **P3b** | **Full event-driven lifecycle**: trigger dedup (one issue = one run) + live PR-body status + **`df-merge-teardown`** (approval → green-gated squash-merge + teardown) + **`df-iterate`** (PR comment → bounded revision on the existing branch) + coder no-diff guard | ✅ **done** | ✅ Hands-off label→run→verify→PR, comment→revise, approve→merge→teardown — all verified live |
| **P4** | Conditional **`deploy-test`** (gated on `detect-deployable`; ephemeral namespace deploy+probe+teardown, scoped ClusterRole) + **reaper CronJob** + **df-run Prometheus metrics**; *(deep-test `PlatformCluster` tier + Grafana dashboard remain)* | ✅ **done** (core) | ✅ Full lights-off lifecycle + measurement — deploy-test verified (nginx Ready + reaped) |
| **P5** | **Kiro** coder profile; per-severity **blocking** gate option; **Fable-5 deep-security sandbox** (`deep-sec`) | ⬜ planned | ✅ Vendor-plurality + higher autonomy + deep review |

---

## 12a. Running Kata on EKS Auto Mode clusters (validated design)

The hub (like the spokes) runs **EKS Auto Mode + Bottlerocket** (`c6a`/`c6g` nodes). Auto Mode's
managed nodes **cannot host Kata**: no control over `cpuOptions.nestedVirtualization`, no
kernel-module loading (`modprobe kvm_intel`), no `kata-deploy`, and those node types don't expose
VT-x. `eks-platform-openclaw` avoids Auto Mode entirely for this reason — but we don't have to.

> **Applies to the hub.** This design was first validated on spoke-dev, but the mechanism — a
> nested-virt MNG *alongside* Auto Mode — is exactly what the hub relocation requires. The same
> chart artifacts, node bootstrap, and hard-won lessons below carry over verbatim; only the target
> cluster changes (and the hub adds the control-plane egress lockdown from [§10](#10-security-model)).

### Decision: self-managed nested-virt MNG *alongside* Auto Mode

Add a small, tainted **self-managed Managed Node Group** of **nested-virt `c8i`/`m8i`** instances to
the cluster (spoke-dev in the original validation; **the hub** under the current design). Auto Mode
keeps running everything else; kata sandboxes schedule onto the MNG via the `kata=true:NoSchedule`
taint the chart already applies. We chose an **MNG, not a second Karpenter** — running a
self-managed Karpenter beside Auto Mode's managed Karpenter risks NodePool/CRD conflicts, whereas
MNGs are additive and coexist cleanly.

Rejected alternatives: **Bedrock AgentCore / Fargate** (breaks the k8s-native pod model our whole
Sandbox/warm-pool/claim design depends on — it's an invoke-a-session runtime, not a pod we own);
**gVisor** (same Auto-Mode node-install blocker as Kata, weaker isolation).

### ✅ Validated by two live tests (spoke-dev, 2026-07-10)

A `c8i.4xlarge` kata MNG was created on spoke-dev, exercised, then torn down. Results:

| Question | Result |
|---|---|
| Self-managed MNG coexists with Auto Mode? | **✅ Yes** — MNG provisioned alongside Auto Mode nodepools, no conflict; Auto Mode stayed healthy |
| Nested virtualization / `/dev/kvm`? | **✅ Yes** — `/dev/kvm` present, `kvm_intel` loaded, 32 `vmx` flags, via `CpuOptions.NestedVirtualization: enabled` |
| Node joins the cluster & goes Ready? | **✅ Yes** — with the fixes below (nodeadm endpoint/CA + vpc-cni + kube-proxy) |
| Kata runtime install (kata-deploy)? | **✅ Yes** — `1/1`, zero restarts, once `kube-proxy` was installed |
| **Real Kata VM runs?** | **✅ YES** — pod under `kata-clh` had guest kernel `6.18.35` vs host `6.12.90` = true hardware VM isolation |

### Hard-won lessons (baked into the implementation)

1. **Node bootstrap** — do **not** override the AMI + userData with plain bash; that clobbers the
   EKS bootstrap and the node boots (`/dev/kvm` present) but never joins. Use the **AL2023 nodeadm
   MIME userData**, and set nested-virt via the launch-template `CpuOptions`, not userData.
2. **Teardown ordering** — delete the **MNG first and let it drain** (set min/desired=0 first).
   Terminating the instance out from under the MNG makes the ASG respawn and can wedge the delete on
   a `Pending:Wait` lifecycle hook; recover with `terminate-instance-in-auto-scaling-group` +
   `complete-lifecycle-action`.
3. **Custom-AMI nodeadm needs cluster coordinates** — with a custom `ImageId`, nodeadm can't
   auto-discover the API; you must set `apiServerEndpoint` + `certificateAuthority` + `cidr` in the
   NodeConfig, or it fails "Apiserver endpoint is missing in cluster configuration".
4. **Auto Mode has no `vpc-cni`** — self-managed MNG nodes stay `NotReady` (`cni plugin not
   initialized`) until you install the `vpc-cni` EKS addon. `aws-node` tolerates all taints and
   schedules onto the kata node once installed.
5. **kata-deploy on Auto Mode (open item)** — the upstream kata-deploy chart defaults to the
   **experimental nydus snapshotter** (`EXPERIMENTAL_SETUP_SNAPSHOTTER=nydus`), which restarts
   containerd and briefly drops CNI networking; kata-deploy then fails its own API call
   (`Failed to get node ... client error (Connect)`) and crashloops before installing the runtime.
   Fix to apply next: disable the experimental nydus snapshotter (openclaw uses overlayfs) and/or
   raise kata-deploy's API-retry tolerance. Everything *up to* the runtime install is proven; the
   runtime install itself needs this one chart-tuning fix.

Also fixed during testing: the kata-deploy Helm values are **top-level** (`nodeSelector`,
`tolerations`, `shims`) for a direct install — the nested `kata-deploy:` key only applies when it's
a subchart. Our catalog entry uses the nested form (correct, since ArgoCD deploys it as its own
app), but a direct `helm install` must use top-level values.

---

## 13. Open questions / future work

*To resolve during implementation — flagged honestly rather than assumed:*

- **Nested-virt capacity on the hub** — confirm `c8i`/`m8i` availability + headroom for the kata MNG
  alongside the hub control plane; size the warm-pool/semaphore ceiling to it.
- **Exact hub control-plane egress deny list** — the concrete namespaces/service CIDRs (keycloak,
  argocd, external-secrets, argo) to encode in the NetworkPolicy for the hub deployment.
- **Headless auth** for Claude Code & Kiro through a Bifrost base-URL override inside a Kata VM
  (prototype first in P1).
- **Bifrost VK + tmpfs secret projection** — mint a short-TTL GitHub token + Bifrost virtual key and
  project them onto the claimed sandbox (mode 0400). Documented but not yet wired — close in P1.
- **Exact AWS Security / DevOps Agent APIs & auth** — confirm the invocation contract at build time;
  clear **Fable-5** provider-data-share / 30-day retention before enabling the deep-sec tier.
- **Workflow RBAC scope** — the Argo workflow SA needs `sandboxclaims` (CRUD) + read `sandboxes` +
  eval `Job`/`ConfigMap` in `agent-sandbox-system`, plus `PlatformCluster` claims for the `deep-test`
  path. No pod/exec, no secrets, no cluster scope.
- **Argo `resource`-template `successCondition` on CRD conditions** — validate the JSONPath filter
  form against Argo v3.6.7, or fall back to a `kubectl wait --for=condition=Ready` step.
- **Workspace access mode** — RWO (EBS) forces strict coder↔eval serialization + same-AZ pinning;
  RWX (EFS) allows read-only eval-alongside and cheaper iteration. Decide before P2.

> ✅ **Resolved since the first draft:** native `SandboxWarmPool` CRD is adopted (custom pool-manager
> CronJob dropped); the upstream operator is vendored into the addon catalog; Kata-on-Auto-Mode is
> validated ([§12a](#12a-running-kata-on-eks-auto-mode-clusters-validated-design)); the sandbox
> capability is being relocated dev→hub (this design).

---

## 14. References

**Pattern sources**
- Steve Yegge — *Welcome to Gas City* — https://steve-yegge.medium.com/welcome-to-gas-city-57f564bb3607
- *The Dark Factory Pattern: Moving From AI-Assisted to Fully Autonomous Coding* — https://hackernoon.com/the-dark-factory-pattern-moving-from-ai-assisted-to-fully-autonomous-coding
- Kiro headless in GitHub Actions — https://builder.aws.com/content/35cLFnKM6DJMgRzdZQ7XPZkJmoz/automate-reviews-in-github-actions-with-kiro-headless-mode

**Industry pipelines**
- GitHub Copilot coding agent — https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/
- OpenAI Codex — https://openai.com/index/introducing-codex/
- Devin SDLC integration — https://docs.devin.ai/essential-guidelines/sdlc-integration
- Factory.ai Missions — https://docs.factory.ai/cli/features/missions/overview
- StrongDM Software Factory — https://factory.strongdm.ai/
- AWS Bedrock AgentCore runtime sessions (per-session microVM) — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.md
- AWS DevOps Agent — https://aws.amazon.com/devops-agent/

**Failure modes / safety**
- Simon Willison — *The lethal trifecta* — https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- Invariant Labs — GitHub MCP prompt-injection exfiltration — https://invariantlabs.ai/blog/mcp-github-vulnerability
- METR — *Recent frontier models are reward hacking* — https://metr.org/blog/2025-06-05-recent-reward-hacking/
- OpenAI — *Detecting misbehavior in frontier reasoning models* — https://openai.com/index/chain-of-thought-monitoring/
- Anthropic — *Reward tampering* — https://www.anthropic.com/research/reward-tampering
- LLM-judge self-preference bias — https://arxiv.org/abs/2404.13076 · MT-Bench — https://arxiv.org/abs/2306.05685
- Cognition — *Don't build multi-agents* — https://cognition.ai/blog/dont-build-multi-agents
- Anthropic — *Claude Code best practices* — https://www.anthropic.com/engineering/claude-code-best-practices

**Platform building blocks (this monorepo & siblings)**
- `eks-platform-openclaw` — Kata micro-VM sandbox, `Sandbox` CRD, session-router lifecycle (uses LiteLLM there; **this platform uses Bifrost** as the LLM gateway)
- `appmod-blueprints` — `PlatformCluster` Crossplane composition (ephemeral EKS), KRO CI/CD pipeline
- `agent-platform-amazon-eks` — hub/spoke fleet, addon ApplicationSets, kagent, agent-gateway, **Bifrost** LLM gateway
