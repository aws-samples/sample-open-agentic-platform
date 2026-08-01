{{- define "dark-factory.labels" -}}
app.kubernetes.io/name: dark-factory
app.kubernetes.io/part-of: dark-factory
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}
