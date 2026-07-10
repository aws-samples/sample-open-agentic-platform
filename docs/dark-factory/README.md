# Dark Factory — Autonomous Agent Coding Pattern

> **Status:** Design document (doc-only). This describes the target architecture, the reuse
> map onto the existing platform, and a phased delivery plan. No runtime code ships in this PR.

A **dark factory** is a manufacturing plant that runs *with the lights off* — no humans on the
floor, robots do everything. Applied to software: **a human writes an issue (a spec); AI agents
do the rest** — implement, build, test, security/ops review, open a PR, and (after a human
approves the *results*) merge and tear everything down.

This pattern wires that idea onto the **Open Agent Platform (OAP)** using components the platform
already has: hardware-isolated **Kata micro-VM sandboxes** (from `eks-platform-openclaw`), the
**Bifrost → Bedrock** LLM gateway, the **hub + spoke-dev/spoke-prod** cluster fleet, and
**AWS-managed frontier agents** (Security, DevOps) for independent review.

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
| **Where** | Installed on **spoke-dev *and* spoke-prod** (capability on both) | **Runs only on spoke-dev** (prod pool stays dormant) |
| **Lifecycle** | Long-lived; pool self-heals to a target buffer | Ephemeral per issue; torn down on merge/close |
| **Diagram** | [`diagrams/flow-a-sandbox-capability.md`](diagrams/flow-a-sandbox-capability.md) | [`diagrams/flow-b-dark-factory.md`](diagrams/flow-b-dark-factory.md) |

> **Why split them?** The sandbox capability is generically useful (any agent workload can claim
> an isolated VM). The Dark Factory is one *consumer* of that capability. Keeping them separate
> means the isolation substrate can ship, be tested, and be reused independently of the factory.

---

## 3. Flow A — Agent Sandbox capability (permanent platform feature)

> 📊 **See the fancy diagrams:** [`diagrams/flow-a-sandbox-capability.md`](diagrams/flow-a-sandbox-capability.md)
> (capability architecture + warm-pool state machine).

Shipped as a GitOps addon, enabled exactly like every other platform addon — set a flag, an
ApplicationSet fans it onto the labelled clusters:

```yaml
# gitops/overlays/environments/{dev,prod}/enabled-addons.yaml
enabledAddons:
  enable_agent_sandbox: true      # → ApplicationSet cluster-generator → ArgoCD sync waves
```

### What the addon installs (all reused from `eks-platform-openclaw`)

| Piece | Source in `eks-platform-openclaw` | Role |
|---|---|---|
| **Kata runtime (Cloud Hypervisor default)** | `gitops/helm/kata/` + `kata-deploy` | Hardware VM isolation per sandbox |
| **RuntimeClasses** `kata-clh` · `kata-qemu` · `kata-fc` | `gitops/helm/kata/templates/runtimeclass-*.yaml` | Workload picks VMM via `runtimeClassName` |
| **Karpenter pools** `kata-nested` / `kata-metal` | `gitops/helm/karpenter-nodepools/` | Nested-virt `c8i/m8i` nodes (bare-metal fallback) |
| **`Sandbox` CRD + operator** (`agents.x-k8s.io/v1alpha1`) | `gitops/helm/agent-sandbox/` (sync-wave −1) | One Kata-VM pod per `Sandbox` CR; `replicas 0/1` scale subresource |
| **`SandboxTemplate` / `SandboxClaim`** | `.../agent-sandbox/templates/extensions.yaml` | Claim → template binding (like PVC → PV) |
| **Pool-manager controller** *(net-new)* | — | Maintains the warm buffer; refills on claim; shrinks on release |

> ⚠️ **Import gap:** the `agent-sandbox` operator is not yet packaged as an OAP addon chart. Flow A's
> first implementation task is to import/repackage it from `eks-platform-openclaw` into the OAP
> addon catalog (`gitops/addons/`).

### Warm pool — instant claims, cheap idle

When the platform finishes deploying, the pool-manager brings up a **target buffer of 2–3 idle
sandboxes**. A consumer binds to a *ready* VM instantly (no cold boot). Cycling rules:

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

