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

## ⚠️ Known blocker: kata-deploy vs the VPC-CNI on Auto Mode (lesson #5)

Live testing found kata-deploy **crashloops** on a self-managed MNG node in an
Auto Mode cluster and never finishes installing the runtime. Root cause: kata-deploy
patches containerd and **restarts it**; because the VPC-CNI runs as `aws-node` pods
*on that same containerd*, the restart briefly drops node networking, and
kata-deploy's next Kubernetes API call fails (`Failed to get node ... client error
(Connect)`) → the pod exits and CrashLoopBackOffs *before* completing the install.
Disabling the experimental nydus snapshotter (`snapshotter.setup: []`) did **not**
resolve it — the containerd restart itself is the trigger.

**Everything up to the runtime install is proven** (node joins Ready, `/dev/kvm`,
kata labels/taint, kata-deploy schedules only on the kata node). Options to finish:

1. **Bake Kata into a custom AMI** (Packer) so no on-node containerd patch/restart is
   needed at runtime — the most robust path on Auto Mode clusters.
2. **Follow openclaw's model** — a self-managed Karpenter (not Auto Mode) where the
   CNI/containerd lifecycle is fully controlled and kata-deploy's restart is tolerated.
3. Investigate a kata-deploy mode that configures containerd **without a full restart**,
   or pin `aws-node` to not depend on the restarted containerd during install.

This is a **kata-deploy-on-Auto-Mode** integration issue, not a flaw in the
`agent-sandbox` chart (operator/RuntimeClasses/template/pool-manager all render and
apply fine).

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
