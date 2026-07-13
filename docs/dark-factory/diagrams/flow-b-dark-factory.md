# Flow B — Dark Factory (issue → PR → merge → teardown)

A GitHub issue is a **spec**. On the **hub cluster**, **Argo Workflows** claims a warm Kata sandbox,
a pluggable coding assistant implements + tests the change and pushes a branch, the workflow opens a
PR and runs independent verification (holdout gate + AWS Security/DevOps review), a human approves on
**results**, and everything is torn down on merge. Autonomy **Level 3**: the human's only job is to
approve the merge.

> **Runs on the hub** — the build/author plane, co-located with Argo Workflows and the Flow A warm
> pool. Single-cluster orchestration: the workflow watches the coder pod and eval Job directly. See
> [README §2](../README.md#2-two-flows-at-a-glance) for *why the hub, not a spoke*, and
> [§10](../README.md#10-security-model) for the control-plane isolation that makes it safe.

> Diagrams use the Dark Factory palette: **gray** = neutral/queued · **orange** = active ·
> **green** = success/verified · **pink** = rework · **red** = fail/blocked · dashed = feedback loop.

---

## B.1 — Hub topology & isolation boundary

The Dark Factory lane and the hub's control-plane services share a cluster, so the isolation
boundary is explicit: coder VMs run **only** on a dedicated **tainted nested-virt nodegroup**, and a
**NetworkPolicy** denies egress to the control-plane services (Keycloak / ArgoCD / external-secrets /
Argo) and IMDS — allowing only DNS + Bifrost + GitHub.

```mermaid
%%{init: {'theme':'base','themeVariables':{
  'fontFamily':'Amazon Ember, Helvetica, Arial, sans-serif','fontSize':'14px',
  'primaryColor':'#F2F4F7','primaryBorderColor':'#B6C0CC','primaryTextColor':'#1B2733',
  'lineColor':'#8B99A7','clusterBkg':'#FBFCFD','clusterBorder':'#C7D0DA'}}}%%
flowchart TB
    classDef active  fill:#F59E0B,stroke:#D67E00,color:#1B2733,stroke-width:1.4px;
    classDef ok      fill:#10B981,stroke:#0E9A6C,color:#FFFFFF,stroke-width:1.3px;
    classDef node    fill:#FDE7C7,stroke:#E0A960,color:#1B2733,stroke-width:1.2px;
    classDef vm      fill:#FFF3E0,stroke:#F59E0B,color:#1B2733,stroke-width:1.4px;
    classDef guard   fill:#FCE7EA,stroke:#E0555F,color:#7A2531,stroke-width:1.3px;
    classDef neutral fill:#ECEFF3,stroke:#B6C0CC,color:#1B2733,stroke-width:1px;

    GH["🐙 GitHub<br/>issue · PR · webhook"]:::active

    subgraph HUB["☸️  Hub cluster · build / author plane"]
    direction TB

        subgraph CP["🔐  Control plane — fenced off from the sandbox"]
            direction LR
            KC["Keycloak"]:::guard
            ACD["ArgoCD"]:::guard
            ESO["external-secrets"]:::guard
        end

        subgraph DF["🏭  Dark Factory lane"]
            direction TB
            EVT["Argo Events<br/>Sensor"]:::neutral
            WF["Argo Workflows<br/>df-run · df-iterate · df-merge-teardown<br/>holds AWS IAM + GitHub App"]:::active
            OPER["agent-sandbox operator<br/>+ SandboxWarmPool"]:::node
            EVT --> WF --> OPER
        end

        subgraph KATA["🛡️  Tainted nested-virt nodegroup · kata=true:NoSchedule"]
            direction LR
            POOL["🔥 warm pool<br/>coder-warmpool"]:::vm
            CODER["coder VM · kata-clh<br/>no cloud creds"]:::vm
            EVAL["holdout eval Job"]:::vm
            POOL --> CODER
        end

        NP{{"⛔ NetworkPolicy — deny control-plane + IMDS ·<br/>allow DNS + Bifrost + GitHub only"}}:::guard
        MODEL["🧠 Bifrost gateway → Bedrock"]:::ok
    end

    GH -->|webhook| EVT
    WF -->|SandboxClaim| OPER
    OPER --> POOL
    WF -. watch pod / Job .-> CODER
    WF -. watch .-> EVAL
    CODER -->|push branch| GH
    WF -->|open PR · sticky comment · merge| GH
    CODER --> MODEL
    NP -. enforces .- CODER
    CODER -. blocked .-x CP

    class HUB,DF,KATA,CP band
    linkStyle default stroke:#8B99A7,stroke-width:1.4px;
```

---

## B.2 — The `df-run` DAG (claim → code → verify → PR → await approval)

All steps are **local to the hub**, so Argo watches pod/Job status directly and owner-references
cascade cleanup. Verification fans out in **parallel**; the coder never grades itself.

```mermaid
%%{init: {'theme':'base','themeVariables':{
  'fontFamily':'Amazon Ember, Helvetica, Arial, sans-serif','fontSize':'13.5px',
  'primaryColor':'#F2F4F7','primaryBorderColor':'#B6C0CC','primaryTextColor':'#1B2733',
  'lineColor':'#8B99A7','clusterBkg':'#FBFCFD','clusterBorder':'#C7D0DA'}}}%%
flowchart LR
    classDef active  fill:#F59E0B,stroke:#D67E00,color:#1B2733,stroke-width:1.5px;
    classDef ok      fill:#10B981,stroke:#0E9A6C,color:#FFFFFF,stroke-width:1.3px;
    classDef node    fill:#FDE7C7,stroke:#E0A960,color:#1B2733,stroke-width:1.2px;
    classDef gate    fill:#FFF3E0,stroke:#F59E0B,color:#1B2733,stroke-width:1.4px;
    classDef opt     fill:#ECEFF3,stroke:#B6C0CC,color:#5A6675,stroke-width:1px;
    classDef human   fill:#FCE7EA,stroke:#E0555F,color:#7A2531,stroke-width:1.3px;

    START(["issue labeled<br/>dark-factory"]):::active
    CLAIM["claim<br/>SandboxClaim → Ready"]:::node
    CODE["coder<br/>implement · build · test<br/>push df/issue-N"]:::node
    PR["open PR<br/>after tests green"]:::active

    subgraph V["verification · parallel · workflow-driven (never the coder)"]
        direction TB
        HOLD["🎯 holdout gate<br/>eval Job · diff-model judge<br/>+ tests · ≥90%"]:::gate
        SEC["🛡️ Security review<br/>AWS Security Agent"]:::node
        DOPS["🚀 DevOps review<br/>AWS DevOps Agent"]:::node
        DEEP["🔬 Fable-5 deep-sec<br/>2nd Kata VM · optional"]:::opt
    end

    GATE["gate<br/>aggregate findings"]:::gate
    CMT["sticky PR comment<br/>⏳→✅ · single writer"]:::ok
    WAIT{"await human<br/>approval"}:::human

    START ==> CLAIM ==> CODE ==> PR ==> HOLD
    PR ==> SEC
    PR ==> DOPS
    PR -. optional .-> DEEP
    HOLD ==> GATE
    SEC ==> GATE
    DOPS ==> GATE
    DEEP -.-> GATE
    GATE ==> CMT ==> WAIT

    ONEXIT["onExit teardown (merge workflow)<br/>delete claim + PVC + eval"]:::opt
    WAIT -. df-run ends; approval is a new event .-> ONEXIT

    class V band
    linkStyle default stroke:#8B99A7,stroke-width:1.5px;
```

---

## B.3 — Event-driven lifecycle (Argo Events → short workflows keyed on issue-id)

Rather than one multi-day suspended workflow, each GitHub event submits a **short-lived workflow**.
Durable state lives in the retained workspace PVC + GitHub + a per-issue state ConfigMap.

```mermaid
%%{init: {'theme':'base','themeVariables':{
  'fontFamily':'Amazon Ember, Helvetica, Arial, sans-serif','fontSize':'13px',
  'primaryColor':'#F59E0B','primaryBorderColor':'#D67E00','primaryTextColor':'#1B2733',
  'actorBkg':'#F59E0B','actorBorder':'#D67E00','actorTextColor':'#1B2733',
  'signalColor':'#8B99A7','signalTextColor':'#1B2733','lineColor':'#8B99A7',
  'noteBkg':'#FFF3E0','noteTextColor':'#1B2733','noteBorderColor':'#F59E0B',
  'loopTextColor':'#1B2733','sequenceNumberColor':'#FFFFFF'}}}%%
sequenceDiagram
    autonumber
    actor Dev as 🧑‍💻 Human
    participant GH as 🐙 GitHub
    participant SEN as ⚡ Argo Events Sensor
    participant WF as 🎛️ Argo Workflows (hub · AWS IAM)
    participant POOL as 🔥 Warm pool
    box rgb(255,243,224) 🛡️ Kata micro-VM · no cloud creds
    participant SBX as 🤖 Coder sandbox
    end
    participant REV as 🛡️ Holdout Job / Security / DevOps

    Dev->>GH: open issue (label: dark-factory)
    GH->>SEN: issues.labeled webhook
    SEN->>WF: submit df-run (key = issue-id)
    WF->>POOL: SandboxClaim(warmPoolRef)
    POOL-->>WF: bound warm sandbox (Ready)
    WF->>SBX: SPEC.md + checkout df/issue-N
    activate SBX
    SBX->>SBX: implement · build · test (until green)
    SBX-->>WF: push branch + result.json
    deactivate SBX
    WF->>GH: open PR (workflow, not coder)
    par independent verification
        WF->>REV: holdout eval Job (diff-model judge + tests)
        WF->>REV: AWS Security + DevOps agents (read-only)
    end
    REV-->>WF: pass % + findings
    WF->>GH: sticky comment (evidence) + label df/awaiting-approval
    Note over WF: df-run ENDS here — no multi-day suspend

    opt bounded iterations (max N)
        Dev->>GH: PR comment (change requested)
        GH->>SEN: issue_comment webhook
        SEN->>WF: submit df-iterate (re-bind retained PVC)
        WF->>SBX: apply comment → push → update sticky comment
    end

    Dev->>GH: ✅ approve review
    GH->>SEN: pull_request_review.approved webhook
    SEN->>WF: submit df-merge-teardown
    WF->>GH: merge PR (only after human approval)
    WF->>POOL: onExit → delete claim + PVC + eval Job
    Note over WF: Reaper CronJob sweeps any abandoned run
```

---

## B.4 — Task lifecycle (what the human sees)

Mirrors the Dark Factory task-lifecycle model: neutral → active → verify → success, with the
rework/dropped branches.

```mermaid
%%{init: {'theme':'base','themeVariables':{
  'fontFamily':'Amazon Ember, Helvetica, Arial, sans-serif','fontSize':'14px',
  'primaryColor':'#F59E0B','primaryBorderColor':'#D67E00','primaryTextColor':'#1B2733',
  'lineColor':'#8B99A7','labelColor':'#1B2733'}}}%%
stateDiagram-v2
    direction LR
    [*] --> Queued : issue labeled
    Queued --> InProgress : sandbox claimed · coding
    InProgress --> Inspection : PR open · verification
    Inspection --> Merged : human approves ✅
    Inspection --> Rework : changes requested / gate fail
    Rework --> InProgress : df-iterate (bounded N)
    Rework --> Dropped : max rounds / abandoned
    Merged --> [*]
    Dropped --> [*]

    classDef queued  fill:#ECEFF3,stroke:#B6C0CC,color:#1B2733;
    classDef active  fill:#F59E0B,stroke:#D67E00,color:#1B2733;
    classDef inspect fill:#FDE7C7,stroke:#E0A960,color:#1B2733;
    classDef merged  fill:#10B981,stroke:#0E9A6C,color:#FFFFFF;
    classDef rework  fill:#FCE7EA,stroke:#E0555F,color:#7A2531;
    classDef dropped fill:#F56565,stroke:#D64545,color:#FFFFFF;
    class Queued queued
    class InProgress active
    class Inspection inspect
    class Merged merged
    class Rework rework
    class Dropped dropped

    note right of Inspection
        Holdout ≥90% + Security + DevOps
        evidence on the sticky PR comment.
    end note
    note right of Merged
        onExit teardown: delete
        sandbox + PVC + eval Job.
    end note
```

---

## B.5 — The one sticky PR comment (single writer = the workflow)

The workflow maintains **one** comment, edited in place via a hidden marker — no comment spam. Until
tests are green there is no PR, so pre-PR status lives on the **issue**; from PR-open onward the
comment is the canonical board. Parallel review steps are serialized by a **per-issue mutex**.

```mermaid
%%{init: {'theme':'base','themeVariables':{
  'fontFamily':'Amazon Ember, Helvetica, Arial, sans-serif','fontSize':'13px',
  'primaryColor':'#F2F4F7','primaryBorderColor':'#B6C0CC','primaryTextColor':'#1B2733',
  'lineColor':'#B6C0CC','clusterBkg':'#FBFCFD','clusterBorder':'#C7D0DA'}}}%%
flowchart TB
    classDef done fill:#10B981,stroke:#0E9A6C,color:#FFFFFF,stroke-width:1.3px;
    classDef now  fill:#F59E0B,stroke:#D67E00,color:#1B2733,stroke-width:1.5px;
    classDef wait fill:#ECEFF3,stroke:#B6C0CC,color:#5A6675,stroke-width:1px;

    subgraph CANVAS["🏭  Dark Factory — issue #42  ·  PR #128"]
    direction TB
        A["✅ Claimed sandbox (hub) · 12:01"]:::done
        B["✅ Branch df/issue-42 · 12:01"]:::done
        C["✅ Implement · 12:04"]:::done
        D["✅ Build + unit tests · 12:07 · 📄 log"]:::done
        E["✅ PR opened #128 · 12:07"]:::done
        F["⏳ Security review…"]:::now
        G["⬜ DevOps review"]:::wait
        H["⬜ Holdout gate (0/12)"]:::wait
        I["⬜ Ready for review"]:::wait
        A --> B --> C --> D --> E --> F --> G --> H --> I
    end
    linkStyle default stroke:#B6C0CC,stroke-width:1.2px;
```