Runs on **spoke-dev only**. End to end:

1. **Trigger** — an issue labeled `dark-factory` fires a **GitHub Action**. The Action gates on the
   label, mints a **short-TTL** installation token, and calls the orchestrator. *(Net-new — OAP has
   no GitHub Actions today.)*
2. **Claim** — the **orchestrator** (adapting the openclaw `session-router`, but keyed on
   **issue-id** instead of a Cognito `sub`) issues a `SandboxClaim` and **binds a warm sandbox**.
   The pool-manager refills the buffer.
3. **Code** — the issue is written into the sandbox as `/workspace/SPEC.md`. The **pluggable
   coder** (Claude Code headless by default; Kiro headless as a profile) implements on branch
   `df/issue-<n>` and **builds + runs unit tests until green** inside the VM.
4. **Independent verification** *(driven by the orchestrator — never by the coder — see [§6](#6-independent-verification-the-heart-of-the-pattern)):*
   - **Holdout gate** — hidden BDD scenarios the coder can neither see nor edit, judged by a
     **different model** than the coder used, **paired with executable tests**, ≥90% to pass.
   - **AWS frontier agents** — the orchestrator invokes the **AWS Security Agent** and **AWS DevOps
     Agent** on the diff/artifacts (advisory in v1).
5. **PR + live status** — the coder opens a PR via `gh`; the orchestrator maintains **one sticky
   comment** that ticks each stage ⏳→✅/❌ with timestamps and log links (see [§7](#7-live-status-in-the-pr)).
6. **Human review** — a human reviews the **evidence** (test results, holdout satisfaction,
   security/devops findings) and either approves or comments.
7. **Iterate** — a PR comment resumes the scaled-to-zero sandbox (same workspace) and the coder
   applies the change. **Bounded to N rounds**, then a human breaks the tie (see [§8](#8-human-in-the-loop--the-iterative-comment-loop)).
8. **Merge + teardown** — on approve→merge, the orchestrator deletes the sandbox, PVC, any
   ephemeral test infra, and the eval job. A **reaper CronJob** sweeps abandoned/timed-out runs.

### Two worked use-cases

| Issue example | How it's tested | Teardown |
|---|---|---|
| *"Add a `weather-agent` to the examples"* | Deploy into an **ephemeral namespace** on spoke-dev → run holdout scenarios → delete namespace | Namespace + branch artifacts |
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

### 6.2 AWS frontier agents — independent, read-only reviewers

The **orchestrator** (not the coder) invokes the **AWS Security Agent** and **AWS DevOps Agent** on
the finished diff/artifacts:

- They are **out-of-cluster, AWS-managed** services — **not** kagent pods.
- They are **read-only reviewers on the finished diff** — never co-authors. Their findings are
  folded into the PR report; the coder only *reacts* to them via the comment loop.
- **v1 = advisory** (report-only). Gate hooks are designed so **per-severity blocking** can be
  switched on later (e.g. a critical CVE blocks the PR).

> **Why the orchestrator invokes them, not the coder:** it keeps the untrusted sandbox
> **credential-less** and preserves *separation of concerns* — the agent doing the work is not the
> one grading it (see the [lethal-trifecta gotcha](#11-industry-alignment--anti-patterns-what-the-world-agrees-on)).

---

## 7. Live status in the PR

The human **watches the factory work** (the Gas City idea) through **one sticky PR comment** the
orchestrator edits in place — no comment spam, one canonical surface (the pattern Copilot, Devin,
and Factory all converge on).

```
## 🏭 Dark Factory — issue #42
✅ Claimed sandbox (spoke-dev)      12:01
✅ Branch df/issue-42               12:01
✅ Implement                        12:04
✅ Build + unit tests               12:07   📄 log
⏳ Security Agent…
⬜ DevOps Agent
⬜ Holdout gate (0/12)
⬜ PR ready for review
```

Each stage links to raw logs and test output (**verifiability-by-citation** — the human can audit
any step). The full PR body carries the report: what changed, test results, holdout satisfaction %,
and the Security/DevOps findings.

---

## 8. Human-in-the-loop & the iterative comment loop

Level 3 means the **human approves the merge** — and can steer via comments:

- A PR comment (change requested) → the orchestrator **resumes the scaled-to-zero sandbox** (same
  workspace PVC) → the coder applies the change → pushes → the sticky status updates.
- **Bounded convergence:** the loop is capped at **N rounds**; after that a human must break the
  tie. Comments are **batched into one agent run** (don't fire the agent per un-batched comment —
  it thrashes).
- The agent **never self-merges**; it only pushes to its own `df/issue-<n>` branch. Branch
  protections and CI still apply.

---

## 9. Lifecycle, teardown & cost

| Phase | Sandbox state | Cost posture |
|---|---|---|
| Idle in warm pool | `replicas: 0` or snapshot | Minimal (no running VM) |
| Claimed / coding | `replicas: 1` | Active VM billed |
| Awaiting review | **`replicas: 0`** (PVC kept) | Minimal — resumes on comment |
| Merged / closed | **Deleted** (Sandbox + PVC + test infra + eval job) | Zero |

- **Scale-to-zero between activity** keeps the (possibly long) review window cheap.
- **Reaper CronJob** (adapted from openclaw `reaper-cronjob.yaml`) sweeps abandoned/timed-out runs
  by TTL annotation — the safety net for crashes and forgotten PRs.
- **Ephemeral EKS test targets** (`deep-test`) are **gated behind a label** because they cost real
  money and take ~15–20 min to provision; the default path is dry-run/namespace testing.

---

## 10. Security model

Untrusted, LLM-generated code + issue text from anyone = treat the whole sandbox as hostile.

- **Hardware isolation:** every coder runs in a **Kata micro-VM** (own kernel), not a shared-kernel
  container.
- **No cloud credentials in the sandbox:** the coder holds only a **Bifrost API key** and a
  **short-TTL GitHub token** via **projected tmpfs (mode 0400)** — read then unset, never in env.
  All AWS IAM lives with the **orchestrator, outside the VM**.
- **Egress lockdown:** a **NetworkPolicy** restricts sandbox egress to **Bifrost:8080 + DNS +
  GitHub only**. `automountServiceAccountToken: false`, runAsNonRoot, seccomp `RuntimeDefault`,
  drop `ALL` caps.
- **Prod is never a test bed:** the factory runs on **spoke-dev**; spoke-prod holds the sandbox
  capability but its pool is **dormant**. Unreviewed agent code never touches prod.
- **⚠️ Lethal trifecta (the #1 risk — see [§11](#11-industry-alignment--anti-patterns-what-the-world-agrees-on)):** untrusted
  issue text + credentials + egress is the exact recipe for prompt-injection exfiltration
  (demonstrated against GitHub-issue-driven agents in the wild). The mitigations above exist
  specifically to break that trifecta: keep credentials out of the issue-ingesting context, deny
  egress, and treat all issue/repo content as hostile input.

---

## 11. Industry alignment & anti-patterns (what the world agrees on)

We validated this design against how GitHub Copilot coding agent, OpenAI Codex cloud, Devin, Google
Jules, Cursor background agents, Factory.ai, and StrongDM's "Software Factory" actually work.

### ✅ Where we match consensus

| Design choice | Industry practice |
|---|---|
| Issue → Action → ephemeral sandbox → build/test → PR | The recurring ~7-stage pipeline across Copilot/Codex/Devin/Jules/Factory |
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
| **P1** | Trigger → claim warm sandbox → Claude Code coder → build/test → PR + sticky status → manual teardown | ✅ A working autonomous-PR loop |
| **P2** | Strict **holdout gate** (isolated, different-model judge, executable-test pairing) + bounded retry | ✅ Quality gate that resists gaming |
| **P3** | **AWS Security + DevOps** frontier agents (advisory) folded into the PR report | ✅ Independent review evidence |
| **P4** | Ephemeral test targets (namespace default; `deep-test` `PlatformCluster`) + **auto-teardown** on merge + reaper | ✅ Full lights-off lifecycle |
| **P5** | **Kiro** coder profile; per-severity **blocking** gate option; spoke-prod pool activation story | ✅ Vendor-plurality + higher autonomy |

---

## 12a. Running Kata on EKS Auto Mode clusters (validated design)

The spoke clusters run **EKS Auto Mode + Bottlerocket** (`c6a`/`c6g` nodes). Auto Mode's managed
nodes **cannot host Kata**: no control over `cpuOptions.nestedVirtualization`, no kernel-module
loading (`modprobe kvm_intel`), no `kata-deploy`, and those node types don't expose VT-x.
`eks-platform-openclaw` avoids Auto Mode entirely for this reason — but we don't have to.

### Decision: self-managed nested-virt MNG *alongside* Auto Mode

Add a small, tainted **self-managed Managed Node Group** of **nested-virt `c8i`/`m8i`** instances to
spoke-dev. Auto Mode keeps running everything else; kata sandboxes schedule onto the MNG via the
`kata=true:NoSchedule` taint the chart already applies. We chose an **MNG, not a second
Karpenter** — running a self-managed Karpenter beside Auto Mode's managed Karpenter risks
NodePool/CRD conflicts, whereas MNGs are additive and coexist cleanly.

Rejected alternatives: **Bedrock AgentCore / Fargate** (breaks the k8s-native pod model our whole
Sandbox/warm-pool/claim design depends on — it's an invoke-a-session runtime, not a pod we own);
**gVisor** (same Auto-Mode node-install blocker as Kata, weaker isolation).

### ✅ Validated by a live spike (spoke-dev, 2026-07-10)

A throwaway 1-node `c8i.4xlarge` MNG was created on spoke-dev, then torn down. Results:

| Question | Result |
|---|---|
| Self-managed MNG coexists with Auto Mode? | **Yes** — MNG provisioned alongside Auto Mode nodepools, no conflict; Auto Mode stayed healthy |
| Nested virtualization / `/dev/kvm`? | **Yes** — `/dev/kvm` present, `kvm_intel` loaded, 32 `vmx` flags, via `CpuOptions.NestedVirtualization: enabled` |
| aws-cli support | Requires **aws-cli ≥ 2.35** for the `CpuOptions.NestedVirtualization` launch-template field |

### Two hard-won lessons (baked into the implementation)

1. **Node bootstrap** — do **not** override the AMI + userData with plain bash; that clobbers the
   EKS bootstrap and the node boots (`/dev/kvm` present) but never joins the cluster. Use the
   **AL2023 nodeadm MIME userData** format (or the default EKS AMI + a systemd unit that runs
   `modprobe kvm_intel`), and set nested-virt via the **launch-template `CpuOptions`**, not userData.
2. **Teardown ordering** — delete the **MNG first and let it drain**. Terminating the instance out
   from under the MNG makes the ASG respawn and can wedge the delete on a `Pending:Wait` lifecycle
   hook; recover with `aws autoscaling terminate-instance-in-auto-scaling-group` +
   `complete-lifecycle-action`. Set MNG min/desired to 0 before deleting for a clean teardown.

---

## 13. Open questions / future work

*To resolve during implementation — flagged honestly rather than assumed:*

- **Headless auth** for Claude Code & Kiro through a Bifrost base-URL override inside a Kata VM
  (the biggest unknown — prototype first in P1).
- **Import the `agent-sandbox` operator** from `eks-platform-openclaw` into the OAP addon catalog
  (Flow A's first task).
- **Enable the sandbox/kagent addons on the dev overlay** (they're hub-only today).
- **Exact AWS Security / DevOps Agent APIs & auth** — confirm the invocation contract at build time.
- **Orchestrator RBAC scope** — Sandbox/PVC/Service/Job on spoke-dev + `PlatformCluster` claims for
  the `deep-test` path.
- **Warm-pool implementation** — verify whether the `agent-sandbox` v0.1.0 operator supports
  snapshot/fork warm-binding, or whether the pool-manager must create-on-demand.

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
