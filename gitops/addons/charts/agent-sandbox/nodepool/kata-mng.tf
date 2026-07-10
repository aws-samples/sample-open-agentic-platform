# Terraform variant: nested-virt Kata Managed Node Group + launch template for
# an existing EKS Auto Mode cluster. Use this path when you need the launch
# template's CpuOptions.NestedVirtualization flag (eksctl cannot set it).
# Validated by the 2026-07-10 spike (docs/dark-factory §12a).
#
# Requires: aws provider (nested_virtualization support), AWS API/CLI vintage
# that exposes cpu_options.nested_virtualization.

variable "cluster_name" {
  type    = string
  default = "spoke-dev"
}
variable "region" {
  type    = string
  default = "us-west-2"
}
variable "subnet_ids" {
  type = list(string)
}
variable "node_role_arn" {
  type = string
}
variable "instance_type" {
  type    = string
  default = "c8i.4xlarge"
}
variable "kata_max_size" {
  type    = number
  default = 3
}

# EKS-optimized AL2023 AMI for the cluster's k8s version (nodeadm bootstrap).
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/eks/optimized-ami/1.35/amazon-linux-2023/x86_64/standard/recommended/image_id"
}

# Cluster endpoint/CA/cidr — REQUIRED in the NodeConfig when using a custom AMI
# (lesson #3, live test): nodeadm does not auto-discover these with a custom
# ImageId and fails with "Apiserver endpoint is missing in cluster configuration".
data "aws_eks_cluster" "this" {
  name = var.cluster_name
}

locals {
  # MIME userData: modprobe kvm_intel (so /dev/kvm exists) + nodeadm NodeConfig
  # that joins the cluster with the kata labels/taint. See §12a lessons #1 + #3.
  kata_userdata = base64encode(<<-MIME
    MIME-Version: 1.0
    Content-Type: multipart/mixed; boundary="//"

    --//
    Content-Type: text/x-shellscript; charset="us-ascii"

    #!/bin/bash
    modprobe kvm_intel
    printf 'kvm\nkvm_intel\n' > /etc/modules-load.d/kvm.conf

    --//
    Content-Type: application/node.eks.aws

    apiVersion: node.eks.aws/v1alpha1
    kind: NodeConfig
    spec:
      cluster:
        name: ${var.cluster_name}
        apiServerEndpoint: ${data.aws_eks_cluster.this.endpoint}
        certificateAuthority: ${data.aws_eks_cluster.this.certificate_authority[0].data}
        cidr: ${data.aws_eks_cluster.this.kubernetes_network_config[0].service_ipv4_cidr}
      kubelet:
        flags:
          - "--node-labels=kata-enabled=true,katacontainers.io/kata-runtime=true,node-type=kata-mng"
          - "--register-with-taints=kata=true:NoSchedule"
    --//--
  MIME
  )
}

resource "aws_launch_template" "kata" {
  name_prefix = "${var.cluster_name}-kata-"
  image_id    = data.aws_ssm_parameter.al2023.value
  user_data   = local.kata_userdata

  cpu_options {
    # THE key flag — exposes VT-x on 8i instances so kata's VMM can run guests.
    nested_virtualization = "enabled"
  }

  tag_specifications {
    resource_type = "instance"
    tags          = { platform = "open-agent-platform", capability = "agent-sandbox" }
  }
}

resource "aws_eks_node_group" "kata" {
  cluster_name    = var.cluster_name
  node_group_name = "kata-sandbox"
  node_role_arn   = var.node_role_arn
  subnet_ids      = var.subnet_ids

  # Scale-to-zero when no sandbox is claimed; pool-manager / consumer scales up.
  scaling_config {
    min_size     = 0
    desired_size = 1
    max_size     = var.kata_max_size
  }

  launch_template {
    id      = aws_launch_template.kata.id
    version = aws_launch_template.kata.latest_version
  }

  # Only kata sandboxes tolerate this — keeps general workloads off the pool.
  taint {
    key    = "kata"
    value  = "true"
    effect = "NO_SCHEDULE"
  }

  labels = {
    "kata-enabled"                   = "true"
    "katacontainers.io/kata-runtime" = "true"
    "node-type"                      = "kata-mng"
  }

  tags = { platform = "open-agent-platform", capability = "agent-sandbox" }
}
