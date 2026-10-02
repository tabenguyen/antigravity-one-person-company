# Phase 0 — Spike results & design decisions

Date: 2026-10-01 · agy **v1.2.14** (auto-updated from 1.1.19 during the spike)

Detailed evidence lives in each spike's `FINDINGS.md`:

| Spike | Scope |
|---|---|
| [01-headless-io](../spike/01-headless-io/FINDINGS.md) | stream-json I/O, `--json-schema`, resume, timeouts, permissions, `runAgy()` wrapper |
| [02-workspace-agents](../spike/02-workspace-agents/FINDINGS.md) | custom agents, rules, skills, isolation, workspace MCP, local plugins |
| [03-hooks](../spike/03-hooks/FINDINGS.md) | all 5 hooks headless, policy gate, context injection, failure modes |
| [04-concurrency-sdk](../spike/04-concurrency-sdk/FINDINGS.md) | parallel runs, quota API, Python SDK |

**Verdict: agy is viable as the agent runtime for agy-hq.** No blockers.
Several sharp edges dictate the Runner and security design below.

---

## 1. What works (verified)

- **Headless runs**: `agy -p` with `stream-json` output; NDJSON events
  `init` → `step_update` (user_input, agent_response text_delta, tool with
  parameters/output/error, finish, system_message) → `result` (usage,
  num_turns, `denied_actions`).
