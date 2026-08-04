# Dark Factory — Substrate Diagrams (Kata vs Lambda MicroVM)

Visual companion to [`SUBSTRATE-BENCHMARK.md`](./SUBSTRATE-BENCHMARK.md). All diagrams are
Mermaid (render on GitHub).

---

## 1. Shared pipeline, substrate-branched claim

Both substrates run the **same `df-run` WorkflowTemplate**. The only branch is which warm pool
`claim-sandbox` claims from — decided by the issue's trigger label.

```mermaid
flowchart TD
    ISSUE["GitHub issue labeled<br/>dark-factory OR darkfactory-lambda"] --> SENSOR["Argo Events sensor"]
    SENSOR --> DFRUN["df-run WorkflowTemplate"]
    DFRUN --> CLAIM{"claim-sandbox<br/>trigger-label?"}
    CLAIM -->|dark-factory| KP["coder-warmpool<br/>(Kata pool)"]
    CLAIM -->|darkfactory-lambda| LP["coder-warmpool-microvm<br/>(Lambda bridge pool)"]
    KP --> CODE["drive-coder"]
    LP --> CODE
    CODE --> GATES["holdout-gate · detect→deploy-test<br/>devops-gate → security-agent"]
    GATES --> STATUS["status (consolidated verdict)"]
    STATUS --> EXIT["onExit: teardown"]
```

The DAG has **no MicroVM-specific node** — Lambda suspend/resume lives in the bridge (§4), so the
Kata graph is 100% clean.

---

## 2. Kata micro-VM substrate (Flow B)

```mermaid
flowchart LR
    CLAIM["SandboxClaim"] --> OP["agent-sandbox operator"]
    OP --> POD["Kata pod (kata-clh)<br/>on nested-virt node group"]
    POD --> ENT["entrypoint.js (baked)"]
    ENT -->|models| BIF["Bifrost gateway<br/>(ClusterIP, in-cluster)"]
    BIF --> BED["Bedrock"]
    ENT -->|git/gh :443| GH["GitHub → PR"]
    ENT -->|secrets| SEC["/etc/secrets<br/>(projected tmpfs)"]
    POD -.native logs.-> KL["kubectl logs"]
    BIF -.traces.-> LF["Langfuse"]
```

- Pre-warmed pod → **instant claim**.
- Workspace is a **mounted writable volume**; logs are native; models via Bifrost (with Langfuse
  traces). Node pool runs continuously.

---

## 3. Lambda MicroVM substrate (Flow D)

```mermaid
flowchart LR
    CLAIM["SandboxClaim"] --> BR["bridge pod (in-cluster)"]
    BR -->|reads handoff| IMG["MicrovmSandbox status<br/>imageARN + execRoleARN<br/>(built once by KRO/ACK)"]
    BR -->|creates| MCR["Microvm CR<br/>(runHookPayload = Secret ref)"]
    MCR --> CTRL["lambdamicrovms controller"]
    CTRL -->|RunMicrovm cold-start| VM["Firecracker MicroVM<br/>hook-server :8080"]
    BR -->|mint token, POST /run| VM
    VM --> ENT["entrypoint.js (USE_BEDROCK=1)"]
    ENT -->|models, direct| BED["Bedrock<br/>(exec role, public egress)"]
    ENT -->|git/gh :443| GH["GitHub → PR"]
    VM -.coder stdout.-> LOGS["GET /logs (token)"]
    BR -->|after PR pushed| SUSP["suspend-microvm<br/>(free compute)"]
    BR -->|teardown: delete CR| TERM["controller TerminateMicrovm"]
```

- `RunMicrovm` **cold-start per session** (~90s); no node pool.
- No cluster network dependency — **Bedrock-direct**. Logs via `/logs`. Bridge suspends the VM
  after the PR, terminates on teardown.

---

## 4. Lambda suspend / resume (bridge-owned, not a DAG step)

```mermaid
sequenceDiagram
    participant B as bridge
    participant C as lambdamicrovms controller
    participant V as MicroVM
    B->>C: create Microvm CR (runHookPayload)
    C->>V: RunMicrovm (cold-start)
    V-->>B: RUNNING + endpoint
    B->>V: POST /run (token) → coder starts
    V-->>B: /logs shows "PR opened"
    B->>V: suspend-microvm (free compute during review)
    Note over V: SUSPENDED (memory+disk preserved)
    Note over B,V: on fix round, a fresh Microvm CR is created<br/>(Kata likewise claims a fresh coder per round)
    B->>C: delete Microvm CR (on teardown)
    C->>V: TerminateMicrovm
```

---

## 5. End-to-end lifecycle (issue → PR → fix → merge) — both substrates

```mermaid
flowchart TD
    A["Issue labeled"] --> B["df-run: claim + coder → PR"]
    B --> C["DevOps Agent + Security Agent review"]
    C --> D{"Security findings?"}
    D -->|clean| APR["Human approves PR"]
    D -->|findings| FIX["Human comments 'fix findings'"]
    FIX --> IT["df-iterate → df-run (same substrate via trigger-label)"]
    IT --> B
    APR --> MERGE["df-merge-teardown:<br/>merge PR + release/terminate sandbox"]
```

The loop is identical for both substrates; `df-iterate` reads the originating issue's label to
route the fix round back to the **same** substrate (Kata pool or Lambda pool).

---

## Legend / key facts

- **Warm pool:** Kata = ready pods (instant); Lambda = bridge pods that RunMicrovm on claim.
- **LLM:** Kata → Bifrost (traced in Langfuse); Lambda → Bedrock-direct (exec role).
- **Workspace:** Kata → mounted volume; Lambda → `/tmp/workspace` (read-only rootfs).
- **Logs:** Kata → `kubectl logs`; Lambda → `/logs` endpoint (+ build logs in CloudWatch).
- **Teardown:** Kata → release claim; Lambda → delete `Microvm` CR → TerminateMicrovm.
