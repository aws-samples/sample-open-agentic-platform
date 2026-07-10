# Flow B — Dark Factory (issue → PR → merge → teardown)

A GitHub issue is a **spec**. The factory claims a warm sandbox on spoke-dev, a pluggable
coding assistant implements + tests the change, the orchestrator runs independent
verification (holdout gate + AWS frontier agents), a PR is opened with a **live-updating**
status, a human approves on results, and everything is torn down on merge. Autonomy **Level 3**:
the human's only job is to approve the merge.

---

## B.1 — End-to-end pipeline (lights-off assembly line)

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontFamily':'ui-sans-serif, system-ui','fontSize':'13.5px','primaryColor':'#EAF2FF','primaryBorderColor':'#2563EB','primaryTextColor':'#0B1F3A','lineColor':'#475569','clusterBkg':'#F8FAFC','clusterBorder':'#CBD5E1'}}}%%
flowchart LR
    classDef trigger  fill:#FEF9C3,stroke:#CA8A04,stroke-width:1.5px,color:#422006,rx:8,ry:8;
    classDef orch     fill:#DBEAFE,stroke:#2563EB,stroke-width:2px,color:#0B1F3A,rx:8,ry:8;
    classDef sandbox  fill:#E0F2FE,stroke:#0EA5E9,stroke-width:2px,color:#0C4A6E,rx:8,ry:8;
    classDef verify   fill:#F3E8FF,stroke:#9333EA,stroke-width:1.5px,color:#3B0764,rx:8,ry:8;
    classDef aws      fill:#FFEDD5,stroke:#EA580C,stroke-width:1.5px,color:#431407,rx:8,ry:8;
    classDef human    fill:#DCFCE7,stroke:#16A34A,stroke-width:2px,color:#052E16,rx:10,ry:10;
    classDef teardown fill:#FEE2E2,stroke:#DC2626,stroke-width:1.5px,color:#450A0A,rx:8,ry:8;

    START([🧾 <b>Issue opened</b><br/>label: <code>dark-factory</code>]):::trigger

    subgraph T["① Trigger"]
        GHA["⚙️ <b>GitHub Action</b><br/>gate on label<br/>mint short-TTL token"]:::trigger
    end

    subgraph O["② Orchestrate  ·  spoke-dev  (trusted, holds AWS IAM)"]
        ORCH["🎛️ <b>Orchestrator</b><br/>key = issue-id<br/>claim + drive + report"]:::orch
        CLAIM["🔒 SandboxClaim<br/>→ bind warm sandbox<br/>pool refills"]:::orch
        ORCH --> CLAIM
    end

    subgraph SBX["③ Code + self-test  ·  Kata micro-VM  (isolated, no cloud creds)"]
        CODER["🤖 <b>Pluggable coder</b><br/>Claude Code ▸ | Kiro ▸<br/>reads SPEC.md"]:::sandbox
        IMPL["✍️ implement<br/>branch df/issue-N"]:::sandbox
        BUILD["🔧 build + unit tests<br/><i>until green</i>"]:::sandbox
        CODER --> IMPL --> BUILD
    end

    subgraph V["④ Independent verification  (orchestrator-driven — NOT the coder)"]
        HOLD["🎯 <b>Holdout gate</b><br/>hidden BDD scenarios<br/>different-model judge<br/>+ executable tests · ≥90%"]:::verify
        SEC["🛡️ <b>AWS Security Agent</b>"]:::aws
        DEV["🚀 <b>AWS DevOps Agent</b>"]:::aws
        HOLD -.-> SEC -.-> DEV
    end

    subgraph P["⑤ Pull Request  ·  live status"]
        PR["🔀 <b>PR opened</b><br/>sticky comment ⏳→✅<br/>results + findings + logs"]:::orch
    end

    subgraph H["⑥ Human — Level 3"]
        REVIEW{"<b>Approve?</b><br/>reviews RESULTS"}:::human
        COMMENT["💬 PR comment<br/><i>resume sandbox → iterate</i><br/>(bounded N rounds)"]:::human
    end

    subgraph TD["⑦ Merge + teardown"]
        MERGE["✅ merge PR"]:::teardown
        DESTROY["🧹 delete sandbox + PVC<br/>+ ephemeral test infra<br/>+ eval job"]:::teardown
        MERGE --> DESTROY --> DONE([🏁 done]):::teardown
    end

    START --> GHA --> ORCH
    CLAIM ==> CODER
    BUILD ==> HOLD
    DEV ==> PR
    PR ==> REVIEW
    REVIEW -->|changes requested| COMMENT
    COMMENT -.->|new instruction| CODER
    REVIEW -->|approve| MERGE

    linkStyle default stroke:#475569,stroke-width:1.5px;
