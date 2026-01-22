from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
import random

app = FastAPI(title="Financial Services Tools Server")

# ============ Portfolio Tools ============
class PortfolioRequest(BaseModel):
    holdings: dict  # {"AAPL": 100, "GOOGL": 50}
    prices: dict    # {"AAPL": 150.0, "GOOGL": 2800.0}

@app.post("/tools/calculate_portfolio_value")
async def calculate_portfolio_value(req: PortfolioRequest):
    try:
        total = sum(req.holdings.get(symbol, 0) * req.prices.get(symbol, 0) 
                   for symbol in req.holdings.keys())
        return {
            "success": True,
            "total_value": total,
            "holdings": req.holdings,
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============ Stock Price Tool ============
class StockPriceRequest(BaseModel):
    symbol: str

@app.post("/tools/get_stock_price")
async def get_stock_price(req: StockPriceRequest):
    # Simulated stock prices
    prices = {
        "AAPL": 175.50,
        "GOOGL": 140.25,
        "MSFT": 380.75,
        "AMZN": 145.30,
        "TSLA": 245.60
    }
    price = prices.get(req.symbol.upper(), random.uniform(50, 500))
    return {
        "success": True,
        "symbol": req.symbol.upper(),
        "price": round(price, 2),
        "currency": "USD",
        "timestamp": datetime.now().isoformat()
    }


# ============ Risk Assessment Tool ============
class RiskRequest(BaseModel):
    portfolio: dict  # {"AAPL": 0.3, "GOOGL": 0.3, "TSLA": 0.4}
    risk_tolerance: str  # "low", "medium", "high"

@app.post("/tools/calculate_risk_score")
async def calculate_risk_score(req: RiskRequest):
    # Simulated risk calculation
    risk_weights = {"AAPL": 0.3, "GOOGL": 0.35, "MSFT": 0.25, "AMZN": 0.4, "TSLA": 0.8}
    
    portfolio_risk = sum(
        req.portfolio.get(symbol, 0) * risk_weights.get(symbol, 0.5)
        for symbol in req.portfolio.keys()
    )
    
    risk_score = round(portfolio_risk * 100, 2)
    
    tolerance_map = {"low": 30, "medium": 60, "high": 90}
    tolerance_threshold = tolerance_map.get(req.risk_tolerance, 60)
    
    return {
        "success": True,
        "risk_score": risk_score,
        "risk_level": "high" if risk_score > 60 else "medium" if risk_score > 30 else "low",
        "within_tolerance": risk_score <= tolerance_threshold,
        "recommendation": "Rebalance portfolio" if risk_score > tolerance_threshold else "Portfolio aligned with risk tolerance"
    }


# ============ Market Trends Tool ============
class MarketTrendsRequest(BaseModel):
    sector: Optional[str] = "technology"

@app.post("/tools/get_market_trends")
async def get_market_trends(req: MarketTrendsRequest):
    trends = {
        "technology": {"trend": "bullish", "growth": 12.5, "volatility": "medium"},
        "finance": {"trend": "neutral", "growth": 3.2, "volatility": "low"},
        "healthcare": {"trend": "bullish", "growth": 8.7, "volatility": "low"},
        "energy": {"trend": "bearish", "growth": -2.1, "volatility": "high"}
    }
    
    sector_data = trends.get(req.sector.lower(), {"trend": "neutral", "growth": 0, "volatility": "medium"})
    
    return {
        "success": True,
        "sector": req.sector,
        "trend": sector_data["trend"],
        "growth_rate": sector_data["growth"],
        "volatility": sector_data["volatility"],
        "timestamp": datetime.now().isoformat()
    }


# Health check
@app.get("/health")
async def health():
    return {"status": "healthy"}


# MCP endpoint
@app.post("/mcp")
async def mcp_endpoint(request: dict):
    method = request.get("method")
    
    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "financial-tools-server", "version": "1.0.0"}
            }
        }
    
    elif method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "result": {
                "tools": [
                    {
                        "name": "calculate_portfolio_value",
                        "description": "Calculate total portfolio value from holdings and current prices",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "holdings": {"type": "object", "description": "Stock holdings"},
                                "prices": {"type": "object", "description": "Current stock prices"}
                            },
                            "required": ["holdings", "prices"]
                        }
                    },
                    {
                        "name": "get_stock_price",
                        "description": "Get current stock price for a symbol",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "symbol": {"type": "string", "description": "Stock symbol (e.g., AAPL)"}
                            },
                            "required": ["symbol"]
                        }
                    },
                    {
                        "name": "calculate_risk_score",
                        "description": "Calculate risk score for a portfolio",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "portfolio": {"type": "object", "description": "Portfolio allocation"},
                                "risk_tolerance": {"type": "string", "description": "Risk tolerance: low, medium, high"}
                            },
                            "required": ["portfolio", "risk_tolerance"]
                        }
                    },
                    {
                        "name": "get_market_trends",
                        "description": "Get market trends for a sector",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "sector": {"type": "string", "description": "Market sector"}
                            }
                        }
                    }
                ]
            }
        }
    
    elif method == "tools/call":
        tool_name = request.get("params", {}).get("name")
        arguments = request.get("params", {}).get("arguments", {})
        
        if tool_name == "calculate_portfolio_value":
            result = await calculate_portfolio_value(PortfolioRequest(**arguments))
        elif tool_name == "get_stock_price":
            result = await get_stock_price(StockPriceRequest(**arguments))
        elif tool_name == "calculate_risk_score":
            result = await calculate_risk_score(RiskRequest(**arguments))
        elif tool_name == "get_market_trends":
            result = await get_market_trends(MarketTrendsRequest(**arguments))
        else:
            return {
                "jsonrpc": "2.0",
                "id": request.get("id"),
                "error": {"code": -32601, "message": f"Tool not found: {tool_name}"}
            }
        
        return {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "result": {"content": [{"type": "text", "text": str(result)}]}
        }
    
    return {
        "jsonrpc": "2.0",
        "id": request.get("id"),
        "error": {"code": -32601, "message": f"Method not found: {method}"}
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