- **Multi-turn over one process**: `--print='' --input-format stream-json`,
  input line `{"event":"user","message":{"role":"user","content":"…"}}`
  (not Claude Code's `{"type":"user"}`).
- **Structured output**: `--json-schema` (inline or file) → `structured_output`.
- **Resume**: `--conversation <id>` across processes. Stored in
  `~/.gemini/antigravity-cli/conversations/<uuid>.db`.
- **Custom agents**: `.agents/agents/<role>.md` + `--agent <role>` from the
  workspace cwd. Frontmatter: `name`, `description`, `tools`, `model`.
  Unknown tool name in `tools:` → hard error (exit 3).
- **Rules / skills**: `AGENTS.md`, `always_on` and `model_decision` rules,
  on-demand skills — all work headless.
- **Isolation**: sibling workspaces don't bleed persona/rules/skills.
- **Workspace MCP**: `.agents/mcp_config.json` works headless, no global
  `agy mcp add`. MCP calls appear as `call_mcp_tool` with
  `parameters.{ServerName, ToolName, Arguments}`.
- **Local plugins**: `.agents/plugins/<name>/` auto-loads (MCP server is
  namespaced `<plugin>_<server>`).
- **Hooks** (all 5 fire headless):
  - `PreToolUse` can `deny` (holds even with `--dangerously-skip-permissions`)
    and `overwrite` args. **Fails closed** on timeout / non-zero exit /
    bad JSON / missing script.
  - `PreInvocation` can inject context via
    `injectSteps:[{ephemeralMessage:…}]` — verified the model uses it.
  - `Stop` sees a complete transcript and can force `continue`.
  - Matchers are anchored regex (`run_.*` matches, `command` doesn't).
- **Concurrency**: 1/3/5 parallel processes, 0% failures, no ID collisions,
  ~7s fixed overhead per `agy -p` call (p50 ≈ 7s for a trivial prompt).
  Mixed models (Gemini + Claude) in parallel fine.
- **Quota API**: `agy -p "/usage" --output-format json` → per-model-group
  weekly and 5-hour `remaining_fraction` + `reset_time`, costs nothing.

## 2. Sharp edges (must be handled)

| # | Gotcha | Consequence for agy-hq |
|---|---|---|
| 1 | **Timeout = success**: on `--print-timeout`, status `SUCCESS`, empty response, exit 0; only a stderr line `[agy] print timeout after …` | Runner detects timeouts from stderr + its own watchdog, never from status/exit code |
| 2 | **Denied tools = success**: headless can't prompt; denied calls are auto-denied, run ends `SUCCESS` with `denied_actions[]` and often an empty response | Runner treats non-empty `denied_actions` as a failure signal |
| 3 | **MCP calls need `--dangerously-skip-permissions`** (or matching global `permissions.allow`), otherwise silently denied | Runner always passes it → agy's own permission system is effectively off; we bring our own (section 3) |
| 4 | **`tools:` allowlist does NOT restrict MCP tools**, and MCP tools can't be named in `tools:` | Gate MCP per tool in the `PreToolUse` hook (via `ServerName`/`ToolName`) and inside the MCP server |
| 5 | **Global config bleeds into every workspace**: `~/.gemini/config` permission grants, skills, rules, MCP servers | Run agy-hq under a **dedicated OS user** with a clean `~/.gemini` and its own agy login |
| 6 | `trustedWorkspaces` is not enforced in headless mode | Don't rely on it |
| 7 | "Ask user" in hooks is unusable headless (allow with skip-perms, deny without) | Approvals = `deny` + harness approval queue (Outbox) |
| 8 | Hooks are per-workspace, not per-agent; only `ANTIGRAVITY_CONVERSATION_ID` is injected | One workspace per agent instance; Runner passes `AGYHQ_*` env vars explicitly |
| 9 | `--continue` resumes the globally most recent conversation | Never use; always track conversation IDs |
| 10 | `--effort` conflicts with model IDs that already carry effort (`…-flash-low`) | Store model ID only; use `--effort` only with bare IDs |
| 11 | `init.tools` lists the full catalog, not the agent's active tools | Don't use it for auditing |
| 12 | `agy agents` is an interactive picker, not scriptable | Registry lives in agy-hq, not agy |
| 13 | agy auto-updates | Record version per run; pin/test before upgrades |

## 3. Decisions

**D1 — Runner: spawn the `agy` CLI from Node.** The Python SDK uses its own
binary and needs a Gemini API key / Vertex billing, separate from the agy
login; keep it as a fallback runner behind the same interface.

**D2 — Runner invocation contract**

```
cwd = workspaces/<agent-id>/
env = AGYHQ_AGENT_ID, AGYHQ_TASK_ID, AGYHQ_API_URL, AGYHQ_TOKEN
agy --print='' --input-format stream-json --output-format stream-json \
    --agent <role> --model <model-id> --dangerously-skip-permissions \
    [--conversation <id>] [--json-schema <file>] --print-timeout <n>
```

Result classification: `ok` only if a `result` event arrived, no timeout
marker on stderr, `denied_actions` empty, and the response (or
`structured_output`) is non-empty and valid.

**D3 — Security model (defense in depth; agy's own permissions are off)**

1. **Workspace scope** — each workspace's `.agents/mcp_config.json` lists
   only that role's MCP servers; the agent's `tools:` allowlist removes
   dangerous built-ins (`run_command`, `write_to_file`, browser, …).
2. **`PreToolUse` policy hook** (fail-closed) — default deny; allow only
   listed built-ins and specific `call_mcp_tool` `{ServerName, ToolName}`
   pairs for this agent. Policy is fetched from agy-hq per agent.
3. **Company MCP server** — authenticates the agent from `AGYHQ_AGENT_ID` +
   token, authorizes each tool by role, validates arguments.
4. **Outbox** — every external side effect becomes a draft. Policy
   (auto / approve / block), rate limits, kill switch are enforced by agy-hq,
   not by the model.
5. **Dedicated OS user** for the harness with a clean `~/.gemini`.

**D4 — Trust tiers live in agy-hq, not in agy `--mode` flags.** Shadow /
assisted / autonomous are Outbox policies. (`--mode plan` doesn't help once
work goes through MCP.)

**D5 — Hook roles**
- `PreToolUse`: policy gate (#2 above) — the only real safety gate.
- `PostToolUse`: audit log (always no-op/allow; must never fail a run).
- `PreInvocation`: inject per-entity notes / task context (keep small).
- `Stop`: checkpoint transcript → agy-hq; optionally force `continue` when
  the structured result is missing.

**D6 — Workspace template** (generated from `templates/<role>/`)

```
workspaces/<agent-id>/          e.g. workspaces/sdr-01/
├── AGENTS.md                   identity, hard "never" rules, sign-off
└── .agents/
    ├── agents/<role>.md        persona, tools: allowlist, model
    ├── rules/*.md              always_on (voice, compliance) / model_decision (SOPs)
    ├── skills/<sop>/SKILL.md   qualify-lead, write-first-touch, follow-up, …
    ├── hooks.json              policy gate, audit, context inject, stop checkpoint
    └── mcp_config.json         company-mcp (role-scoped) with AGYHQ_* env
```

**D7 — Capacity & quota.** ~7s overhead per call → batch work into fewer,
richer tasks; route deterministic events without a model call. The scheduler
polls `/usage` and throttles below a remaining-quota threshold (e.g. 20%),
reserving headroom for inbound replies over outbound prospecting.

## 4. Open items (cheap, non-blocking)

- Larger concurrency sample (N = 5/10, 10+ runs each) before sizing the pool.
- What `--project` / `--new-project` do exactly; what `--sandbox` restricts.
- Does a `PreToolUse` deny on `call_mcp_tool` behave the same as for
  built-ins? (Expected yes; not yet run end-to-end.)
- Long-running conversations: context growth and compaction behaviour.
- SDK live test, if a `GEMINI_API_KEY` becomes available.

## 5. Reusable code from the spikes

- `spike/01-headless-io/agy-events.ts` — event types + `runAgy()` → seed of the Runner.
- `spike/03-hooks/hook-types.ts` + `.agents/scripts/*.mjs` → seed of the hook package.
- `spike/02-workspace-agents/mcp/company-mcp.ts` → seed of the company MCP server.
- `spike/02-workspace-agents/workspaces/sales-01/` → seed of the SDR template.
