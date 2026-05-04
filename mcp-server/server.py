"""
MCP Server exposing Agent Core capabilities as MCP Tools
Exposes the same 6 tools from the original Strands agent
"""
import os
import json
import asyncio
from typing import Dict, Any
from fastmcp import FastMCP
from contextlib import suppress

from bedrock_agentcore.tools.browser_client import BrowserClient
from browser_use import Agent as BrowserAgent
from browser_use.browser.session import BrowserSession
from browser_use.browser import BrowserProfile
from langchain_aws import ChatBedrockConverse
from bedrock_agentcore.tools.code_interpreter_client import CodeInterpreter
from bedrock_agentcore.memory import MemoryClient

# Initialize MCP server
mcp = FastMCP("Agent Core Tools")

# Health check endpoint
@mcp.custom_route("/health", methods=["GET"])
async def health_check(request):
    from starlette.responses import JSONResponse
    return JSONResponse({"status": "healthy", "service": "agent-core-mcp"})

# Get capability IDs from environment
MEMORY_ID = os.environ.get("MEMORY_ID")
BROWSER_ID = os.environ.get("BROWSER_ID")
CODE_INTERPRETER_ID = os.environ.get("CODE_INTERPRETER_ID")
AWS_REGION = os.environ.get("AWS_REGION", "us-west-2")


async def run_browser_task(browser_session, bedrock_chat, task: str) -> str:
    """Run a browser automation task"""
    agent = BrowserAgent(task=task, llm=bedrock_chat, browser=browser_session)
    result = await agent.run()
    
    if 'done' in result.last_action() and 'text' in result.last_action()['done']:
        return result.last_action()['done']['text']
    else:
        raise ValueError("NO Data")


async def initialize_browser_session():
    """Initialize Browser session with AgentCore"""
    client = BrowserClient(AWS_REGION)
    client.start(identifier=BROWSER_ID)
    
    ws_url, headers = client.generate_ws_headers()
    browser_profile = BrowserProfile(headers=headers, timeout=150000)
    browser_session = BrowserSession(cdp_url=ws_url, browser_profile=browser_profile, keep_alive=True)
    
    await browser_session.start()
    
    bedrock_chat = ChatBedrockConverse(
        model_id="us.anthropic.claude-3-7-sonnet-20250219-v1:0",
        region_name=AWS_REGION
    )
    
    return browser_session, bedrock_chat, client


@mcp.tool()
async def get_weather_data(city: str) -> Dict[str, Any]:
    """Get weather data for a city using browser automation"""
    browser_session = None
    
    try:
        browser_session, bedrock_chat, browser_client = await initialize_browser_session()
        
        task = f"""Extract 8-Day Weather Forecast for {city} from weather.gov
        Steps:
        - Go to https://weather.gov
        - Search for "{city}" and click GO
        - Click "Printable Forecast" link
        - Extract date, high, low, conditions, wind, precip for each day
        - Return JSON array of daily forecasts
        """
        
        result = await run_browser_task(browser_session, bedrock_chat, task)
        
        if browser_client:
            browser_client.stop()

        return {"status": "success", "content": [{"text": result}]}
        
    except Exception as e:
        return {"status": "error", "content": [{"text": f"Error: {str(e)}"}]}
        
    finally:
        if browser_session:
            with suppress(Exception):
                await browser_session.close()


@mcp.tool()
def generate_analysis_code(weather_data: str) -> Dict[str, Any]:
    """Generate Python code for weather classification"""
    try:
        # Use Claude to generate classification code
        from langchain_aws import ChatBedrockConverse
        
        llm = ChatBedrockConverse(
            model_id="us.anthropic.claude-3-7-sonnet-20250219-v1:0",
            region_name=AWS_REGION
        )
        
        query = f"""Create Python code to classify weather days as GOOD/OK/POOR:
        Rules: GOOD: 65-80°F clear, OK: 55-85°F partly cloudy, POOR: <55°F or >85°F
        Weather data: {weather_data}
        Return code that outputs list of tuples: [('2025-09-16', 'GOOD'), ...]"""
        
        result = llm.invoke(query)
        python_code = result.content
        
        # Extract code from markdown
        import re
        pattern = r'```(?:json|python)\n(.*?)\n```'
        match = re.search(pattern, python_code, re.DOTALL)
        python_code = match.group(1).strip() if match else python_code
        
        return {"status": "success", "content": [{"text": python_code}]}
    except Exception as e:
        return {"status": "error", "content": [{"text": f"Error: {str(e)}"}]}


@mcp.tool()
def execute_code(python_code: str) -> Dict[str, Any]:
    """Execute Python code using AgentCore Code Interpreter"""
    try:
        code_client = CodeInterpreter(AWS_REGION)
        code_client.start(identifier=CODE_INTERPRETER_ID)

        response = code_client.invoke("executeCode", {
            "code": python_code,
            "language": "python",
            "clearContext": True
        })

        for event in response["stream"]:
            code_execute_result = json.dumps(event["result"])
        
        analysis_results = json.loads(code_execute_result)

        return {"status": "success", "content": [{"text": str(analysis_results)}]}

    except Exception as e:
        return {"status": "error", "content": [{"text": f"Error: {str(e)}"}]}


@mcp.tool()
def store_user_preferences(preferences: str) -> Dict[str, Any]:
    """Store user activity preferences in memory"""
    try:
        client = MemoryClient(region_name=AWS_REGION)
        client.save_conversation(
            memory_id=MEMORY_ID,
            actor_id="user123",
            session_id="session456",
            messages=[
                (f"My preferences: {preferences}", "USER"),
                ("Preferences saved", "ASSISTANT")
            ]
        )
        return {"status": "success", "content": [{"text": f"Preferences stored: {preferences}"}]}
    except Exception as e:
        return {"status": "error", "content": [{"text": f"Error storing preferences: {str(e)}"}]}


@mcp.tool()
def get_activity_preferences() -> Dict[str, Any]:
    """Get user activity preferences from memory"""
    try:
        client = MemoryClient(region_name=AWS_REGION)
        response = client.retrieve_memories(
            memory_id=MEMORY_ID,
            namespace="default",
            query="What are the user's activity preferences and interests?",
            top_k=5
        )
        
        if response and len(response) > 0:
            preferences = "\n".join([str(item) for item in response])
            return {"status": "success", "content": [{"text": f"User preferences: {preferences}"}]}
        else:
            return {"status": "success", "content": [{"text": "No preferences stored. Default: outdoor activities, hiking, beaches, museums."}]}
    except Exception as e:
        return {"status": "error", "content": [{"text": f"Error retrieving preferences: {str(e)}"}]}


@mcp.tool()
def store_activity_plan(city: str, plan: str) -> Dict[str, Any]:
    """Store the activity plan in memory for future reference"""
    try:
        client = MemoryClient(region_name=AWS_REGION)
        client.save_conversation(
            memory_id=MEMORY_ID,
            actor_id="user123",
            session_id="session456",
            messages=[
                (f"Plan for {city}", "USER"),
                (plan, "ASSISTANT")
            ]
        )
        return {"status": "success", "content": [{"text": f"Activity plan stored in memory for {city}"}]}
    except Exception as e:
        return {"status": "error", "content": [{"text": f"Error storing plan: {str(e)}"}]}


if __name__ == "__main__":
    mcp.run(transport="http", host="0.0.0.0", port=8080)
