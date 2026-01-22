# Financial Services Multi-Agent System

This example demonstrates a financial services use case with multiple specialized agents:

## Agents

1. **Portfolio Analyst Agent** - Analyzes investment portfolios and provides recommendations
2. **Risk Assessment Agent** - Evaluates financial risks and compliance
3. **Market Data Agent** - Provides real-time market data and trends
4. **Financial Advisor Agent** - Orchestrates other agents to provide comprehensive financial advice

## Tools (MCP Server)

- `calculate_portfolio_value` - Calculate total portfolio value
- `get_stock_price` - Get current stock price
- `calculate_risk_score` - Calculate risk score for investments
- `get_market_trends` - Get market trends and analysis

## Architecture

- **A2A (Agent-to-Agent)**: Agents can delegate tasks to each other
- **MCP (Model Context Protocol)**: Shared tools via MCP server
- **Kagent CRDs**: All wired through Kubernetes custom resources

## Deployment

```bash
kubectl apply -f financial-tools-deployment.yaml
kubectl apply -f financial-tools-mcpserver.yaml
kubectl apply -f portfolio-analyst-agent.yaml
kubectl apply -f risk-assessment-agent.yaml
kubectl apply -f market-data-agent.yaml
kubectl apply -f financial-advisor-agent.yaml
```
