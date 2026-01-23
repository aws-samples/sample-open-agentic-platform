# KGateway Implementation Blueprint for AI Agents

## Overview
KGateway provides secure, observable connectivity, routing, and policy management for AI agents, LLMs, and MCP tools in Kagent.

## Architecture Layers

### 1. Agent → LLM Gateway
**Purpose**: Route agent requests to LLM providers with observability, rate limiting, and failover

```
Agent → KGateway → LiteLLM/Bedrock
```

**Benefits**:
- Centralized LLM access control
- Request/response logging
- Rate limiting per agent
- Cost tracking
- Model failover

### 2. Agent → MCP Tools Gateway
**Purpose**: Secure and monitor tool access with policy enforcement

```
Agent → KGateway → MCP Server → Tools
```

**Benefits**:
- Tool access policies (which agents can use which tools)
- Request validation
- Response caching
- Audit logging
- Circuit breaking

### 3. Agent → Agent Gateway (A2A)
**Purpose**: Secure agent-to-agent communication with routing

```
Orchestrator Agent → KGateway → Specialist Agent
```

**Benefits**:
- Agent discovery
- Load balancing across agent replicas
- Request tracing
- Authorization policies

## Implementation Patterns

### Pattern 1: LLM Gateway with Rate Limiting

**Scenario**: Protect LLM endpoints from overload

```yaml
# Gateway Route for LLM
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: llm-route
  namespace: kagent
spec:
  parentRefs:
    - name: kgateway
  hostnames:
    - "llm.kagent.local"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /chat/completions
      backendRefs:
        - name: litellm-service
          port: 4000
      filters:
        - type: ExtensionRef
          extensionRef:
            group: gateway.solo.io
            kind: RateLimitPolicy
            name: llm-rate-limit

---
# Rate Limit Policy
apiVersion: gateway.solo.io/v1
kind: RateLimitPolicy
metadata:
  name: llm-rate-limit
  namespace: kagent
spec:
  limits:
    - requests: 100
      unit: minute
      dimensions:
        - header: x-agent-id
```

**Agent Configuration**:
```yaml
apiVersion: kagent.dev/v1alpha2
kind: Agent
metadata:
  name: my-agent
spec:
  declarative:
    modelConfig: bedrock-via-gateway  # Points to gateway
```

### Pattern 2: MCP Tools Gateway with Authorization

**Scenario**: Control which agents can access which tools

```yaml
# Gateway Route for MCP Tools
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: mcp-tools-route
  namespace: kagent
spec:
  parentRefs:
    - name: kgateway
  hostnames:
    - "tools.kagent.local"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /mcp
      backendRefs:
        - name: financial-tools-server
          port: 8080
      filters:
        - type: ExtensionRef
          extensionRef:
            group: gateway.solo.io
            kind: AuthPolicy
            name: mcp-auth

---
# Authorization Policy
apiVersion: gateway.solo.io/v1
kind: AuthPolicy
metadata:
  name: mcp-auth
  namespace: kagent
spec:
  jwt:
    providers:
      - name: kagent-auth
        issuer: "https://kagent.local"
        audiences:
          - "mcp-tools"
  rules:
    - match:
        path: /mcp/calculate_portfolio_value
      allow:
        agents:
          - portfolio-analyst
          - financial-advisor
```

### Pattern 3: A2A Gateway with Observability

**Scenario**: Monitor and trace agent-to-agent calls

```yaml
# Gateway Route for A2A
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: a2a-route
  namespace: kagent
spec:
  parentRefs:
    - name: kgateway
  rules:
    - matches:
        - headers:
            - name: x-agent-call
              value: "true"
      backendRefs:
        - name: portfolio-analyst
          port: 8080
        - name: risk-assessment
          port: 8080
        - name: market-data
          port: 8080
      filters:
        - type: ExtensionRef
          extensionRef:
            group: gateway.solo.io
            kind: TracingPolicy
            name: a2a-tracing

---
# Tracing Policy
apiVersion: gateway.solo.io/v1
kind: TracingPolicy
metadata:
  name: a2a-tracing
  namespace: kagent
spec:
  provider: opentelemetry
  sampling: 100  # 100% sampling
  tags:
    - key: agent.source
      header: x-source-agent
    - key: agent.target
      header: x-target-agent
```

## Security Policies

### 1. mTLS Between Components
```yaml
apiVersion: gateway.solo.io/v1
kind: TLSPolicy
metadata:
  name: mtls-policy
spec:
  mode: STRICT
  clientCertificate:
    secretName: agent-client-cert
  serverCertificate:
    secretName: mcp-server-cert
```

