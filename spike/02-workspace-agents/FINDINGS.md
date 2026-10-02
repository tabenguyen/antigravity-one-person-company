# Spike 02 — Per-agent workspace isolation, custom agents, workspace-scoped MCP

Environment: `agy` **1.2.14** (task brief said 1.1.19 — version has moved on;
nothing below seems version-sensitive but note it). All commands run from
`/Users/nguyentam/Documents/Makini/agy-ui/spike/02-workspace-agents/`, timed
out with `perl -e 'alarm shift; exec @ARGV'` via `run_agy.sh` (see that
script). Cheap model `gemini-3.8-flash-low` used throughout. Raw NDJSON/JSON
outputs for every experiment referenced below are in `raw/`, numbered in the
order run.

**CLI gotcha hit immediately**: `-p "prompt"` / `--prompt "prompt"` must be
the **last** flag on the command line, or it greedily swallows the next
flag's name as the prompt text (`-p --output-format json "..."` fails with
`"-p took \"--output-format\" as its prompt"`). Always put `-p "..."` last.

---

## Q1 — Custom agent discovery (`.agents/agents/sales-sdr.md`)

**VERIFIED.** From `workspaces/sales-01` (cwd), `agy -p --agent sales-sdr
"Who are you?"` returns the persona defined in the file ("I am Mai, a Sales
Development Representative at Makini...") vs. the generic "I am Antigravity..."
identity with no `--agent`. Evidence: `raw/02-agent-whoareyou.json` vs
`raw/02b-noagent-whoareyou.json`.

- `agy agents` / `agy agent` (no args) is an **interactive TUI picker**, not
  a scriptable list command — it prints nothing and exits 0 under a
  non-interactive bash (confirmed it's reading/expecting a TTY via `script -q
  /dev/null agy agents`, which produced only raw terminal control bytes). We
  could not get a headless, parseable "list of agents" this way. If agy-hq
  needs this programmatically, parse the `.agents/agents/*.md` files directly
  rather than shelling out to `agy agents`.
- **Frontmatter fields actually exercised and respected**: `name`,
  `description`, `tools` (array), `model`. We did not get a chance to verify
  `mainAgent`/`subagent`/`effort`/`commandExecutionPolicy`/`mcpServers` keys
  empirically (the public docs page for subagents, fetched via WebFetch,
  claims `mainAgent`, `subagent`, `model: inherit|flash|pro`,
  `commandExecutionPolicy`, `mcpServers`, `skills`/`plugins` exist, but that
  page's content is not agy-CLI-specific and we could not independently
  confirm most of it — treat as **PARTIAL/unverified** beyond `name`,
  `description`, `tools`, `model: inherit`).
- Referencing an **unknown tool name** in `tools:` is a **hard failure**, not
  a silent ignore: `tools: [kb_search]` before any MCP server was registered
  produced `error: failed to construct executor: failed to resolve
  components: unknown component: tool "kb_search" not found in registry`
  (exit code 3). Any workspace-generator in agy-hq must validate tool names
  against a known registry before writing agent files, or runs will hard-fail
  before producing any output at all.

## Q2 — Tool restriction via `tools:` allowlist

**VERIFIED, with an important caveat (see Q6).** With `tools: [view_file,
grep_search]` on `sales-sdr`, asking the agent to run a shell command or
write a file produces a plain refusal with no tool call attempted
(`raw/03-tool-restriction-run-command.json`, confirmed via stream-json in
`raw/03c-force-write-file.ndjson` that it never even tries — no file was
created). Directly asked to use `write_to_file`, the agent responds "I do
not have access to a `write_to_file` tool... The tools available to me are:
view_file, grep_search, manage_task" — i.e. it correctly enumerates its own
real, restricted toolset.

**Important nuance / possible source of confusion**: the `init` event's
`tools` array in `--output-format stream-json` always lists the **entire
built-in tool catalog** (~40 tools: `run_command`, `write_to_file`,
`browser_*`, etc.) regardless of the agent's `tools:` allowlist. Don't read
that array as "what this agent can do" — it's a static catalog of tool
*schemas* known to the CLI, not the bound/active set. We only discovered the
real active set by testing behavior (and the model's own self-report).

Also: `manage_task` was present in the model's self-reported available-tools
list even though it's not in our `tools:` frontmatter — some tool(s)
appear to be always-on regardless of the allowlist (todo/task-list
management, at minimum).

**CAVEAT (bleeds into Q6): the `tools:` allowlist does NOT gate MCP tool
access.** See Q6 below — this is the single biggest finding of this spike.

## Q3 — Rules: `AGENTS.md` and `.agents/rules/*.md`, trigger types

**VERIFIED, clean evidence.** Set up three rule layers in `sales-01`:
- `AGENTS.md` (plain, no frontmatter) → must always append
  `[AGENTS-MD-APPLIED]`.
- `.agents/rules/always-on-rule.md` with `trigger: always_on` → must always
  append `[RULE-ALWAYS-ON-APPLIED]`.
- `.agents/rules/refund-policy-rule.md` with `trigger: model_decision` and a
  description scoping it to refund questions → must append
  `[RULE-MODEL-DECISION-APPLIED]` only then.

Results:
- Unrelated question ("what time zone is Makini headquartered in?"):
  response contains `[RULE-ALWAYS-ON-APPLIED]` and `[AGENTS-MD-APPLIED]` but
  **not** the model-decision token (`raw/04-rules-unrelated-question.json`).
- Refund question ("does Makini offer refunds..."): response contains **all
  three** tokens (`raw/05-rules-refund-question.json`).

This cleanly confirms: plain `AGENTS.md` is always active; `always_on` rules
are always active; `model_decision` rules are conditionally injected based on
their `description`, and correctly discriminated between topics headless, no
special flag needed.

**Operational gotcha found along the way**: the very first unrelated-question
run (without `--dangerously-skip-permissions`) returned an **empty
response** even though `status: SUCCESS`, because the model tried to call
`grep_search` and headless auto-denied the permission prompt (`denied_actions:
[{"action":"read_file","display_name":"GrepSearch"}]`, stderr: `"a tool
required the \"read_file\" permission that headless mode cannot prompt for,
so it was auto-denied"`). **Any headless runner for agy-hq must either pass
`--dangerously-skip-permissions` or pre-populate `permissions.allow` in
settings — otherwise turns can silently return empty output whenever the
model reaches for a tool.**

## Q4 — Skills: `.agents/skills/qualify-lead/SKILL.md`

**VERIFIED, clean evidence.** Asked to qualify a described lead:
`[SKILL-QUALIFY-LEAD-LOADED]` marker appears, followed by the exact BANT
procedure from the SKILL.md, with a numeric score (`raw/06-skill-trigger.json`).
Asked an unrelated sales question ("subject line for cold email"): the
marker does **not** appear (`raw/06b-skill-no-trigger.json`). Progressive
disclosure / on-demand skill loading works correctly headless, purely off
the skill's `description` frontmatter — no explicit invocation syntax needed.

## Q5 — Isolation between sibling workspaces + global-config leak risk

**VERIFIED (isolation) / VERIFIED (leak risk, with concrete evidence).**

Built a second workspace `am-01` (Account Manager "Duc", own `AGENTS.md`
token `[AM01-AGENTS-MD-APPLIED]`, own always-on rule
`[AM01-RULE-ALWAYS-ON-APPLIED]`, own skill `renewal-check` →
`[SKILL-RENEWAL-CHECK-LOADED]`).

- `am-01`'s own persona/rules/skill fire correctly and **none of sales-01's**
  markers/skill leak in (`raw/07-am01-whoareyou.json`,
  `raw/08-am01-renewal-skill.json`).
- Asked `am-rep` to qualify a lead (a sales-01-only skill, not present in
  am-01's `.agents/skills/`): it correctly declines and says that's Sales'
  job — the skill never fires (`raw/09-crossbleed-am01-qualify-lead.json`).
- **Gotcha**: passing `--agent sales-sdr` from the `am-01` cwd (where that
  agent file doesn't exist) does **not error**. It silently falls back to
  the generic default persona ("I am Antigravity...") while still applying
  am-01's own workspace rules (`raw/10-crossbleed-wrong-agent.json`, exit
  0, no stderr warning). **This is a real footgun for agy-hq**: a
  misconfigured/missing agent name will not fail loud; the runner must
  verify the response actually reflects the intended persona (e.g. check for
  a persona marker) rather than trusting `--agent` to error on a bad name.

**Global `~/.gemini/config` leak risk — confirmed, not merely theoretical.**
Per the agy-customizations docs, global discovery (`~/.gemini/config/`) is
priority 3, below workspace but above built-ins, and applies to **every**
workspace unconditionally. On this machine there are currently no global
skills/rules/plugins installed, so we couldn't demonstrate a global *skill*
leaking in — but we found something more concrete and more dangerous:
`~/.gemini/config/config.json` has a **global `permissionGrants.allow`
list** (accumulated from unrelated past projects, e.g. `command(cat)`,
`command(git commit)`, `read_file(/Users/.../nk-invoice/.env)`) that is
**not scoped to the project it was granted in**. We proved this concretely:
from `sales-01`, asking the (unrestricted, no `--agent`) model to run
`cat AGENTS.md` executed **silently, with no permission prompt or denial**
(`raw/11-global-leak-cat.json`, tool call shows immediate success), while
`whoami` — not globally pre-approved — was auto-denied
(`raw/12-global-leak-whoami.json`, `"user denied permission to run command:
whoami"`). **Any global permission grant made while working on one project
silently applies to every agy-hq business-agent workspace on the same
machine.** For a multi-tenant/multi-role harness this is a real isolation
leak: a broad `command(...)` or `read_file(...)` grant from an unrelated dev
session gives every business agent that same access, bypassing per-workspace
intent entirely. Recommendation: run each agy-hq workspace isolated per
machine/container/user, or audit `~/.gemini/config/config.json`'s
`globalPermissionGrants` before trusting workspace-level restriction to be
sufficient.

**Trust-prompt bonus finding** (not explicitly asked but discovered while
setting up): headless `agy -p` appears to **bypass `trustedWorkspaces`
entirely**. Running from a subdirectory of the trusted
`spike/02-workspace-agents` path worked with no prompt
(`raw/00-trust-test-subdir.json`), but so did running from a **completely
untrusted** directory never listed in `settings.json`
(`/tmp/agy-untrusted-test`, `raw/00b-untrusted-dir-test.json`) — same clean
success, no trust error, no prompt. This suggests `trustedWorkspaces` is an
interactive-UI-only gate and print/headless mode does not enforce it at all.
**Do not rely on `trustedWorkspaces` as a security boundary for agy-hq's
headless runner** — treat every workspace as equally "trusted" from agy's
point of view in print mode, and enforce any sandboxing yourself (cwd
scoping, `--sandbox`, container isolation).

## Q6 — Workspace-scoped MCP (the big one)

**VERIFIED that `.agents/mcp_config.json` works headless, without
`agy mcp add` and without touching `~/.gemini`.** Built `mcp/company-mcp.ts`
(TypeScript, `@modelcontextprotocol/sdk`, stdio transport) exposing
`kb_search(query)` and `crm_get_contact(email)` over canned Makini data;
compiled to `mcp/dist/company-mcp.js`. Registered it purely via
`workspaces/sales-01/.agents/mcp_config.json`:

```json
{ "mcpServers": { "company-mcp": { "command": "node", "args": ["<abs path to dist/company-mcp.js>"] } } }
```

From that workspace (no `--agent`, i.e. default persona, which has the full
built-in toolset), asking "What is Makini's refund policy? Use your
kb_search tool" produced a real tool call: `call_mcp_tool` with
`{"ServerName":"company-mcp","ToolName":"kb_search","Arguments":{"query":"refund
policy"}}`, which returned our canned snippet, which the model then quoted
correctly (`raw/13-workspace-mcp-config-test.ndjson`). Also confirmed
`crm_get_contact` the same way from `am-01` (`raw/20-am01-crm-lookup.ndjson`).
**Per-workspace MCP scoping is real**: `am-01` without its own
`mcp_config.json` could not see `company-mcp` at all and said so plainly
(`raw/19-mcp-isolation-am01-no-access.ndjson`); once we added the same
`.agents/mcp_config.json` to `am-01`, it worked there too, independently.

**MCP tool naming in a custom agent's `tools:` allowlist: NOT POSSIBLE** —
we tried every plausible naming scheme and all failed identically with
`unknown component: tool "<name>" not found in registry`:
- `kb_search` (bare tool name)
- `company-mcp/kb_search` (server/tool — this **is** the internal id format,
  see below, but still rejected here)
- `company-mcp__kb_search`
- `mcp__company-mcp__kb_search` (Claude-Code-style)
- `call_mcp_tool` (the generic built-in wrapper tool itself — surprisingly
  also rejected, even though it's a real, callable tool name that appears in
  every `init` event)

See `raw/14*.json`, `raw/16-mcp-tool-name-dunder2.json`. **Conclusion: in agy
1.2.14, the `tools:` frontmatter allowlist only accepts the fixed built-in
tool catalog; it has no syntax for naming MCP server tools, and cannot even
be used to explicitly grant/name `call_mcp_tool`.**

**CRITICAL SECURITY FINDING: restricting `tools:` does NOT restrict MCP tool
access.** With `sales-sdr`'s `tools:` set to exactly `[view_file,
grep_search]` (no `call_mcp_tool`, no MCP reference of any kind), the agent
**still successfully called** `call_mcp_tool` → `company-mcp/kb_search` and
got real data back (`raw/17-mcp-allowlist-bypass-test.ndjson` — tool call
and successful result are right there in the trace, despite the restrictive
allowlist). **This means any MCP server registered in a workspace's
`.agents/mcp_config.json` is available to every agent in that workspace
regardless of that agent's declared tool restrictions.** For agy-hq, this
means the `tools:` allowlist is **not a valid gate for business-critical MCP
tools** (e.g. `outbox_send`, `crm_update`, anything money-adjacent) — those
must be gated by (a) which MCP servers you even register per workspace, and
separately (b) policy logic *inside* the MCP server itself (the company MCP
should refuse/require extra confirmation for risky calls itself, not rely on
agy's allowlist), and/or (c) a `PreToolUse` hook (to test in spike 03)
intercepting `call_mcp_tool` calls.

**Headless does need `--dangerously-skip-permissions` (or a specific
`permissions.allow` entry) for MCP tool calls.** Without it, the exact same
prompt/config produced `permission check failed for mcp
"company-mcp/kb_search": user denied permission for mcp(company-mcp/kb_search)`
and an auto-deny, again yielding an empty final response
(`raw/18-mcp-no-skip-permissions.ndjson`). Note the permission-grant id format
here, `mcp(company-mcp/kb_search)` — this **is** the `ServerName/ToolName`
format, confirming the permission system and the custom-agent `tools:`
schema use **different, incompatible registries** for the same underlying
tool.

## Q7 — Local plugin packaging (time permitted — done)

**VERIFIED.** Built `workspaces/plugin-demo/.agents/plugins/sales-pack/`
containing `plugin.json` (`{"name":"sales-pack"}`), `rules/AGENTS.md`,
`skills/plugin-qualify/SKILL.md`, and `mcp_config.json` — all under the
plugin directory, no `plugins.json` needed, no global install, no
`--agent` even required for this test (we validated against the
default/base agent):
- Unrelated question → `[PLUGIN-RULE-APPLIED]` present
  (`raw/21-plugin-rule-test.json`), confirming the plugin's `rules/AGENTS.md`
  auto-loads as an always-on rule just from sitting in the plugin's `rules/`
  folder.
- "Qualify this lead" → `[PLUGIN-SKILL-LOADED]` present
  (`raw/22-plugin-skill-test.json`), confirming the plugin's skill is
  discovered and triggers on-demand like a regular workspace skill.
- "Use kb_search..." → the MCP server from the plugin's `mcp_config.json`
  connected and was called successfully
  (`raw/23-plugin-mcp-test.ndjson`) — **and its server name was
  auto-namespaced to `sales-pack_company-mcp`** (`<plugin-dir>_<server-name>`),
  confirming the docs' claim that plugin-provided MCP servers are namespaced
  to avoid collisions.

We did not test an `agents/` subfolder inside the plugin (the docs only
document `rules/`, `skills/`, `mcp_config.json`, `hooks.json` for plugins,
not a place for custom-agent `.md` files) — so **packaging the persona
(custom agent) itself inside a plugin is unverified/likely not supported**;
keep `.agents/agents/<role>.md` as a plain workspace file and put
rules+skills+mcp inside the plugin, OR just skip plugins for agy-hq v1 and
use plain `.agents/{agents,rules,skills,mcp_config.json}` per workspace
(simpler, and avoids this plugin/agent-packaging gap).

---

## Summary table

| # | Question | Verdict |
|---|---|---|
| 1 | Custom agent `--agent` discovery | VERIFIED (persona loads); `agy agents` listing is interactive-only, NOT scriptable |
| 2 | `tools:` restricts built-in tools | VERIFIED, but see finding in Q6 (does not restrict MCP) |
| 3 | Rules (`AGENTS.md`, `always_on`, `model_decision`) | VERIFIED, clean discrimination |
| 4 | Skills, on-demand headless | VERIFIED |
| 5 | Workspace isolation / global leak | VERIFIED isolation; VERIFIED concrete leak via global permission grants; trust bypass also found |
| 6 | Workspace MCP via `.agents/mcp_config.json` | VERIFIED works headless, no global `agy mcp add`; MCP tool naming in `tools:` NOT POSSIBLE; `tools:` does NOT gate MCP calls (security gap); needs `--dangerously-skip-permissions` |
| 7 | Local plugin packaging | VERIFIED for rules+skills+mcp; agent/persona packaging in a plugin UNVERIFIED (docs don't describe it) |

## Surprises worth flagging to the team

1. **`tools:` allowlist is cosmetic for MCP** — the single most important
   finding. A business agent you believe is "read-only" can still call any
   MCP tool registered in its workspace, full stop.
2. **Headless mode silently returns empty success** whenever a tool call hits
   an un-granted permission (built-in or MCP) — always run with
   `--dangerously-skip-permissions` in agy-hq's runner, or pre-seed
   `permissions.allow`, or you'll get silent empty-result "successes".
3. **`trustedWorkspaces` does not appear to be enforced in print/headless
   mode at all** — don't treat it as a safety boundary for the harness.
4. **Bad `--agent` name fails silently**, falling back to the default
   persona with exit 0 and no warning — the runner must verify persona
   identity in the response, not just check the exit code.
5. **Global `~/.gemini/config` permission grants bleed into every
   workspace** regardless of project — a concrete, already-present leak on
   this dev machine (`command(cat)`, `command(git commit)`, etc. from
   unrelated projects are silently honored inside our Makini sales/AM
   workspaces).
6. The `init` event's `tools` array (stream-json) is a static full catalog,
   not the agent's actual active toolset — don't use it to audit restriction.

## Recommended workspace template layout for agy-hq

```
workspaces/<role>-<nn>/                  # e.g. workspaces/sales-01/
├── AGENTS.md                            # always-on: identity, hard "never" rules, sign-off
├── .agents/
│   ├── agents/
│   │   └── <role>.md                    # persona + tools: allowlist + model
│   ├── rules/
│   │   ├── always-on-<topic>.md         # trigger: always_on — compliance/voice rules
│   │   └── <topic>-policy.md            # trigger: model_decision — conditional SOP rules
│   ├── skills/
│   │   └── <procedure-name>/
│   │       └── SKILL.md                 # one skill per SOP (qualify-lead, chase-invoice, ...)
│   └── mcp_config.json                  # points at the ONE shared company-mcp binary, per workspace
```

Generate this from `templates/<role>/` (per PLAN.md §3.1) by copying
`agents/`, `rules/`, `skills/` and rewriting the agent's `name`/persona
variables; **do not** route MCP registration through plugins unless you also
need namespaced multi-server bundling — a flat `.agents/mcp_config.json` per
workspace is simpler and was what we verified end-to-end.

## How agy-hq should wire the company MCP per agent

- Run **one shared `company-mcp` server binary** (built once from
  `mcp/company-mcp.ts`, or a richer real version later), but point every
  workspace's own `.agents/mcp_config.json` at it with `command`/`args` —
  each agy process spawns its own instance of the MCP server as a child
  process (stdio), so there's no shared-process risk; state/caching, if
  needed, belongs in the MCP server's own backing store (e.g. the harness's
  SQLite state DB), not in server memory.
- Because the `tools:` allowlist cannot gate MCP tools, **scope risk at the
  MCP-server level**: give each role's workspace a `mcp_config.json` that
  only lists the MCP server(s) appropriate for that role (e.g. Sales gets
  `kb_search`/`crm_get_contact`/`crm_update_stage`; Accounting gets a
  different server with ledger tools) — never register a single
  "everything" MCP server across all workspaces, since any agent in that
  workspace can call any tool the server exposes.
- For actions that need human approval regardless of role (per PLAN.md's
  Outbox/approval-gate design), **enforce that inside the MCP server itself**
  (e.g. `outbox_send` always creates a draft row and returns
  "pending_approval", never actually sends) rather than trying to keep it out
  of any agent's reach via agy-side config — agy's own tool-permission system
  cannot be trusted to enforce that boundary (see Q6 finding).
- The runner must pass `--dangerously-skip-permissions` (or equivalent
  pre-seeded grants) to get non-empty results at all when MCP or built-in
  tools are involved — compensate for the resulting loss of agy's own
  guardrails with your own `PreToolUse`-style gate (to validate in spike 03)
  and by keeping dangerous operations out of agy's tool surface entirely
  (MCP-server-side gating, as above).

## Deliverables in this directory

- `workspaces/sales-01/`, `workspaces/am-01/` — two fully isolated role
  workspaces (persona, rules, skill, workspace MCP config).
- `workspaces/plugin-demo/` — local-plugin packaging test (Q7).
- `mcp/company-mcp.ts` (+ `package.json`, `tsconfig.json`, `dist/`,
  `README.md`) — the tiny stdio MCP server used throughout.
- `run_agy.sh` — timeout wrapper used for every `agy` invocation in this
  spike.
- `raw/` — every raw JSON/NDJSON output referenced above, numbered in
  chronological order.
