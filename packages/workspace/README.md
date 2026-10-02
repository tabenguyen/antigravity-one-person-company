# @agyhq/workspace

Turns a `templates/<role>/` directory into a runnable `agy` workspace
(`AGENTS.md` + `.agents/{agents,rules,skills,hooks.json,mcp_config.json}`)
for one agent instance, and renders per-task prompts from the same template.
See `docs/PHASE0.md` D6 and `docs/PLAN.md` §3.1 for the design this
implements.

## Public API

```ts
import {
  loadTemplate,       // (templatesRoot, role) => Template
  listTemplateRoles,  // (templatesRoot) => string[]
  renderWorkspace,    // ({ agent, template, templatesRoot, outDir, vars }) => { files: string[] }
  renderPrompt,       // (template, kind, input) => string
} from "@agyhq/workspace";
```

- **`loadTemplate(templatesRoot, role)`** — reads and zod-validates
  `templates/<role>/template.json`, confirms `AGENTS.md`, `agent.md`, the
  `resultSchema` file, and every `taskKinds[].prompt` file exist, and
  returns a `Template` (role, description, `defaultModel`, `policy`,
  `taskKinds`, parsed `resultSchema`, and flags for whether `rules/`,
  `skills/`, `kb/` are present). Throws with a specific message on any
  problem — nothing partial.
- **`renderWorkspace({ agent, template, templatesRoot, outDir, vars })`** —
  renders the template into `outDir` (= `agent.workspacePath`). Returns
  `{ files }`, every path written, relative to `outDir`. **Idempotent**:
  re-rendering with an updated template removes files under `outDir/.agents/`
  and `outDir/AGENTS.md` that are no longer in the template, but never reads,
  writes, or deletes anything else in `outDir` (e.g. a future
  `outDir/.agyhq/` runtime-state directory is untouched).
- **`renderPrompt(template, kind, input)`** — renders
  `templates/<role>/prompts/<...>.md` for one `taskKinds[].kind`, substituting
  `{{field}}` from `input` (non-string values are JSON-stringified). This is
  a separate placeholder context from `renderWorkspace`'s `vars` — a prompt
  only sees the task's own input fields.
- Also exported: `buildHooksConfig`, `buildMcpConfig`, `parseFrontmatter` /
  `stringifyFrontmatter`, `renderPlaceholders`, and the zod schemas
  (`TemplateJsonZ`, `ToolPolicyZ`, `TaskKindSpecZ`) if a caller wants to
  validate a `template.json` without fully loading it.

## Template format — `templates/<role>/`

```
templates/<role>/
├── template.json        { role, description, defaultModel, policy, resultSchema, taskKinds[] }
├── AGENTS.md             always-on identity + hard rules (plain markdown, {{placeholders}} ok)
├── agent.md              frontmatter: description (others overridden, see below); persona body
├── rules/*.md            frontmatter: trigger: always_on | model_decision, description
├── skills/<name>/SKILL.md  frontmatter: name, description
├── prompts/*.md          one per taskKinds[].kind; rendered by renderPrompt with task input
├── kb/*.md               role knowledge-base seed — NOT rendered by this package; ingested
│                         separately by the daemon (packages/db). Keep {{placeholders}} /
│                         TODOs for company-specific facts.
└── result-schema.json    JSON Schema matching core TaskResult, for `agy --json-schema`
```

`template.json` is validated with zod (`TemplateJsonZ`): `policy` is a
`ToolPolicy` (`builtins: string[]`, `mcp: {server, tool}[]`), and each
`taskKinds[]` entry needs a `kind`, `description`, and a `prompt` path
relative to the template directory.

### `agent.md` → `.agents/agents/<role>.md`

The renderer reads the template's `agent.md` frontmatter for **`description`**
only (and the body, as the persona). `name`, `tools`, and `model` in the
*rendered* file always come from the agent instance being rendered —
`name: <template.role>`, `tools: <agent.policy.builtins>`,
`model: <agent.model>` — never from whatever the template author put in
`agent.md`'s own frontmatter (that's just a human-readable default/preview).
This matches the contract: per-agent tool policy and model live on the
`Agent` record (`@agyhq/core`), not hardcoded per role.

### `{{placeholder}}` substitution