### 2. Request Validation
```yaml
apiVersion: gateway.solo.io/v1
kind: ValidationPolicy
metadata:
  name: mcp-validation
spec:
  jsonSchema:
    type: object
    required: ["jsonrpc", "method"]
    properties:
      jsonrpc:
        type: string
        enum: ["2.0"]
      method:
        type: string
        enum: ["initialize", "tools/list", "tools/call"]
```

### 3. Response Transformation
```yaml
apiVersion: gateway.solo.io/v1
kind: TransformationPolicy
metadata:
  name: add-metadata
spec:
  response:
    headers:
      add:
        - name: x-processed-by
          value: kgateway
        - name: x-timestamp
          value: "{{now}}"
```

## Observability Stack

### Metrics Collection
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: gateway-metrics
data:
  metrics.yaml: |
    metrics:
      - name: agent_llm_requests_total
        type: counter
        labels: [agent_id, model, status]
      - name: agent_tool_calls_total
        type: counter
        labels: [agent_id, tool_name, status]
      - name: agent_llm_latency
        type: histogram
        labels: [agent_id, model]
      - name: agent_tool_latency
        type: histogram
        labels: [agent_id, tool_name]
```

### Logging Configuration
```yaml
apiVersion: gateway.solo.io/v1
kind: LoggingPolicy
metadata:
  name: gateway-logging
spec:
  accessLog:
    - format: |
        {
          "timestamp": "%START_TIME%",
          "agent_id": "%REQ(x-agent-id)%",
          "method": "%REQ(:METHOD)%",
          "path": "%REQ(:PATH)%",
          "status": "%RESPONSE_CODE%",
          "duration_ms": "%DURATION%",
          "bytes_sent": "%BYTES_SENT%",
          "bytes_received": "%BYTES_RECEIVED%"
        }
    destination:
      name: cloudwatch-logs
```

## Implementation Steps

### Step 1: Deploy Gateway Infrastructure
```bash
# Gateway is already installed with Kagent
kubectl get pods -n kagent | grep kgateway
```

### Step 2: Create Gateway Routes
```bash
# Apply HTTPRoute for LLM
kubectl apply -f llm-gateway-route.yaml

# Apply HTTPRoute for MCP Tools
kubectl apply -f mcp-gateway-route.yaml

# Apply HTTPRoute for A2A
kubectl apply -f a2a-gateway-route.yaml
```

### Step 3: Configure Policies
```bash
# Apply rate limiting
kubectl apply -f rate-limit-policy.yaml

# Apply authorization
kubectl apply -f auth-policy.yaml

# Apply observability
kubectl apply -f tracing-policy.yaml
```

### Step 4: Update Agent Configurations
```yaml
# Update agents to use gateway endpoints
apiVersion: kagent.dev/v1alpha2
kind: Agent
metadata:
  name: my-agent
spec:
  declarative:
    modelConfig: bedrock-via-gateway
    tools:
      - type: McpServer
        mcpServer:
          kind: RemoteMCPServer
          name: tools-via-gateway
```

### Step 5: Monitor and Validate
```bash
# Check gateway metrics
kubectl port-forward -n kagent svc/kgateway-agent 9091:9091
curl http://localhost:9091/metrics

# View access logs
kubectl logs -n kagent -l app=kgateway-agent -f

# Check route status
kubectl get httproute -n kagent
```

## Use Cases

### Use Case 1: Cost Control
- Route expensive models through gateway with rate limits
- Track costs per agent
- Implement budget alerts

### Use Case 2: Security Compliance
- Enforce mTLS for all agent communications
- Log all tool access for audit
- Validate all requests/responses

### Use Case 3: Performance Optimization
- Cache frequent tool responses
- Load balance across agent replicas
- Circuit break failing services

### Use Case 4: Multi-Tenancy
- Isolate agents by namespace
- Enforce resource quotas per tenant
- Separate billing per tenant

## Best Practices

1. **Always use gateway for production**: Direct connections bypass policies
2. **Enable tracing**: Essential for debugging multi-agent flows
3. **Set appropriate rate limits**: Protect backend services
4. **Use circuit breakers**: Prevent cascade failures
5. **Monitor gateway health**: Gateway is critical path
6. **Version your routes**: Support gradual rollouts
7. **Test policies in dev**: Validate before production

## Next Steps

1. Review existing kgateway-agent configuration
2. Identify critical paths (Agent→LLM, Agent→Tools, Agent→Agent)
3. Start with observability (logging, metrics)
4. Add security policies incrementally
5. Implement rate limiting based on usage patterns
6. Set up alerting on gateway metrics

## Resources

- KGateway Agent: `kubectl get agent kgateway-agent -n kagent -o yaml`
- Gateway Service: `kubectl get svc kgateway-agent -n kagent`
- Gateway Logs: `kubectl logs -n kagent -l app=kgateway-agent`
