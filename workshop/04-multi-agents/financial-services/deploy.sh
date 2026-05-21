#!/bin/bash

# Build and push Docker image
echo "Building financial tools Docker image..."
cd /Users/elamaras/WorkDocsDownloads/AWS_Internal/Containers/agent-platform-amazon-eks/multi-agents/financial-services

podman build --platform linux/amd64 -t 940019131157.dkr.ecr.us-west-2.amazonaws.com/financial-tools:latest .
podman push 940019131157.dkr.ecr.us-west-2.amazonaws.com/financial-tools:latest

echo "Deploying to Kubernetes..."

# Deploy tools server
kubectl apply -f financial-tools-deployment.yaml
echo "Waiting for tools server to be ready..."
sleep 20

# Deploy MCP server
kubectl apply -f financial-tools-mcpserver.yaml
echo "Waiting for MCP server to discover tools..."
sleep 15

# Deploy specialist agents
kubectl apply -f portfolio-analyst-agent.yaml
kubectl apply -f risk-assessment-agent.yaml
kubectl apply -f market-data-agent.yaml
echo "Waiting for specialist agents to be ready..."
sleep 10

# Deploy orchestrator agent
kubectl apply -f financial-advisor-agent.yaml

echo "Deployment complete!"
echo ""
echo "Check status with:"
echo "  kubectl get remotemcpserver financial-tools-server -n kagent"
echo "  kubectl get agents -n kagent | grep -E 'portfolio|risk|market|financial'"
echo ""
echo "Test the financial advisor:"
echo "  Ask: 'I have 100 AAPL and 50 GOOGL shares. Is my portfolio balanced for medium risk tolerance?'"
