# Kata node pool provisioning

The `agent-sandbox` chart installs the Sandbox operator, RuntimeClasses, coder
template, and pool-manager — but Kata needs **hardware-virtualization nodes** to
actually run micro-VMs. On an **EKS Auto Mode** cluster (like the spokes), Auto
Mode's managed Bottlerocket nodes can't host Kata, so we add a **self-managed
nested-virt Managed Node Group** alongside Auto Mode. Coexistence + `/dev/kvm`
were validated by a live spike (see [`docs/dark-factory` §12a](../../../../../docs/dark-factory/README.md)).

## Files here

| File | Purpose |
|---|---|
| `kata-mng-eksctl.yaml` | eksctl `ClusterConfig` to add the kata MNG (declarative, simplest) |
| `kata-mng.tf` | Terraform launch template (`cpu_options.nested_virtualization=enabled`) + MNG — use when you need the nested-virt flag eksctl can't set. `terraform validate` passes. |
| `kata-mng-launch-template-userdata.mime` | The AL2023 **nodeadm MIME** userData (modprobe kvm_intel + join). Reference for either path. |

## ✅ PROVEN END-TO-END on EKS Auto Mode (spoke-dev, 2026-07-10)

Kata micro-VMs **do run on an Auto Mode cluster** via a self-managed nested-virt MNG.
Verified with a pod under `runtimeClassName: kata-clh`:

| | Value |
|---|---|
| Pod kernel (`uname -r` inside) | **`6.18.35`** — the Kata guest kernel |
| Host node kernel | `6.12.90-…amzn2023` |

Different kernels ⇒ the pod ran in a **real VM with hardware isolation**, not a container.

### The two Auto-Mode-specific prerequisites (the crux)

Auto Mode's built-in networking applies ONLY to its own managed nodes. A self-managed
MNG node has **neither the CNI nor kube-proxy** that pods need — so you MUST install
both EKS addons, or pods on the kata node can't reach the API server:

```
aws eks create-addon --cluster-name <cluster> --addon-name vpc-cni    --resolve-conflicts OVERWRITE
aws eks create-addon --cluster-name <cluster> --addon-name kube-proxy --resolve-conflicts OVERWRITE
```

- **Without `vpc-cni`** → node stays `NotReady` (`cni plugin not initialized`).
- **Without `kube-proxy`** → the node has no iptables rules for the `kubernetes.default.svc`
  (172.20.0.1) service IP, so **kata-deploy crashloops** with `Failed to get node ...
  client error (Connect)` — it connects to the API via the in-cluster service and times
  out. This was the real blocker (NOT the containerd restart, and not the nydus
  snapshotter — both were red herrings). Installing kube-proxy fixed it; kata-deploy then
  reached `1/1 Running` with **zero restarts** and installed the runtime cleanly.

Both `aws-node` and `kube-proxy` tolerate all taints (`operator: Exists`), so they land
on the tainted kata node automatically.

### The startup-taint gate (from openclaw PR #10)

The kata node registers with **two** taints:
- `kata=true:NoSchedule` — workload taint (only kata pods run here)
- `katacontainers.io/runtime-not-ready=true:NoSchedule` — **startup taint**; blocks all
  workloads until the runtime is installed. Set via nodeadm
  `--register-with-taints`. The **`kata-readiness` DaemonSet** watches kata-deploy's
  `/readyz` and removes this taint once install completes — proven to work here
  (`node ... untainted` in its log).

### IAM access-entry gotcha (lesson from this test)

If you recreate the node IAM role, its principal ID changes — **delete and recreate the
EKS access entry** (`type EC2_LINUX`) or the node's kubelet gets `Unauthorized` and never
registers. A stale access entry pointing at an old role ID is silent and confusing.

## Enablement sequence (per kata-capable cluster, e.g. spoke-dev)

1. **Provision the kata MNG** — apply the eksctl or Terraform manifest here. Nodes
   come up tainted `kata=true:NoSchedule`, labeled `kata-enabled=true`, with
   `/dev/kvm` (nested-virt) and `min=0` scale-to-zero. On Auto Mode, ensure the
   `vpc-cni` addon is installed (see prerequisite above) or the node stays NotReady.
2. **Install the runtime** — label the cluster secret `enable_agent_sandbox_kata=true`
   so the `kata-deploy` ArgoCD app (sync-wave 1) installs the containerd handlers.
3. **Install the capability** — label `enable_agent_sandbox=true` so the
   `agent-sandbox` app (sync-wave 2) installs the operator + RuntimeClasses +
   template + pool-manager.
4. **Enable the pool** — `warmPool.enabled=true` (default) pre-warms idle sandboxes.

> Both labels are set via the environment overlays (`gitops/overlays/environments/dev`).
> They are commented out today until a kata MNG exists on the spokes.

## Cost note

Nested-virt `c8i`/`m8i` nodes are more expensive than the `c6*` Auto Mode
defaults. `min=0` scale-to-zero + the pool-manager's idle scale-down keep cost
proportional to actual sandbox activity — you pay for kata nodes only while a
sandbox is claimed/warming.

## Teardown (spike lesson #2)

Delete the **MNG first and let it drain** (set `min/desired=0` beforehand). Don't
terminate the instance out from under the MNG — the ASG respawns and can wedge
the delete on a `Pending:Wait` lifecycle hook. Recover with
`aws autoscaling terminate-instance-in-auto-scaling-group` +
`complete-lifecycle-action`.
