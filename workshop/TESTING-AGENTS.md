# Testing Agents on the Open Agentic Platform

## A2A Protocol

Agents communicate using the A2A (Agent-to-Agent) protocol v0.3.0 over JSON-RPC. Each deployed agent exposes:

- `GET /.well-known/agent.json` — Agent card (name, capabilities, skills)
- `POST /` — JSON-RPC endpoint for `message/send`

## Step 1: Verify Agents Are Ready

```bash
kubectl get agents.kagent.dev -n kagent
```

All agents should show `READY=True`.

## Step 2: Discover an Agent

```bash
kubectl run test --image=curlimages/curl --rm -it --restart=Never -- \
  curl -s http://<agent-name>.kagent:8080/.well-known/agent.json | jq .
```

Replace `<agent-name>` with the agent's metadata name (e.g., `bedrock-assistant`).

## Step 3: Send a Message

```bash
kubectl run test --image=curlimages/curl --rm -it --restart=Never -- \
  curl -s -m 60 -X POST http://<agent-name>.kagent:8080/ \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{
      "jsonrpc": "2.0",
      "method": "message/send",
      "id": "req-1",
      "params": {
        "message": {
          "messageId": "msg-001",
          "role": "user",
          "parts": [{"type": "text", "text": "<your question here>"}]
        }
      }
    }'
```

A successful response has `result.status.state: "completed"` and the answer in `result.artifacts[0].parts[0].text`.

## Step 4: Test via Agent Gateway (External)

The Agent Gateway requires a JWT token from the `platform` realm with the `groups` claim.

```bash
# Get credentials
DOMAIN=$(yq '.domain' config.local.yaml)
USER_PASS=$(kubectl get secret -n keycloak keycloak-config -o jsonpath='{.data.USER_PASSWORD}' | base64 -d)

# Get token (use mcp-client, which has the groups scope)
TOKEN=$(curl -s -X POST "https://${DOMAIN}/keycloak/realms/platform/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=mcp-client&username=user1&password=${USER_PASS}&scope=openid" \
  | jq -r '.access_token')

# Call agent through gateway
curl -s -m 60 -X POST "https://${DOMAIN}/sse/" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{
    "jsonrpc": "2.0",
    "method": "message/send",
    "id": "req-1",
    "params": {
      "message": {
        "messageId": "msg-001",
        "role": "user",
        "parts": [{"type": "text", "text": "<your question here>"}]
      }
    }
  }'
```

## Multi-Agent (A2A Orchestration)

Agents can delegate to other agents using the `Agent` tool type in their spec:

```yaml
tools:
  - type: Agent
    agent:
      kind: Agent
      name: <sub-agent-name>
```

When the orchestrator receives a message, it internally calls sub-agents via the same `message/send` protocol, synthesizes their responses, and returns a combined result. Test it the same way — send a message to the orchestrator and it handles delegation transparently.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `status: failed` with 401 auth error | LiteLLM can't reach Bedrock | Verify Pod Identity exists for `litellm` SA in `kagent` ns |
| Agent pod timeout | MCP tool server not running | Check pods: `kubectl get pods -n kagent` |
| Gateway returns `401` | Token missing `groups` claim | Use `mcp-client` client with `scope=openid` |
| Gateway returns `authorization failed` | User not in required group | Verify user is in `/admin` group in Keycloak |
| `Method not found` | Wrong JSON-RPC method name | Use `message/send` (A2A v0.3.0) |
| `messageId` required | Missing field | Include `messageId` in the message object |
