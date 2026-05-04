output "memory_id" {
  description = "Memory ID"
  value       = var.enable_memory ? module.memory[0].memory_id : null
}

output "browser_id" {
  description = "Browser ID"
  value       = var.enable_browser ? module.browser[0].browser_id : null
}

output "browser_arn" {
  description = "Browser ARN"
  value       = var.enable_browser ? module.browser[0].browser_arn : null
}

output "code_interpreter_id" {
  description = "Code Interpreter ID"
  value       = var.enable_code_interpreter ? module.code_interpreter[0].code_interpreter_id : null
}

output "code_interpreter_arn" {
  description = "Code Interpreter ARN"
  value       = var.enable_code_interpreter ? module.code_interpreter[0].code_interpreter_arn : null
}

output "strands_agent_role_arn" {
  description = "IAM Role ARN for Strands Agent"
  value       = aws_iam_role.strands_agent_role.arn
}

output "results_bucket_name" {
  description = "S3 bucket name for results"
  value       = aws_s3_bucket.results.id
}

output "service_account_name" {
  description = "ServiceAccount name for Pod Identity"
  value       = "strands-agent-sa-${replace(var.project_name, "ekspoc-", "")}"
}

output "namespace" {
  description = "Kubernetes namespace"
  value       = "agent-core-infra"
}
