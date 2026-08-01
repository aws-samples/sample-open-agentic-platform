{{/*
Common labels
*/}}
{{- define "application-sets.labels" -}}
app.kubernetes.io/managed-by: argocd
app.kubernetes.io/part-of: agent-platform
{{- end }}

{{/*
Common annotations
*/}}
{{- define "application-sets.annotations" -}}
{{- end }}

{{/*
Generate valueFiles list for an addon
*/}}
{{- define "application-sets.valueFiles" -}}
{{- $nameNormalize := .nameNormalize -}}
{{- $chartConfig := .chartConfig -}}
{{- $valueFiles := .valueFiles -}}
{{- $values := .values -}}
{{- range $valueFiles }}
- '$values/{{$.values.repoURLGitBasePath}}{{ . }}/{{ $nameNormalize }}/values.yaml'
{{- end }}
{{- if $.values.useValuesFilePrefix }}
{{- range $valueFiles }}
- '$values/{{$.values.repoURLGitBasePath}}{{ $.values.valuesFilePrefix }}{{ . }}/{{ $nameNormalize }}/values.yaml'
{{- end }}
{{- end }}
{{- end }}
