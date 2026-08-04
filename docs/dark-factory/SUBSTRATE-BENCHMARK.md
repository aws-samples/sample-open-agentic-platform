# Dark Factory — Substrate Benchmark: Kata micro-VM vs Lambda MicroVM

A side-by-side comparison of the two sandbox substrates that run the autonomous coder,
measured on **identical issues fired in parallel** on the same hub cluster.

- **Flow B — Kata micro-VM** (mature, default): the coder runs in a hardware-isolated Kata
  pod on a self-managed nested-virt EKS node group.
- **Flow D — AWS Lambda MicroVM** (pre-GA): the coder runs in a Firecracker MicroVM
  provisioned via the `lambdamicrovms` ACK controller, driven by a bridge pod.

Both run the **same `dark-factory-coder`** (same `entrypoint.js`), produce the same kind of
PR, and go through the **same review gates** (AWS DevOps Agent + AWS Security Agent). The only
difference is *where the coder executes* and *how it's provisioned*.

---

## TL;DR

| | Kata micro-VM (Flow B) | Lambda MicroVM (Flow D) |
| --- | --- | --- |
| **Provisioning** | pre-warmed pool → **instant claim** | **RunMicrovm cold-start per session** (~90–120s) |
| **Time to first PR** (from label) | ~**2 min** | ~**3.5 min** |
| **LLM path** | Bifrost gateway (in-cluster) + Langfuse traces | **Bedrock-direct** (exec role) — no cluster network |
| **Scale-to-zero when idle** | ❌ node pool runs continuously | ✅ **suspend-to-zero**, resume on demand |
| **Infra to manage** | nested-virt node group (Karpenter/MNG) | none — serverless MicroVMs |
| **Observability** | native `kubectl logs` | custom `/logs` HTTP endpoint (no runtime CloudWatch) |
| **Maturity** | production-ready today | pre-GA (preview) — pilot-grade |
| **Economics at 1000s scale** | pay for idle capacity | pay per active minute (the strategic win) |

**Bottom line:** at small scale the two feel equivalent (the LLM coding step ~2–4 min and the
external review agents ~8–15 min dominate total time on *both*). The Lambda substrate's advantage
is **not latency** — it's **operational + economic**: no node pool to run, and suspend-to-zero per
idle session. Its cost is **maturity** (pre-GA control plane) and the extra plumbing below.

---

## Benchmarked run (identical issue, fired in parallel)

Issue (both): *"Add an S3 bucket for log archives + an EC2 IAM role to write to it (Terraform)."*
Fired simultaneously — `#117` labeled `dark-factory` (Kata), `#118` labeled `darkfactory-lambda` (Lambda).

### Time to first PR (from label → PR opened)
| Substrate | Issue | PR | Elapsed |
| --- | --- | --- | --- |
| Kata | #117 | #119 | ~**2 min** (16:32:54 → 16:34:58) |
| Lambda | #118 | #120 | ~**3.7 min** (16:32:54 → 16:36:38) |

**Δ ≈ 100s** — the MicroVM cold-start (`RunMicrovm` → RUNNING → hook-server ready → bridge drives
`/run`) vs Kata's pre-warmed pod claim. This gap is the substrate's provisioning cost; everything
after (clone → LLM agent → push) is identical code and takes the same time.

### Per-step workflow timing (Kata run #117)
| Step | Time |
| --- | --- |
| claim (warm pod) | ~17s |
| **drive-coder** (clone→LLM→push→PR) | ~120s |
| detect-deployable | ~28s |
| holdout-gate | ~19s |
| deploy-test (terraform validate) | ~37s |
| security-agent (external) | several min |
| devops-gate (external) | several min |

*(The Lambda run's `drive-coder` is comparable for the coding itself; it just adds the ~90s
RunMicrovm cold-start inside the claim/drive window. The two external review agents — DevOps +
Security — take ~8–15 min combined and dominate total wall-clock on BOTH substrates.)*

---

## Where the logs are

| What | Kata (Flow B) | Lambda (Flow D) |
| --- | --- | --- |
| Pipeline steps | Argo UI (`/argo-workflows`) or `kubectl logs -n argo <pod>` | **same** |
| Coder output | `kubectl logs -n agent-sandbox-system df-issue-<id>` (native) | **`GET https://<vm-endpoint>/logs`** with an auth token (runtime CloudWatch routing is unreliable on the pre-GA runtime, so the hook-server captures coder stdout to a file + serves it) |
| Image build | n/a (normal ECR image) | CloudWatch `/aws/lambda/microvms/coder-image` |

---

## DAG — same pipeline, one substrate-branched step

Both substrates run the **same `df-run` WorkflowTemplate**. The DAG is identical:

```
claim → drive-coder → { holdout-gate, devops-gate → security-agent, detect-deployable → deploy-test } → status → onExit(teardown)
```

The **only** substrate branch is inside `claim-sandbox`: `trigger-label` selects the warm pool —
`coder-warmpool` (Kata) vs `coder-warmpool-microvm` (Lambda). **There is no MicroVM-specific step in
the DAG** — suspend/resume for Lambda is handled by the *bridge* itself (see below), so the Kata
graph contains zero MicroVM nodes.

