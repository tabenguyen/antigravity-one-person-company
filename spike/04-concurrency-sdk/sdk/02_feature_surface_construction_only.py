"""Construction-only validation of the google-antigravity SDK's feature
surface (item 6 of the spike): custom system instructions, custom tools,
policies, structured output, hooks, MCP server config, subagents.

This does NOT make a live model call (no GEMINI_API_KEY is configured in this
environment and we were not authorized to spend the user's Vertex/GCP
credentials). It only imports the public API and constructs the config
objects, to confirm the documented surface actually exists and is wired the
way the README describes, catching import/attribute errors early.

Run: .venv/bin/python sdk/02_feature_surface_construction_only.py
"""

import pydantic

from google.antigravity import Agent, LocalAgentConfig
from google.antigravity import types
from google.antigravity.hooks import policy
from google.antigravity.hooks import hooks as hooks_mod

results = {}


def check(name, fn):
    try:
        fn()
        results[name] = "OK"
    except Exception as e:  # noqa: BLE001
        results[name] = f"FAIL: {type(e).__name__}: {e}"


# 1. Custom system instructions (string form + structured form).
def t_system_instructions():
    LocalAgentConfig(system_instructions="You are a terse Sales SDR assistant.")
    # SystemInstructions = CustomSystemInstructions | TemplatedSystemInstructions (a Union,
    # not directly constructible) -- use one of the two concrete variants.
    LocalAgentConfig(
        system_instructions=types.TemplatedSystemInstructions(
            content="You are a terse Sales SDR assistant.",
        )
    )
    LocalAgentConfig(
        system_instructions=types.CustomSystemInstructions(
            text="You are a terse Sales SDR assistant.",
        )
    )


check("system_instructions", t_system_instructions)


# 2. Custom Python tool (plain function, type-hinted -> schema inferred).
def send_followup_email(to: str, subject: str, body: str) -> str:
    """Send a follow-up email to a lead (stub tool for the spike)."""
    return f"queued email to {to}"


def t_custom_tool():
    LocalAgentConfig(
        tools=[send_followup_email],
        policies=[policy.allow_all()],
    )


check("custom_python_tool", t_custom_tool)


# 3. Policies: deny / allow / ask_user, including default confirm_run_command.
def my_ask_user_handler(tool_call, reason=""):
    return True  # auto-approve for this construction-only test


def t_policies():
    policy.deny("*")
    policy.allow("read_file")
    policy.deny("run_command", when=lambda args: "rm" in args.get("CommandLine", ""))
    policy.ask_user("run_command", handler=my_ask_user_handler)
    policy.allow_all()
    policy.deny_all()
    policy.confirm_run_command()
    LocalAgentConfig(
        policies=[
            policy.deny_all(),
            policy.allow("send_followup_email"),
            policy.ask_user("run_command", handler=my_ask_user_handler),
        ],
        tools=[send_followup_email],
    )


check("policies_deny_allow_ask_user", t_policies)


# 4. Structured output via a Pydantic response_schema.
class LeadQualification(pydantic.BaseModel):
    qualified: bool
    reason: str
    next_action: str


def t_structured_output():
    LocalAgentConfig(response_schema=LeadQualification)
    LocalAgentConfig(response_schema={"type": "object", "properties": {"ok": {"type": "boolean"}}})


check("structured_output_response_schema", t_structured_output)


# 5. Hooks: decorator-based registration for the documented hook points.
def t_hooks():
    events = []

    # The decorator inspects the wrapped function's signature at decoration
    # time: a parameter named `context` (or type-hinted as a HookContext
    # subclass) is recognized as the context arg; pass_data=False hooks
    # (session start/end) otherwise take zero arguments, pass_data=True hooks
    # (pre/post tool call, pre/post turn, etc.) otherwise take one `data` arg.
    @hooks_mod.on_session_start
    async def _on_start():
        events.append("start")

    @hooks_mod.pre_tool_call_decide
    async def _pre_tool(tool_call):
        events.append(("pre_tool", tool_call))
        return None

    @hooks_mod.post_tool_call
    async def _post_tool(context, tool_result):
        events.append(("post_tool", context, tool_result))

    @hooks_mod.on_session_end
    async def _on_end():
        events.append("end")

    LocalAgentConfig(hooks=[_on_start, _pre_tool, _post_tool, _on_end])


def t_hooks_safe():
    # hooks_mod may expose decorators under different names across versions;
    # probe what's actually there instead of guessing blind.
    exported = [n for n in dir(hooks_mod) if not n.startswith("_")]
    results["hooks_module_exports"] = exported


check("hooks_decorators_construction", t_hooks)
check("hooks_module_introspection", t_hooks_safe)


# 6. MCP server config (stdio + streamable-http variants).
def t_mcp():
    stdio = types.McpStdioServer(name="company-mcp", command="node", args=["./mcp-server.js"])
    http = types.McpStreamableHttpServer(name="remote-mcp", url="https://example.invalid/mcp")
    LocalAgentConfig(mcp_servers=[stdio, http])


check("mcp_server_config", t_mcp)


# 7. Subagents.
def t_subagents():
    sub = types.SubagentConfig(name="researcher", description="Does web research", system_instructions="Research things.")
    LocalAgentConfig(subagents=[sub])


check("subagents_config", t_subagents)


# 8. Resume / multi-turn knobs (construction only).
def t_resume_knobs():
    LocalAgentConfig(
        conversation_id="11111111-1111-1111-1111-111111111111",
        session_continuation_mode=types.SessionContinuationMode.RESUME,
    )
    LocalAgentConfig(session_continuation_mode=types.SessionContinuationMode.CREATE_OR_RESUME)


check("resume_session_continuation_mode", t_resume_knobs)


for name, status in results.items():
    print(f"{name}: {status}")
