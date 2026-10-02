import asyncio
from google.antigravity import Agent, LocalAgentConfig

async def main():
    config = LocalAgentConfig(system_instructions="You are a helpful assistant.")
    async with Agent(config) as agent:
        response = await agent.chat("Reply with exactly the word: pong")
        print("RESPONSE:", await response.text())

asyncio.run(main())
