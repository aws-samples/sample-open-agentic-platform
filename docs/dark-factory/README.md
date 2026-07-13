# Dark Factory — Autonomous Agent Coding Pattern

> **Status:** Design document (doc-only). This describes the target architecture, the reuse
> map onto the existing platform, and a phased delivery plan. No runtime code ships in this PR.

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
   Sensor, which submits a `df-run` Workflow keyed on the issue id. *(Argo Events is the native
   Kubernetes eventing path; a thin GitHub Action → `argo-server /api/v1/events` is the fallback if
   Argo Events isn't enabled.)*
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
   (see [§6](#6-independent-verification-the-heart-of-the-pattern)):
   - **Holdout gate** — an isolated eval **Job** runs hidden BDD scenarios the coder can neither see
     nor edit, judged by a **different model**, **paired with executable tests**, ≥90% to pass.
   - **Security review** — the **AWS Security Agent** (managed, read-only on the diff) as the primary
     backend; an optional **Fable-5 deep-security sandbox** (a *second* isolated Kata VM) as a gated
     deep tier.
   - **DevOps review** — the **AWS DevOps Agent** (or a Fable-5 reviewer / IaC linters) for
     reliability, deployability, cost, observability, and IaC correctness. Advisory in v1.
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

> The earlier **P1 Node orchestrator** (`examples/dark-factory/`) is a working reference for the
> claim/coder/sticky-comment logic; under this design its libraries become **Argo workflow
> step-containers**, and the long-running Deployment is superseded by the DAG.

### Two worked use-cases

| Issue example | How it's tested | Teardown |
|---|---|---|
| *"Add a `weather-agent` to the examples"* | Deploy into an **ephemeral namespace** on the hub → run holdout scenarios → delete namespace | Namespace + branch artifacts |
| *"Build an EKS cluster with X"* | **Dry-run / crossplane-render** by default; a `deep-test` label spins a **real ephemeral `PlatformCluster`** (appmod-blueprints composition) | Delete the `PlatformCluster` claim |

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

### 6.1 Holdout gate — train/test separation for code

Acceptance criteria are written as **plain-English BDD scenarios** that live in a location the
coder **cannot see or edit**. A separate evaluator job runs them against the built code.

```
holdout/
  scenarios/*.feature     # hidden acceptance scenarios (never mounted into the sandbox)
  rubric.md               # how the judge scores
```

**Hard rules (these are the whole point):**

1. **The coder cannot read or write the holdout.** Scenarios are never mounted into the sandbox;
   the coder's repo checkout **excludes the grading-test path**. On a failed run the coder gets
   only **one-line reasons** in `RETRY.md` — never the scenario text.
2. **A different model judges.** The evaluator's LLM judge must be a **different model/family than
   the coder** (defeats self-preference bias — a model scores its own output higher).
3. **The judge is never the sole gate.** Every scenario is paired with **executable tests**; the
   LLM judgment is one signal, not the verdict. Each scenario runs **2-of-3** to smooth
   non-determinism. Gate = **≥90%** satisfaction.

> This mirrors ML holdout sets and is directly validated by StrongDM's "Software Factory," which
> found *"`return true` is a great way to pass narrowly written tests"* and fixed it by storing
> scenarios **outside** the codebase.

### 6.2 Review roles — independent, read-only reviewers (Security + DevOps)

The **workflow** (not the coder) runs two independent review roles on the finished diff, as
**parallel DAG steps**. Each role is a **pluggable slot with a swappable backend**, so we're not
locked to any single service's GA status:

| Role | Answers | Primary backend | Fallback backend |
|---|---|---|---|
| **Security** | *"Can this code be attacked?"* — vulns, exploitability, injection, secrets, insecure deps | **AWS Security Agent** (managed, GA — autonomous pentest + validated exploitability) | Fable-5 deep-security sandbox *(deep tier)* |
| **DevOps** | *"Will this code operate well?"* — reliability, deployability, cost, observability, IaC/config correctness | **AWS DevOps Agent** (managed) | Fable-5 DevOps reviewer / IaC linters (cfn-guard, kube-linter, tflint) |

- The managed agents are **out-of-cluster, AWS-managed** services invoked with the **hub
  orchestrator's IAM** — **not** kagent pods, never running in the coder VM.
- They are **read-only reviewers on the finished diff** — never co-authors. Findings are folded into
  the PR report; the coder only *reacts* to them via the comment loop.
- **v1 = advisory** (report-only). Gate hooks are designed so **per-severity blocking** can be
  switched on later (e.g. a critical CVE blocks the PR).

**Optional deep-security tier (gated, later phase).** For reasoning-heavy vulnerability discovery
beyond the managed Security Agent, a `deep-sec`-labelled run spins a **second, isolated Kata sandbox**
running a security agent backed by **Claude Fable 5** on Bedrock (via Bifrost) — read-only on the
diff, its own narrow credential, never sharing the coder's VM. *Note:* **Mythos** proper is
allow-list-gated (defensive-cyber partners only) and not assumed available; **Fable 5** is the
generally-available "Mythos-class" defensive model, and it carries a provider-data-share / 30-day
retention caveat to clear before enabling.

> **Why the workflow invokes them, not the coder:** it keeps the untrusted sandbox
> **credential-less** and preserves *separation of concerns* — the agent doing the work is not the
> one grading it (see the [lethal-trifecta gotcha](#11-industry-alignment--anti-patterns-what-the-world-agrees-on)).
> This is also why security testing is a **separate step, not folded into the coding assistant**: a
> coder that ran its own security scan would grade its own work and could be prompt-injected into
> suppressing findings.

---

## 7. Live status in the PR

The human **watches the factory work** (the Gas City idea) through **one sticky PR comment** the
workflow edits in place — no comment spam, one canonical surface (the pattern Copilot, Devin, and
Factory all converge on).

```
## 🏭 Dark Factory — issue #42
✅ Claimed sandbox (hub)            12:01
✅ Branch df/issue-42               12:01
✅ Implement                        12:04
✅ Build + unit tests               12:07   📄 log
✅ PR opened  #128                  12:07
⏳ Security review…
⬜ DevOps review
⬜ Holdout gate (0/12)
⬜ Ready for review
```

**Two status homes, one canonical board.** Until the coder's tests are green there is no PR, so the
pre-PR acknowledgement (claimed / branch / implementing) lives on the **issue**. Once the workflow
opens the PR (step 4), the sticky comment moves to the **PR** and becomes the canonical board.

**Single writer = the workflow.** Every stage is reported by the Argo workflow (never the coder),
which **upserts one marker-based comment** (`<!-- dark-factory:status -->`) — edited in place. The
parallel review steps (security ∥ devops ∥ holdout) are serialized by a **per-issue mutex** so they
never race on the comment. Each line links to raw logs / the Argo run / the Langfuse trace
(**verifiability-by-citation**). The PR **body** carries the final report: what changed, test
results, holdout satisfaction %, and the Security/DevOps findings.

---

## 7a. Success metrics (Argo/GitOps-native)

Platform success is measured the same GitOps-native way everything else is — no bespoke telemetry.
Each workflow declares Prometheus metrics via Argo's `metrics:` blocks (scraped by the hub's
kube-prometheus-stack); a `grafana_dashboard`-labelled ConfigMap renders them, and **Langfuse** (on
the hub) captures the LLM-level token/cost/latency traces for per-issue drill-down.

| Metric | Meaning |
|---|---|
| `df_lead_time_seconds` | Issue labelled → PR opened (histogram) |
| `df_claim_latency_seconds` | `SandboxClaim` create → Ready (warm-pool health) |
| `df_holdout_pass_pct` | Holdout satisfaction per run |
| `df_iteration_rounds` | Human comment loops per issue (convergence) |
| `df_vm_minutes` | Kata VM lifetime per run — the cost proxy |
| `df_teardown_success` | Teardown completed (leak detection) |
| throughput | `rate(argo_workflows_count{workflowtemplate=~"df-.*", status="Succeeded"})` |
| change-failure rate | merged `df` PRs later reverted (post-merge signal) |

> This mirrors the Dark Factory deck's **Metrics & Cost Attribution** model: token counters →
> cost-tier routing → computed signals (items/hour, cycle time, queue depth) surfaced on a status
> API. Here the "status API" is Prometheus + the Argo UI + the sticky PR comment.

---

## 8. Human-in-the-loop & the iterative comment loop

Level 3 means the **human approves the merge** — and can steer via comments:

- A PR comment (change requested) → the Argo Events Sensor submits a **`df-iterate` workflow** →
  which **resumes the scaled-to-zero sandbox** (same retained workspace PVC, re-bound by the issue-id
  label) → the coder applies the change → pushes → the sticky status updates.
- **Bounded convergence:** the loop is capped at **N rounds** (the counter lives in a per-issue state
  ConfigMap, enforced statelessly across workflows); after that a human must break the tie. Comments
  are **batched into one agent run** (don't fire the agent per un-batched comment — it thrashes).
- The agent **never self-merges**; it only pushes to its own `df/issue-<n>` branch. Merge happens
  only in the `df-merge-teardown` workflow, and *only* in response to a genuine **human PR-approval
  event** — there is no path where the pipeline's own output produces an approval. Branch protections
  and CI still apply.

---

## 9. Lifecycle, teardown & cost

| Phase | Sandbox state | Cost posture |
|---|---|---|
| Idle in warm pool | `replicas: 0` or snapshot | Minimal (no running VM) |
| Claimed / coding | `replicas: 1` | Active VM billed |
| Awaiting review | **`replicas: 0`** (PVC kept) | Minimal — resumes on comment |
| Merged / closed | **Deleted** (Sandbox + PVC + test infra + eval job) | Zero |

- **Scale-to-zero between activity** keeps the (possibly long) review window cheap.
- **Teardown is an Argo `onExit` handler** on the `df-merge-teardown` workflow — it fires on success
  *or* failure, deleting the `SandboxClaim`, PVC, and eval Job. Because Argo and the pool are
  co-located on the hub, owner-references cascade cleanup for in-workflow-created objects.
- **Reaper CronJob** (adapted from openclaw `reaper-cronjob.yaml`) sweeps abandoned/timed-out runs
  by TTL annotation — the crash-net for a workflow that dies before its `onExit` runs, and for
  forgotten PRs.
- **Ephemeral EKS test targets** (`deep-test`) are **gated behind a label** because they cost real
  money and take ~15–20 min to provision; the default path is dry-run/namespace testing.

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

**Running on the hub — the extra hardening that makes it safe.** Because the sandbox pool is
co-located with the hub's control-plane services (Keycloak, ArgoCD, external-secrets, Argo), the
generic egress rule is **not** sufficient on its own — an "allow HTTPS to the internet" rule would
also permit reaching those services in-cluster. The hub deployment therefore adds:

- **Dedicated tainted kata nodegroup:** coder VMs schedule only onto the nested-virt MNG
  (`kata=true:NoSchedule` + `kata-enabled=true`); control-plane pods never land there and vice-versa.
- **Control-plane egress deny:** the NetworkPolicy explicitly **denies** egress to the hub's
  control-plane namespaces/services (keycloak, argocd, external-secrets, argo) **and** to IMDS
  (`169.254.169.254`) — on top of the default-deny + narrow allowlist above.
- **No cluster API from the VM:** `automountServiceAccountToken: false` and no RBAC — the coder
  cannot talk to the hub Kubernetes API at all.

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

| Phase | Delivers | Independently useful? |
|------:|----------|-----------------------|
| **P0** | **Relocate the sandbox capability to the hub** — nested-virt MNG + control-plane isolation + dev→hub cutover (all GitOps) | ✅ Kata warm pool co-located with Argo on the build plane |
| **P1** | First `df-run` **WorkflowTemplate**: trigger → claim warm sandbox → Claude Code coder → build/test → workflow opens PR + sticky status → manual teardown | ✅ A working autonomous-PR loop on Argo |
| **P2** | Strict **holdout gate** (isolated eval Job, different-model judge, executable-test pairing) + bounded `df-iterate` retry | ✅ Quality gate that resists gaming |
| **P3** | **Security + DevOps review steps** (managed AWS Security/DevOps Agents, advisory) folded into the PR report; Argo Events Sensor for approve/comment/merge | ✅ Independent review evidence + full event-driven lifecycle |
| **P4** | Ephemeral test targets (namespace default; `deep-test` `PlatformCluster`) + **`onExit` auto-teardown** + reaper + success-metrics dashboard | ✅ Full lights-off lifecycle + measurement |
| **P5** | **Kiro** coder profile; per-severity **blocking** gate option; **Fable-5 deep-security sandbox** (`deep-sec`) | ✅ Vendor-plurality + higher autonomy + deep review |

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