```

---

## B.2 — Detailed sequence (who does what, and the trust boundary)

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontFamily':'ui-sans-serif, system-ui','fontSize':'13px','actorBkg':'#DBEAFE','actorBorder':'#2563EB','actorTextColor':'#0B1F3A','signalColor':'#334155','signalTextColor':'#0B1F3A','noteBkg':'#FEF9C3','noteBorderColor':'#CA8A04','loopTextColor':'#3B0764'}}}%%
sequenceDiagram
    autonumber
    actor Dev as 🧑‍💻 Human
    participant GH as 🐙 GitHub
    participant GHA as ⚙️ Action
    participant ORCH as 🎛️ Orchestrator<br/>(trusted · AWS IAM)
    participant POOL as 🔥 Warm pool
    box LightBlue 🛡️ Kata micro-VM · isolated · no cloud creds
    participant SBX as 🤖 Coder sandbox
    end
    participant EVAL as 🎯 Holdout evaluator
    participant AWS as ☁️ AWS Security /<br/>DevOps Agents

    Dev->>GH: open issue (label: dark-factory)
    GH->>GHA: issues.labeled event
    GHA->>ORCH: POST /run (issue #, repo, short-TTL token)
    ORCH->>POOL: SandboxClaim (key = issue-id)
    POOL-->>ORCH: bound warm sandbox (instant)
    Note over POOL: pool-manager provisions a REFILL

    ORCH->>SBX: write /workspace/SPEC.md + checkout df/issue-N
    activate SBX
    SBX->>SBX: implement · build · unit tests (until green)
    SBX-->>ORCH: artifacts/result.json (diff + logs)
    deactivate SBX

    Note over ORCH,EVAL: Verification is INDEPENDENT of the coder<br/>(coder never sees / edits the holdout)
    ORCH->>EVAL: run hidden BDD scenarios vs diff
    EVAL-->>ORCH: satisfaction % (different-model judge + real tests)
    ORCH->>AWS: invoke Security + DevOps agents on diff/artifacts
    AWS-->>ORCH: findings (advisory)

    ORCH->>GH: open PR + sticky status comment (⏳→✅)
    GH-->>Dev: review request (results, not code)

    loop bounded iterations (max N)
        Dev->>GH: PR comment (change requested)
        GH->>ORCH: comment webhook
        ORCH->>POOL: resume sandbox (scale 0→1, same PVC)
        ORCH->>SBX: apply comment as new instruction
        activate SBX
        SBX-->>ORCH: push update
        deactivate SBX
        ORCH->>GH: update sticky status
    end

    Dev->>GH: ✅ approve + merge
    GH->>ORCH: pull_request closed+merged
    ORCH->>POOL: release + delete sandbox + PVC
    ORCH->>ORCH: delete ephemeral test infra + eval job
    Note over ORCH: Reaper CronJob reaps any abandoned/timed-out run
```

---

## B.3 — Live PR status (the sticky comment the human watches)

The orchestrator maintains **one** PR comment, edited in place as each stage completes —
no comment spam, one canonical surface (the pattern Copilot/Devin/Factory converge on).

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontFamily':'ui-monospace, monospace','fontSize':'13px'}}}%%
flowchart TB
    classDef done fill:#DCFCE7,stroke:#16A34A,color:#052E16,rx:6,ry:6;
    classDef now  fill:#FEF9C3,stroke:#CA8A04,color:#422006,rx:6,ry:6;
    classDef wait fill:#F1F5F9,stroke:#94A3B8,color:#475569,rx:6,ry:6;

    H["🏭 <b>Dark Factory — issue #42</b>"]:::done
    A["✅ Claimed sandbox (spoke-dev) · 12:01"]:::done
    B["✅ Branch df/issue-42 · 12:01"]:::done
    C["✅ Implement · 12:04"]:::done
    D["✅ Build + unit tests · 12:07 · 📄 log"]:::done
    E["⏳ Security Agent…"]:::now
    F["⬜ DevOps Agent"]:::wait
    G["⬜ Holdout gate (0/12)"]:::wait
    I["⬜ PR ready for review"]:::wait
    H-->A-->B-->C-->D-->E-->F-->G-->I
```
