# Flow A — Agent Sandbox Capability (permanent platform feature)

The **Agent Sandbox** capability ships as a first-class agent-platform GitOps addon. When
the platform is deployed, it stands up the Kata (Cloud Hypervisor) micro-VM runtime, the
`Sandbox` CRD + operator, and a **warm pool** of pre-provisioned, hardware-isolated sandboxes
kept ready by a pool-manager controller. This is independent of the Dark Factory — it is the
reusable isolation substrate any agent workload can claim.

---

## A.1 — Capability architecture

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontFamily':'ui-sans-serif, system-ui','fontSize':'14px','primaryColor':'#EAF2FF','primaryBorderColor':'#2563EB','primaryTextColor':'#0B1F3A','lineColor':'#64748B','clusterBkg':'#F8FAFC','clusterBorder':'#CBD5E1'}}}%%
flowchart TB
    classDef gitops   fill:#EDE9FE,stroke:#7C3AED,stroke-width:1.5px,color:#2E1065,rx:8,ry:8;
    classDef control  fill:#DBEAFE,stroke:#2563EB,stroke-width:1.5px,color:#0B1F3A,rx:8,ry:8;
    classDef warm     fill:#DCFCE7,stroke:#16A34A,stroke-width:1.5px,color:#052E16,rx:10,ry:10;
    classDef node     fill:#FEF3C7,stroke:#D97706,stroke-width:1.5px,color:#451A03,rx:8,ry:8;
    classDef model    fill:#FCE7F3,stroke:#DB2777,stroke-width:1.5px,color:#500724,rx:8,ry:8;
    classDef vm       fill:#F1F5F9,stroke:#0EA5E9,stroke-width:2px,color:#0C4A6E,rx:6,ry:6;

    subgraph GITOPS["🚀  GitOps enablement  ·  ArgoCD app-of-apps"]
        direction LR
        FLAG["<b>enable_agent_sandbox: true</b><br/><i>overlays/environments/&#123;dev,prod&#125;</i>"]:::gitops
        APPSET["ApplicationSet<br/>cluster-generator<br/><i>sync-wave −1 → 1</i>"]:::gitops
        FLAG --> APPSET
    end

    subgraph CLUSTER["☸️  spoke-dev  &amp;  spoke-prod  (capability on both)"]
        direction TB

        subgraph OPER["🧩  Sandbox control plane"]
            direction LR
            CRD["<b>Sandbox CRD</b><br/>agents.x-k8s.io/v1alpha1<br/>+ SandboxTemplate<br/>+ SandboxClaim"]:::control
            OPCTL["agent-sandbox<br/>operator"]:::control
            POOL["<b>pool-manager</b><br/>controller<br/><i>keeps N idle · refills · shrinks</i>"]:::control
            CRD --- OPCTL --- POOL
        end

        subgraph WARM["🔥  Warm pool  ·  target buffer = 2–3 idle"]
            direction LR
            S1(["🟢 idle<br/>sandbox-1"]):::warm
            S2(["🟢 idle<br/>sandbox-2"]):::warm
            S3(["🟢 idle<br/>sandbox-3"]):::warm
        end

        subgraph KATA["🛡️  Kata micro-VM runtime  (hardware isolation)"]
            direction LR
            RC["RuntimeClasses<br/><b>kata-clh</b> · kata-qemu · kata-fc"]:::vm
            NP["Karpenter pools<br/>kata-nested (c8i/m8i)<br/>kata-metal (fallback)"]:::node
            KD["kata-deploy<br/>DaemonSet"]:::vm
            RC --- KD --- NP
        end

        MODEL["🧠  LiteLLM gateway<br/>litellm.litellm.svc:4000<br/><i>→ Bedrock via Pod Identity</i>"]:::model
    end

    APPSET ==>|renders| OPER
    APPSET ==>|renders| KATA
    POOL ==>|creates / scales<br/>Sandbox CRs| WARM
    WARM -.->|scheduled onto| KATA
    WARM -.->|model calls<br/>egress-locked| MODEL

    linkStyle default stroke:#64748B,stroke-width:1.5px;
```

---

## A.2 — Warm-pool cycling (claim ↔ refill ↔ shrink)

The pool-manager keeps a steady buffer of idle sandboxes so a consumer (e.g. the Dark
Factory) binds to a **ready** VM instantly instead of paying cold-start. Idle sandboxes use
the `Sandbox` `replicas: 0/1` **scale subresource**, so "idle" is cheap.

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontFamily':'ui-sans-serif, system-ui','fontSize':'14px','primaryColor':'#DCFCE7','primaryBorderColor':'#16A34A','primaryTextColor':'#052E16','lineColor':'#16A34A'}}}%%
stateDiagram-v2
    direction LR
    [*] --> Provisioning : pool below target
    Provisioning --> Idle : VM booted, replicas=1, unclaimed
    Idle --> Claimed : SandboxClaim binds (consumer arrives)
    Claimed --> Idle : claim released, VM recyclable
    Idle --> Paused : idle TTL — scale replicas=0 (PVC kept)
    Paused --> Idle : demand returns — scale replicas=1
    Claimed --> Retired : consumer done → delete Sandbox+PVC
    Idle --> Retired : pool above target → shrink
    Retired --> [*]

    note right of Claimed
        On CLAIM the pool-manager
        provisions a REFILL so the
        buffer stays at target (2–3).
    end note
    note right of Retired
        On RELEASE, if the pool is
        above target, the extra idle
        sandbox is removed.
    end note
```
