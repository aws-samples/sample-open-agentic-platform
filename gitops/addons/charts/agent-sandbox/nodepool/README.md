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

## ⚠️ Prerequisite on EKS Auto Mode: install the `vpc-cni` addon

**Auto Mode clusters have NO `vpc-cni` addon** — Auto Mode's built-in networking
only applies to its own managed nodes. A self-managed MNG node will join but stay
`NotReady` with `cni plugin not initialized` until you install the standard CNI:

```
aws eks create-addon --cluster-name <cluster> --addon-name vpc-cni --resolve-conflicts OVERWRITE
```

`aws-node` tolerates all taints (`operator: Exists`), so it schedules onto the
tainted kata node automatically. (Discovered in live testing — lesson #4.)

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