### Substrate-specific mechanics (outside the DAG)
- **Kata:** the operator materializes a pod from `SandboxTemplate/coder-sandbox`; the coder runs
  in-cluster, reaches models via Bifrost, and its logs are native pod logs.
- **Lambda:** `SandboxTemplate/coder-sandbox-microvm` materializes a **bridge pod** which:
  1. reads the platform image handoff (imageARN + execRoleARN, built once by KRO/ACK),
  2. creates a **`Microvm` CR** (declarative — the controller delivers the runHookPayload),
  3. waits for RUNNING, mints an auth token, and **POSTs `/run`** to the VM endpoint → the
     hook-server background-spawns the coder,
  4. **suspends the MicroVM** once the coder pushes the PR (free compute during review),
  5. terminates the VM on teardown (delete the `Microvm` CR).

---

## Step-by-step: what actually happens

### Kata (Flow B)
1. Issue labeled `dark-factory` → Argo Events sensor → `df-run`.
2. `claim-sandbox` claims a **pre-warmed** Kata pod from `coder-warmpool` (instant).
3. Operator injects `DF_ISSUE_NUMBER` etc. → the baked-in `entrypoint.js` runs: clone → Claude
   Code (`claude -p`, via **Bifrost**) → commit → **open PR**.
4. Review gates: DevOps Agent (check-run) + Security Agent (findings). Consolidated verdict posted.
5. Human comment "fix findings" → `df-iterate` → new Kata coder round → re-review.
6. Approve → `df-merge-teardown` merges + releases the claim.

### Lambda MicroVM (Flow D)
1. Issue labeled `darkfactory-lambda` → same sensor → `df-run` (warm-pool branched to Lambda).
2. `claim-sandbox` claims the **bridge** pod from `coder-warmpool-microvm`.
3. Bridge creates a `Microvm` CR → controller `RunMicrovm` (**cold-start ~90s**) → RUNNING.
4. Bridge mints auth token → `POST /run` → hook-server background-spawns the **same
   `entrypoint.js`**, but `USE_BEDROCK=1` so it calls **Bedrock directly** (exec role) — no cluster
   network. Coder: clone → Claude Code → commit → **open PR**.
5. Bridge **suspends** the MicroVM (free compute while gates run).
6. Same review gates + verdict.
7. "fix findings" → `df-iterate` (routes back to Lambda via `trigger-label`) → fresh MicroVM round.
8. Approve → merge + teardown (bridge deletes the `Microvm` CR → controller terminates the VM).

---

## Gotchas the Lambda substrate needed (that Kata does not)

Because a MicroVM is **outside the cluster network, has a read-only rootfs, and uses a
snapshot/hook execution model**:

| # | Gotcha | Fix |
| --- | --- | --- |
| 1 | Coder crashed `EACCES mkdir /workspace/artifacts` (no writable volume like Kata) | set `WORKSPACE=/tmp/workspace` (writable tmpfs) — *the silent killer* |
| 2 | Can't reach Bifrost's ClusterIP from a MicroVM | **Bedrock-direct** via the exec role (`bedrock:InvokeModel`); no Bifrost/NLB/VPC-connector |
| 3 | Runtime logs don't reach CloudWatch | hook-server captures coder stdout → `/logs` HTTP endpoint |
| 4 | Coder is one-shot but the MicroVM `/run` hook has a 30s timeout | `/run` **background-spawns** the coder + returns fast; pipeline polls GitHub for the PR |
| 5 | Env injection needs a `coder` container | bridge container named `coder` (claim contract parity) |
| 6 | aws-cli image lacks `lambda-microvms`; no node | bridge image = `aws-cli:latest` (has the verbs) + python3 for JSON + fetch kubectl at start |
| 7 | Ingress: `ALL_INGRESS` blocks auth-token minting | use **`HTTP_INGRESS`** (+ `SHELL_INGRESS` for debug) |
| 8 | `runHookPayload` is a `SecretKeyReference`; imperative `run-microvm --run-hook-payload` doesn't fire `/run` | deliver via the **declarative `Microvm` CR** |
| 9 | Image rebuild: overwriting the same S3 key doesn't rebuild | use versioned artifact keys; bump `codeArtifactUri` |
| 10 | Pre-GA controller state can wedge (ConflictException / hung build) on delete/recreate | delete the AWS image by ARN or the CR cleanly; keep the hook-server minimal |
| — | IAM for the controller/bridge/exec roles | `iam:PassRole` (ARN-scoped), `lambda:PassNetworkConnector`, `lambda:CreateMicrovmAuthToken`, `bedrock:InvokeModel`, `s3:ListAllMyBuckets` on the capability role |

Kata needs **none** of these — it's an in-cluster pod with a mounted workspace, native logs,
Bifrost reachability, and a normal ECR image.

---

## When to choose which

- **Kata (today):** production-ready, mature, standard `kubectl`/IDE access, in-cluster networking.
  Choose it now for reliability. Cost: you run + pay for a nested-virt node pool continuously.
- **Lambda MicroVM (strategic):** serverless, suspend-to-zero per idle session, no node pool —
  the model that scales economically to thousands of sessions. Choose it as it reaches GA. Cost
  today: pre-GA control-plane maturity + the plumbing above.

Both share the **same coder, same pipeline, same review gates, same UX** — so migrating between
substrates is a label change, invisible to the developer/issue author.
