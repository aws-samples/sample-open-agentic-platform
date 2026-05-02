provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

data "aws_eks_cluster" "cluster" {
  name = var.eks_cluster_name
}

# ============================================================================
# Memory Module (Optional)
# ============================================================================

module "memory" {
  count  = var.enable_memory ? 1 : 0
  source = "../modules/memory"

  name                  = var.project_name
  description           = "Memory for ${var.project_name} agent"
  event_expiry_duration = 30

  tags = {
    Name    = "${var.project_name}-memory"
    Project = var.project_name
  }
}

# ============================================================================
# Browser Module (Optional)
# ============================================================================

module "browser" {
  count  = var.enable_browser ? 1 : 0
  source = "../modules/browser"

  name         = var.project_name
  description  = "Browser for ${var.project_name} agent"
  network_mode = var.network_mode

  tags = {
    Name    = "${var.project_name}-browser"
    Project = var.project_name
  }
}

# ============================================================================
# Code Interpreter Module (Optional)
# ============================================================================

module "code_interpreter" {
  count  = var.enable_code_interpreter ? 1 : 0
  source = "../modules/code-interpreter"

  name         = var.project_name
  description  = "Code Interpreter for ${var.project_name} agent"
  network_mode = var.network_mode

  tags = {
    Name    = "${var.project_name}-code-interpreter"
    Project = var.project_name
  }
}

# ============================================================================
# IAM Role for EKS Pod (IRSA)
# ============================================================================

resource "aws_iam_role" "strands_agent_role" {
  name = "${var.project_name}-strands-agent-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "pods.eks.amazonaws.com"
      }
      Action = [
        "sts:AssumeRole",
        "sts:TagSession"
      ]
    }]
  })
}

# ============================================================================
# S3 Bucket for Results
# ============================================================================

resource "aws_s3_bucket" "results" {
  bucket = "${var.project_name}-weather-results"

  tags = {
    Name    = "${var.project_name}-weather-results"
    Project = var.project_name
  }
}

resource "aws_s3_bucket_versioning" "results" {
  bucket = aws_s3_bucket.results.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_iam_role_policy" "strands_agent_policy" {
  role = aws_iam_role.strands_agent_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "bedrock:InvokeAgentCoreTool",
          "bedrock-agentcore:*"
        ]
        Resource = [
          "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:agent-core-tool/*",
          "arn:aws:bedrock-agentcore:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream"
        ]
        Resource = "arn:aws:bedrock:*::foundation-model/*"
      },
      {
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream"
        ]
        Resource = "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.results.arn,
          "${aws_s3_bucket.results.arn}/*"
        ]
      }
    ]
  })
}

# ============================================================================
# Pod Identity Association
# ============================================================================

resource "aws_eks_pod_identity_association" "strands_agent" {
  cluster_name    = var.eks_cluster_name
  namespace       = "agent-core-infra"
  service_account = "strands-agent-sa-${var.project_name}"
  role_arn        = aws_iam_role.strands_agent_role.arn
}

# Pod Identity Association for MCP Server
resource "aws_eks_pod_identity_association" "mcp_server" {
  cluster_name    = var.eks_cluster_name
  namespace       = "agent-core-infra"
  service_account = "${var.project_name}-mcp-sa"
  role_arn        = aws_iam_role.strands_agent_role.arn
}

# Pod Identity Association for KAgent Agent
resource "aws_eks_pod_identity_association" "kagent_agent" {
  cluster_name    = var.eks_cluster_name
  namespace       = "agent-core-infra"
  service_account = "${var.project_name}-agent-sa"
  role_arn        = aws_iam_role.strands_agent_role.arn
}
