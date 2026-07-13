# Flow A — Agent Sandbox Capability (permanent platform feature)

The **Agent Sandbox** capability ships as a first-class agent-platform GitOps addon. When the
platform is deployed, it stands up the Kata (Cloud Hypervisor) micro-VM runtime, the `Sandbox`
CRD + operator, and a **warm pool** of pre-provisioned, hardware-isolated sandboxes kept ready by
the operator's native `SandboxWarmPool`. This is independent of the Dark Factory — it is the
reusable isolation substrate any agent workload can claim.

> **Hosted on the hub cluster** — the build/author plane, co-located with Argo Workflows so Flow B
> orchestrates the pool single-cluster. Because the hub runs EKS Auto Mode (which can't host Kata)
> and the fleet control plane (Keycloak/ArgoCD/external-secrets), the capability requires a
> **dedicated tainted nested-virt nodegroup** and **control-plane egress lockdown** — see
> [README §3](../README.md#3-flow-a--agent-sandbox-capability-permanent-platform-feature) and
> [§10](../README.md#10-security-model).

> Palette: **gray** = neutral · **orange** = active/warm · **green** = ready/verified ·
> **pink** = fenced-off control plane · dashed = feedback/enforcement.

---

## A.1 — Capability architecture

```mermaid
%%{init: {'theme':'base','themeVariables':{
  'fontFamily':'Amazon Ember, Helvetica, Arial, sans-serif','fontSize':'14px',
  'primaryColor':'#F2F4F7','primaryBorderColor':'#B6C0CC','primaryTextColor':'#1B2733',
  'lineColor':'#8B99A7','clusterBkg':'#FBFCFD','clusterBorder':'#C7D0DA'}}}%%
flowchart TB
    classDef active  fill:#F59E0B,stroke:#D67E00,color:#1B2733,stroke-width:1.5px;
    classDef ok      fill:#10B981,stroke:#0E9A6C,color:#FFFFFF,stroke-width:1.3px;
    classDef node    fill:#FDE7C7,stroke:#E0A960,color:#1B2733,stroke-width:1.2px;
    classDef vm      fill:#FFF3E0,stroke:#F59E0B,color:#1B2733,stroke-width:1.4px;
    classDef guard   fill:#FCE7EA,stroke:#E0555F,color:#7A2531,stroke-width:1.3px;
    classDef neutral fill:#ECEFF3,stroke:#B6C0CC,color:#1B2733,stroke-width:1px;

    subgraph GITOPS["🚀  GitOps enablement · ArgoCD app-of-apps"]
        direction LR
        FLAG["alwaysSelector<br/>environment In [control-plane]<br/>→ hub only"]:::active
        APPSET["ApplicationSet<br/>cluster-generator<br/>sync-wave 0 → 1 → 2"]:::node
        FLAG --> APPSET
    end

    subgraph HUB["☸️  Hub cluster · build / author plane"]
    direction TB

        subgraph CP["🔐  Control plane — fenced off"]
            direction LR
            KC["Keycloak · ArgoCD · external-secrets"]:::guard
        end

        subgraph OPER["🧩  Sandbox control plane"]
            direction LR
            CRD["CRDs · extensions.agents.x-k8s.io/v1beta1<br/>Sandbox · SandboxClaim · SandboxTemplate · SandboxWarmPool"]:::node
            OPCTL["agent-sandbox operator<br/>(vendored v0.5.1)"]:::node
            WP["SandboxWarmPool<br/>coder-warmpool · keeps N idle · refills"]:::active
            CRD --- OPCTL --- WP
        end

        subgraph WARM["🔥  Warm pool · target buffer = 2–3 idle"]
            direction LR
            S1(["idle · sandbox-1"]):::vm
            S2(["idle · sandbox-2"]):::vm
            S3(["idle · sandbox-3"]):::vm
        end

        subgraph KATA["🛡️  Tainted nested-virt nodegroup · kata=true:NoSchedule"]
            direction LR
            RC["RuntimeClasses<br/>kata-clh · kata-qemu"]:::node
            KD["kata-deploy<br/>DaemonSet"]:::node
            MNG["nested-virt MNG<br/>c8i/m8i · /dev/kvm · min=0"]:::node
            RC --- KD --- MNG
        end

        NP{{"⛔ NetworkPolicy — deny control-plane + IMDS ·<br/>allow DNS + Bifrost + GitHub"}}:::guard
        MODEL["🧠 Bifrost LLM gateway<br/>bifrost.bifrost.svc:8080 → Bedrock"]:::ok
    end

    APPSET ==> OPER
    APPSET ==> KATA
    WP ==> WARM
    WARM -.runs on.-> KATA
    WARM -.model access.-> MODEL
    NP -. enforces .- WARM
    WARM -. blocked .-x CP

    class GITOPS,HUB,CP,OPER,WARM,KATA band
    linkStyle default stroke:#8B99A7,stroke-width:1.4px;
```

---

## A.2 — Warm-pool cycling (claim ↔ refill ↔ shrink)

The operator keeps a steady buffer of idle sandboxes so a consumer (e.g. the Dark Factory) binds to
a **ready** VM instantly instead of paying cold-start. Idle sandboxes use the `Sandbox`
`replicas: 0/1` **scale subresource**, so "idle" is cheap.

```mermaid
%%{init: {'theme':'base','themeVariables':{
  'fontFamily':'Amazon Ember, Helvetica, Arial, sans-serif','fontSize':'14px',
  'primaryColor':'#F59E0B','primaryBorderColor':'#D67E00','primaryTextColor':'#1B2733',
  'lineColor':'#8B99A7','labelColor':'#1B2733'}}}%%
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

    classDef prov   fill:#ECEFF3,stroke:#B6C0CC,color:#1B2733;
    classDef idle   fill:#FDE7C7,stroke:#E0A960,color:#1B2733;
    classDef active fill:#F59E0B,stroke:#D67E00,color:#1B2733;
    classDef paused fill:#ECEFF3,stroke:#B6C0CC,color:#5A6675;
    classDef gone   fill:#FCE7EA,stroke:#E0555F,color:#7A2531;
    class Provisioning prov
    class Idle idle
    class Claimed active
    class Paused paused
    class Retired gone

    note right of Claimed
        On CLAIM the operator provisions
        a REFILL so the buffer stays at target.
    end note
    note right of Retired
        On RELEASE, if the pool is above target,
        the extra idle sandbox is removed.
    end note
```
