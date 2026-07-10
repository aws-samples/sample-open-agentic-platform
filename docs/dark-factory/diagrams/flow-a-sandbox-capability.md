# Flow A — Agent Sandbox Capability (permanent platform feature)

The **Agent Sandbox** capability ships as a first-class agent-platform GitOps addon. When the
platform is deployed, it stands up the Kata (Cloud Hypervisor) micro-VM runtime, the `Sandbox`
CRD + operator, and a **warm pool** of pre-provisioned, hardware-isolated sandboxes kept ready by
a pool-manager controller. This is independent of the Dark Factory — it is the reusable isolation
substrate any agent workload can claim.

---

## A.1 — Capability architecture

```mermaid
%%{init: {'theme':'base','themeVariables':{
  'fontFamily':'Amazon Ember, Helvetica, Arial, sans-serif','fontSize':'14px',
  'primaryColor':'#2E3E50','primaryBorderColor':'#5F7185','primaryTextColor':'#FFFFFF',
  'lineColor':'#8B99A7','clusterBkg':'#26374A','clusterBorder':'#5F7185',
  'tertiaryColor':'#1B2733'}}}%%
flowchart TB
    classDef canvas  fill:#1B2733,stroke:#1B2733,color:#FFFFFF;
    classDef band    fill:#26374A,stroke:#5F7185,color:#E8EDF2,stroke-width:1px;
    classDef node    fill:#2E4257,stroke:#7C8FA3,color:#FFFFFF,stroke-width:1.2px;
    classDef accent  fill:#FF9900,stroke:#EC7211,color:#161E2D,stroke-width:1.5px;
    classDef warm    fill:#22384A,stroke:#FF9900,color:#FFFFFF,stroke-width:1.4px;
    classDef muted   fill:#243244,stroke:#415266,color:#AEB8C4,stroke-width:1px;

    subgraph CANVAS["  "]
    direction TB

        subgraph GITOPS["🚀  GitOps enablement · ArgoCD app-of-apps"]
            direction LR
            FLAG["enable_agent_sandbox: true<br/>overlays/environments/dev,prod"]:::accent
            APPSET["ApplicationSet<br/>cluster-generator<br/>sync-wave −1 → 1"]:::node
            FLAG --> APPSET
        end

        subgraph CLUSTER["☸️  spoke-dev  &amp;  spoke-prod  ·  capability on both"]
            direction TB

            subgraph OPER["🧩  Sandbox control plane"]
                direction LR
                CRD["Sandbox CRD<br/>agents.x-k8s.io/v1alpha1<br/>+ SandboxTemplate + SandboxClaim"]:::node
                OPCTL["agent-sandbox<br/>operator"]:::node
                POOL["pool-manager<br/>keeps N idle · refills · shrinks"]:::accent
                CRD --- OPCTL --- POOL
            end

            subgraph WARM["🔥  Warm pool · target buffer = 2–3 idle"]
                direction LR
                S1(["idle · sandbox-1"]):::warm
                S2(["idle · sandbox-2"]):::warm
                S3(["idle · sandbox-3"]):::warm
            end

            subgraph KATA["🛡️  Kata micro-VM runtime · hardware isolation"]
                direction LR
                RC["RuntimeClasses<br/>kata-clh · kata-qemu · kata-fc"]:::node
                KD["kata-deploy<br/>DaemonSet"]:::node
                NP["Karpenter pools<br/>kata-nested c8i/m8i · kata-metal"]:::node
                RC --- KD --- NP
            end

            MODEL["🧠  LiteLLM gateway<br/>litellm.litellm.svc:4000 → Bedrock"]:::node
        end
    end

    APPSET ==> OPER
    APPSET ==> KATA
    POOL   ==> WARM
    WARM   -.-> KATA
    WARM   -.-> MODEL

    class CANVAS canvas
    class GITOPS,CLUSTER,OPER,WARM,KATA band
    linkStyle default stroke:#8B99A7,stroke-width:1.4px;
    linkStyle 7 stroke:#FF9900,stroke-width:2px;
```

---

## A.2 — Warm-pool cycling (claim ↔ refill ↔ shrink)

The pool-manager keeps a steady buffer of idle sandboxes so a consumer (e.g. the Dark Factory)
binds to a **ready** VM instantly instead of paying cold-start. Idle sandboxes use the `Sandbox`
`replicas: 0/1` **scale subresource**, so "idle" is cheap.

```mermaid
%%{init: {'theme':'base','themeVariables':{
  'fontFamily':'Amazon Ember, Helvetica, Arial, sans-serif','fontSize':'14px',
  'primaryColor':'#2E4257','primaryBorderColor':'#7C8FA3','primaryTextColor':'#FFFFFF',
  'lineColor':'#8B99A7','labelColor':'#E8EDF2'}}}%%
stateDiagram-v2
    direction LR
    [*] --> Provisioning : pool below target
    Provisioning --> Idle : VM booted · replicas=1 · unclaimed
    Idle --> Claimed : SandboxClaim binds
    Claimed --> Idle : claim released · recyclable
    Idle --> Paused : idle TTL · scale replicas=0 · PVC kept
    Paused --> Idle : demand returns · scale replicas=1
    Claimed --> Retired : consumer done · delete Sandbox+PVC
    Idle --> Retired : pool above target · shrink
    Retired --> [*]

    note right of Claimed
        On CLAIM the pool-manager provisions
        a REFILL so the buffer stays at target.
    end note
    note right of Retired
        On RELEASE, if the pool is above target,
        the extra idle sandbox is removed.
    end note
```
