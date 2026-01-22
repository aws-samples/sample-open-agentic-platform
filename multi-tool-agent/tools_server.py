# tools_server.py - A single service hosting multiple tools
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import httpx
import math
import ast
import operator
from typing import Any
from datetime import datetime

app = FastAPI(title="Kagent Tools Server")

# ============ Calculator Tool ============
class CalculatorRequest(BaseModel):
    expression: str

SAFE_OPS = {
    ast.Add: operator.add, ast.Sub: operator.sub,
    ast.Mult: operator.mul, ast.Div: operator.truediv,
    ast.Pow: operator.pow, ast.USub: operator.neg,
}

def safe_eval(expr: str) -> float:
    def _eval(node):
        if isinstance(node, ast.Constant):
            return node.value
        elif isinstance(node, ast.BinOp):
            return SAFE_OPS[type(node.op)](_eval(node.left), _eval(node.right))
        elif isinstance(node, ast.UnaryOp):
            return SAFE_OPS[type(node.op)](_eval(node.operand))
        raise ValueError("Unsafe expression")
    return _eval(ast.parse(expr, mode='eval').body)

@app.post("/tools/calculator")
async def calculator(req: CalculatorRequest):
    try:
        result = safe_eval(req.expression)
        return {"success": True, "result": result}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============ Web Search Tool ============
class SearchRequest(BaseModel):
    query: str
    max_results: int = 5

@app.post("/tools/web-search")
async def web_search(req: SearchRequest):
    # Using DuckDuckGo (no API key needed)
    try:
        from duckduckgo_search import DDGS
        with DDGS() as ddgs:
            results = list(ddgs.text(req.query, max_results=req.max_results))
        return {
            "success": True,
            "results": [
                {"title": r["title"], "url": r["href"], "snippet": r["body"]}
                for r in results
            ]
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============ Weather Tool ============
class WeatherRequest(BaseModel):
    city: str

@app.post("/tools/weather")
async def get_weather(req: WeatherRequest):
    # Using wttr.in (free, no API key)
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"https://wttr.in/{req.city}?format=j1",
                timeout=10.0
            )
            data = response.json()
            current = data["current_condition"][0]
            return {
                "success": True,
                "city": req.city,
                "temperature_c": current["temp_C"],
                "temperature_f": current["temp_F"],
                "condition": current["weatherDesc"][0]["value"],
                "humidity": current["humidity"],
                "wind_kmph": current["windspeedKmph"]
            }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============ Date/Time Tool ============
class DateTimeRequest(BaseModel):
    timezone: str = "UTC"

@app.post("/tools/datetime")
async def get_datetime(req: DateTimeRequest):
    from zoneinfo import ZoneInfo
    try:
        tz = ZoneInfo(req.timezone)
        now = datetime.now(tz)
        return {
            "success": True,
            "datetime": now.isoformat(),
            "date": now.strftime("%Y-%m-%d"),
            "time": now.strftime("%H:%M:%S"),
            "timezone": req.timezone,
            "day_of_week": now.strftime("%A")
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# Health check
@app.get("/health")
async def health():
    return {"status": "healthy"}


# MCP endpoint for STREAMABLE_HTTP
@app.post("/mcp")
async def mcp_endpoint(request: dict):
    """Handle MCP protocol requests"""
    method = request.get("method")
    
    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "kagent-multi-agent-tools-server",
                    "version": "1.0.0"
                }
            }
        }
    
    elif method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "result": {
                "tools": [
                    {
                        "name": "calculator",
                        "description": "Perform mathematical calculations. Supports basic arithmetic (+, -, *, /, **).",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "expression": {"type": "string", "description": "The mathematical expression to evaluate"}
                            },
                            "required": ["expression"]
                        }
                    },
                    {
                        "name": "web_search",
                        "description": "Search the web for current information.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "query": {"type": "string", "description": "The search query"},
                                "max_results": {"type": "integer", "description": "Maximum number of results", "default": 5}
                            },
                            "required": ["query"]
                        }
                    },
                    {
                        "name": "get_weather",
                        "description": "Get current weather information for a city.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "city": {"type": "string", "description": "City name"}
                            },
                            "required": ["city"]
                        }
                    },
                    {
                        "name": "get_datetime",
                        "description": "Get current date and time.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "timezone": {"type": "string", "description": "Timezone", "default": "UTC"}
                            }
                        }
                    }
                ]
            }
        }
    
    elif method == "tools/call":
        tool_name = request.get("params", {}).get("name")
        arguments = request.get("params", {}).get("arguments", {})
        
        # Route to appropriate tool
        if tool_name == "calculator":
            result = await calculator(CalculatorRequest(**arguments))
        elif tool_name == "web_search":
            result = await web_search(SearchRequest(**arguments))
        elif tool_name == "get_weather":
            result = await get_weather(WeatherRequest(**arguments))
        elif tool_name == "get_datetime":
            result = await get_datetime(DateTimeRequest(**arguments))
        else:
            return {
                "jsonrpc": "2.0",
                "id": request.get("id"),
                "error": {"code": -32601, "message": f"Tool not found: {tool_name}"}
            }
        
        return {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "result": {
                "content": [
                    {
                        "type": "text",
                        "text": str(result)
                    }
                ]
            }
        }
    
    return {
        "jsonrpc": "2.0",
        "id": request.get("id"),
        "error": {"code": -32601, "message": f"Method not found: {method}"}
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)