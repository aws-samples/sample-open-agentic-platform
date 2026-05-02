# Agent Core MCP Server

MCP (Model Context Protocol) server exposing Bedrock AgentCore capabilities as tools for KAgent agents.

## Tools

| Tool | Description | AgentCore Capability |
|------|-------------|---------------------|
| `get_weather_data` | Get weather data for a city using browser automation | Browser |
| `generate_analysis_code` | Generate Python code for weather classification | LLM (Bedrock) |
| `execute_code` | Execute Python code in a sandbox | Code Interpreter |
| `store_user_preferences` | Store user activity preferences | Memory |
| `get_activity_preferences` | Retrieve user activity preferences | Memory |
| `store_activity_plan` | Store activity plan for future reference | Memory |

## Environment Variables

| Variable | Description | Source |
|----------|-------------|--------|
| `AWS_REGION` | AWS region | Helm chart value |
| `MEMORY_ID` | AgentCore Memory resource ID | Terraform outputs secret |
| `BROWSER_ID` | AgentCore Browser resource ID | Terraform outputs secret |
| `CODE_INTERPRETER_ID` | AgentCore Code Interpreter resource ID | Terraform outputs secret |

## Build and Push

```bash
REGION="us-east-1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Create ECR repository (one-time)
aws ecr create-repository --repository-name agent-core-mcp --region $REGION

# Build and push
aws ecr get-login-password --region $REGION | \
  docker login --username AWS --password-stdin ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com
docker build --platform linux/amd64 -t agent-core-mcp:latest .
docker tag agent-core-mcp:latest ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/agent-core-mcp:latest
docker push ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/agent-core-mcp:latest
```

## Local Testing

```bash
pip install -r requirements.txt
MEMORY_ID=test BROWSER_ID=test CODE_INTERPRETER_ID=test python server.py
# Server runs at http://localhost:8080/mcp
# Health check at http://localhost:8080/health
```

## Dependencies

- `fastmcp>=2.0.0` — MCP server framework (uses streamable HTTP transport)
- `bedrock-agentcore>=0.1.0` — Bedrock AgentCore SDK (Memory, Browser, Code Interpreter)
- `browser-use>=0.1.0` — Browser automation
- `langchain-aws>=0.2.0` — Bedrock LLM integration
- `langfuse>=3.12.0` — LLM observability (optional)
