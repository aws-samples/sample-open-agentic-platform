# Agent Platform on Amazon EKS

Multi-agent systems using Kagent, MCP (Model Context Protocol), and A2A (Agent-to-Agent) on Amazon EKS.

## Examples

### 1. Multi-Tool Agent (`multi-tool-agent/`)
Simple agent with multiple tools (calculator, web search, weather, datetime) via MCP server.

**Deploy:**
```bash
cd multi-tool-agent
kubectl apply -f tools-server-deployment.yaml
kubectl apply -f kagent-remotemcpserver.yaml
kubectl apply -f smart-assistant-agent.yaml
```

### 2. Financial Services Multi-Agent (`multi-agents/financial-services/`)
Comprehensive financial services example with:
- **MCP Tools**: Portfolio valuation, stock prices, risk assessment, market trends
- **Specialist Agents**: Portfolio Analyst, Risk Assessment, Market Data
- **Orchestrator Agent**: Financial Advisor (uses A2A to delegate to specialists)

**Deploy:**
```bash
cd multi-agents/financial-services
kubectl apply -f financial-tools-deployment.yaml
kubectl apply -f financial-tools-mcpserver.yaml
kubectl apply -f portfolio-analyst-agent.yaml
kubectl apply -f risk-assessment-agent.yaml
kubectl apply -f market-data-agent.yaml
kubectl apply -f financial-advisor-agent.yaml
```

## Architecture

- **MCP (Model Context Protocol)**: Shared tools via STREAMABLE_HTTP protocol
- **A2A (Agent-to-Agent)**: Agents delegate tasks to specialized agents
- **Kagent CRDs**: All wired through Kubernetes custom resources
  - `RemoteMCPServer`: Defines MCP tool servers
  - `Agent`: Defines AI agents with tools and A2A capabilities

## Prerequisites

- Amazon EKS cluster with Kagent installed
- ECR repositories for container images
- AWS Bedrock access for Claude models

## Key Concepts

### MCP Server
Exposes tools via Model Context Protocol:
```yaml
apiVersion: kagent.dev/v1alpha2
kind: RemoteMCPServer
metadata:
  name: my-tools-server
spec:
  protocol: STREAMABLE_HTTP
  url: http://my-tools-server:8080/mcp
```

### Agent with Tools
```yaml
apiVersion: kagent.dev/v1alpha2
kind: Agent
metadata:
  name: my-agent
spec:
  declarative:
    modelConfig: bedrock-anthropic-claude-3-5-sonnet
    tools:
      - type: McpServer
        mcpServer:
          kind: RemoteMCPServer
          name: my-tools-server
          toolNames:
            - tool1
            - tool2
```

### Agent with A2A
```yaml
apiVersion: kagent.dev/v1alpha2
kind: Agent
metadata:
  name: orchestrator
spec:
  declarative:
    tools:
      - type: Agent
        agent:
          kind: Agent
          name: specialist-agent
```

## License

MIT
