{{/*
Common labels applied to every resource this chart renders.
*/}}
{{- define "agent-sandbox.labels" -}}
app.kubernetes.io/name: agent-sandbox
app.kubernetes.io/part-of: open-agent-platform
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/*
Selector labels (stable subset used by Services / controllers).
*/}}
{{- define "agent-sandbox.selectorLabels" -}}
app.kubernetes.io/name: agent-sandbox
{{- end -}}

{{/*
The namespace the capability runs in.
*/}}
{{- define "agent-sandbox.namespace" -}}
{{- default "agent-sandbox-system" .Values.namespace -}}
{{- end -}}

{{/*
Kata node nodeadm MIME userData (for the nested-virt Launch Template).
Loads kvm_intel so /dev/kvm exists, then joins the cluster via nodeadm NodeConfig
with the kata labels + two taints:
  - kata=true:NoSchedule                                  (workload taint)
  - katacontainers.io/runtime-not-ready=true:NoSchedule   (startup gate; the
    kata-readiness DaemonSet removes it once kata-deploy finishes installing)
Cluster endpoint/CA/CIDR are REQUIRED with a custom AMI — nodeadm can't discover
them otherwise (validated lesson, docs/dark-factory §12a).
*/}}
{{- define "agent-sandbox.kataUserData" -}}
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
    name: {{ .Values.nodepool.clusterName }}
    apiServerEndpoint: {{ .Values.nodepool.clusterEndpoint }}
    certificateAuthority: {{ .Values.nodepool.clusterCA }}
    cidr: {{ .Values.nodepool.serviceCidr }}
  kubelet:
    flags:
      - "--node-labels=kata-enabled=true,katacontainers.io/kata-runtime=true,node-type=kata-mng"
      - "--register-with-taints=kata=true:NoSchedule,katacontainers.io/runtime-not-ready=true:NoSchedule"
--//--
{{- end -}}
