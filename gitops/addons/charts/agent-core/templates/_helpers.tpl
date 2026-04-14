{{/*
Resource name prefix
*/}}
{{- define "agent-core.name" -}}
{{- .Values.global.projectName | default "agent-core" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Namespace
*/}}
{{- define "agent-core.namespace" -}}
agent-core-infra
{{- end }}

{{/*
Common labels
*/}}
{{- define "agent-core.labels" -}}
app.kubernetes.io/managed-by: argocd
app.kubernetes.io/part-of: agent-platform
app.kubernetes.io/component: agent-core
{{- end }}