`renderWorkspace` substitutes `{{name}}` in `AGENTS.md`, `agent.md`
(description + body), every `rules/*.md` (frontmatter string/list values +
body), and every `skills/*/SKILL.md` the same way, from a context built as
`{ ...vars, agentId: agent.id, role: agent.role, displayName: agent.displayName, model: agent.model }`
(agent-derived values always win over `vars` of the same name). **An
unknown placeholder throws** — `renderWorkspace`/`renderPrompt` never
silently leave a `{{...}}` in rendered output.

`vars` (see `RenderVars`): `apiUrl`, `hooksDistDir`, `mcpEntry`, `nodeBin`,
`companyName`, plus whatever else a template's placeholders need.

## `.agents/hooks.json` — exact contract with `@agyhq/hooks`

```json
{
  "agyhq": {
    "PreToolUse":     [{ "matcher": ".*", "hooks": [{ "type": "command", "command": "\"<nodeBin>\" \"<hooksDistDir>/pre-tool-use.mjs\"", "timeout": 10 }] }],
    "PostToolUse":    [{ "matcher": ".*", "hooks": [{ "type": "command", "command": "\"<nodeBin>\" \"<hooksDistDir>/audit.mjs\" PostToolUse", "timeout": 5 }] }],
    "PreInvocation":  [{ "type": "command", "command": "\"<nodeBin>\" \"<hooksDistDir>/context.mjs\"", "timeout": 10 }],
    "PostInvocation": [{ "type": "command", "command": "\"<nodeBin>\" \"<hooksDistDir>/audit.mjs\" PostInvocation", "timeout": 5 }],
    "Stop":           [{ "type": "command", "command": "\"<nodeBin>\" \"<hooksDistDir>/stop.mjs\"", "timeout": 10 }]
  }
}
```

The top-level `"agyhq"` key is the hook-bundle name agy's `hooks.json` format
requires (verified in `spike/03-hooks`); `PreToolUse`/`PostToolUse` are
matcher-group arrays, `PreInvocation`/`PostInvocation`/`Stop` are flat
handler lists. Paths are shell-quoted (`"<path>"`, embedded `"` escaped).

## `.agents/mcp_config.json`

```json
{ "mcpServers": { "company": { "command": "<nodeBin>", "args": ["<mcpEntry>"] } } }
```

The server key is exactly `"company"` (`COMPANY_MCP_SERVER` from
`@agyhq/core`) — agy reports this back as `ServerName` in `call_mcp_tool`
calls, which the `PreToolUse` policy hook and the company MCP server both
key off.

**No `env` block, by design — verified against real `agy` 1.2.14:** built a
stub stdio MCP server (`test/fixtures/stub-mcp/server.mjs`) that echoes
`process.env.AGYHQ_*`, rendered it into a throwaway workspace, and ran real
`agy` with `AGYHQ_API_URL`/`AGYHQ_TOKEN`/`AGYHQ_AGENT_ID`/`AGYHQ_TASK_ID` set
on the `agy` process itself (no hooks/MCP-specific env). The
`call_mcp_tool` result contained the exact values verbatim — a stdio MCP
server child process **does inherit** agy's environment, the same way
spike 03 found hooks do. So the runner setting `AGYHQ_*` on the `agy`
process (per `docs/PHASE0.md` D2) is sufficient; nothing needs to be written
into `mcp_config.json`, and there's no secret-bearing file to `chmod 600`
here. (This independently matches what the `@agyhq/mcp` package's own
real-agy test found.)

## Tests

```
npx vitest run packages/workspace                  # 26 tests, all offline/fast
AGYHQ_REAL_AGY=1 npx vitest run packages/workspace/test/real-agy.test.ts
```

The opt-in `real-agy.test.ts` renders a full `sales-sdr` workspace with
hooks pointed at trivial allow/no-op stubs (`test/fixtures/stub-hooks/`) and
MCP pointed at a stub server (`test/fixtures/stub-mcp/server.mjs`), then
runs real `agy -p --agent sales-sdr ...` from that directory and asserts the
response states the persona's name and role. **Run once, passed**
(44.8s, `gemini-3.8-flash-low`): response was in-persona ("Mai", "Sales
Development Representative").

## `templates/account-manager/`

A minimal stub (`template.json` + `AGENTS.md` + `agent.md` + one placeholder
task kind/prompt/result-schema, just enough to satisfy `loadTemplate`) so
the loader/renderer are exercised against a second role. Full Account
Manager content (rules, skills, prompts, KB) is a separate piece of work.
