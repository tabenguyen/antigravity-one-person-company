# @agyhq/mcp

The company MCP server: the only window an agy agent has into business data
(CRM, knowledge base, memory, tasks, outbox). It's a thin stdio proxy — every
tool call is validated against the core schema and forwarded as one HTTP POST
to the agy-hq daemon; the server holds no business logic or state itself.

## Public API

```ts
import { createCompanyMcpServer, HqClient } from "@agyhq/mcp";

const { client, error } = HqClient.fromEnv(); // reads AGYHQ_API_URL / AGYHQ_TOKEN / AGYHQ_AGENT_ID / AGYHQ_TASK_ID
const server = createCompanyMcpServer(client ? { client } : { client: null, envError: error });
// server is a @modelcontextprotocol/sdk McpServer — connect it to any Transport.
```

- `createCompanyMcpServer({ client, envError? }): McpServer` — registers
  exactly the tools in `@agyhq/core`'s `McpTools` (same name, description,
  input shape). Each handler re-validates arguments with the **full** core
  zod schema (so `crm_find_contact`'s `.refine` cross-field rule is actually
  enforced, even though MCP's own schema only sees the unwrapped object
  shape), POSTs to `mcpRoute(tool)` via the given `HqClient`, and returns the
  response `data` as pretty-printed JSON text. Validation failures and daemon
  errors both come back as `{ isError: true, content: [...] }` with a short,
  actionable message — the handler never throws, so a bad call can't crash
  the process agy is talking to.
- `HqClient` — tiny `fetch`-based client for `POST <AGYHQ_API_URL><route>`
  with `authorization: Bearer <token>`, `x-agyhq-agent-id`,
  `x-agyhq-task-id` (when set), a ~15s timeout, and `ApiEnvelope` parsing.
  `HqClient.fromEnv(env?)` builds one from the `AGYHQ_*` vars (see core
  `ENV`) and returns `{ client: null, error: { missing: string[] } }` instead
  of throwing when required vars are absent — so the server can still start
  and explain itself to the model instead of hanging agy.

## Binary

`src/bin/company-mcp.ts` is the stdio entrypoint. Build it into one
dependency-free file:

```sh
npm run build   # -> dist/company-mcp.mjs (bundles the MCP SDK + zod, node20 target)
```

A workspace's `.agents/mcp_config.json` points at the built file under the
server key `company` (matches core `COMPANY_MCP_SERVER`):

```json
{ "mcpServers": { "company": { "command": "node", "args": ["<abs path>/dist/company-mcp.mjs"] } } }
```

All diagnostics go to stderr — stdout is reserved for the MCP protocol.

## Tests

```sh
npx vitest run packages/mcp
```

- `test/server.test.ts` — in-process MCP `Client` ↔ `createCompanyMcpServer`
  over the SDK's in-memory transport, against a mock HTTP daemon
  (`test/mock-daemon.ts`): tool list matches core `McpTools`; every tool
  posts to the right route with the right headers/body; validation errors
  never reach the daemon; a daemon error envelope and an unreachable/hung
  daemon both surface as `isError` instead of throwing; missing env still
  starts the server and errors every call with an actionable message.
- `test/stdio.test.ts` — spawns the **built** `dist/company-mcp.mjs` over a
  real stdio transport and repeats the tool-list/tool-call checks against
  the actual artifact a workspace would run.
- `test/real-agy.test.ts` — opt-in (`AGYHQ_REAL_AGY=1`), skipped otherwise.
  Builds a temp workspace with `.agents/mcp_config.json` (key `company`)
  pointing at the built binary, runs the real `agy` CLI
  (`gemini-3.8-flash-low`, `--dangerously-skip-permissions`) asking it to use
  `kb_search`, and asserts the mock daemon received the call and the answer
  contains a daemon-supplied snippet. It also records whether the MCP child
  process inherited `AGYHQ_*` from agy's own environment (no `env` key is
  set in the generated `mcp_config.json`, so this is a real observation, not
  an assumption) — **confirmed true** on agy 1.2.14: see final report.
