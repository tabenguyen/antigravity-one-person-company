# @agyhq/runner

Spawns the `agy` CLI headlessly for one task run, parses its `stream-json`
NDJSON event stream defensively, and classifies the outcome into
`@agyhq/core`'s `RunResult.outcome`. Also exposes `agy --version` and
`agy -p "/usage"` quota polling.

This package only runs a single `agy` process per call — scheduling,
concurrency limits, and per-agent/per-thread locking live in the daemon, not
here (see `docs/PHASE0.md` D2 and `docs/PLAN.md` §3.1).

## Public API

```ts
import {
  startRun, runAgy,
  type RunOptions, type RunHandle,
  type AgyEvent, parseAgyLine, getConversationId,
  getAgyVersion,
  readQuota, parseQuotaOutput,
  resolveAgyBin,
} from "@agyhq/runner";
```

### `startRun(opts: RunOptions): RunHandle`

Spawns `agy` and returns immediately with a live handle:

```ts
interface RunHandle {
  events: AsyncIterable<AgyEvent>;      // live NDJSON events as they arrive
  result: Promise<RunResult>;           // resolves once the process exits — never rejects
  kill(reason?: string): void;          // SIGTERM now
  pid: number | undefined;
}
```

`RunOptions`:

```ts
interface RunOptions {
  cwd: string;                    // workspace dir (picks up .agents/, AGENTS.md, mcp_config.json)
  prompt: string;
  agent?: string;                 // --agent <role>
  model?: string;                 // --model <id>, e.g. "gemini-3.8-flash-low"
  conversationId?: string;        // --conversation <id> (resume). Never --continue — see below.
  jsonSchema?: object;            // written to a temp file, passed as --json-schema <file>, cleaned up after
  timeoutMs: number;              // hard ceiling; also becomes agy's own --print-timeout
  env?: Record<string, string>;   // merged OVER process.env — how AGYHQ_* reach hooks/MCP
  agyBin?: string;                // default: AGY_BIN env var, else "agy" via PATH
  extraArgs?: string[];
  signal?: AbortSignal;
}
```

### `runAgy(opts: RunOptions): Promise<RunResult>`

Convenience wrapper over `startRun` for callers that only want the final
result (drains `events` internally so nothing blocks).

### Event types & parser

`AgyEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent | AgyParseErrorEvent | AgyUnknownEvent`.
`parseAgyLine(line: string): AgyEvent | null` never throws: invalid JSON or
JSON missing a string `event` field comes back as `AgyParseErrorEvent`
instead of crashing the caller, and an `event` value this package doesn't
recognize is preserved as `AgyUnknownEvent` rather than dropped.
`getConversationId(ev)` hides the inconsistent placement of
`conversation_id` (top-level on `init`, nested on `step_update`/`result`).

### `getAgyVersion(agyBin?): Promise<string | null>`

Trimmed `<bin> --version` output, cached per resolved binary path. Resolves
`null` (never throws) if the binary can't be spawned. agy auto-updates, so
record this per run rather than assuming a version.

### `readQuota(agyBin?): Promise<QuotaBucket[]>`

Runs `agy --print "/usage" --output-format json` (costs no tokens/quota) and
flattens the per-model-group buckets into `@agyhq/core`'s `QuotaBucket[]`.
`parseQuotaOutput(raw: string)` is exported separately for unit testing the
parsing in isolation. Both are fully defensive — any missing/malformed piece
of the shape is skipped, never thrown (this shape was observed only once,
in `spike/04-concurrency-sdk`).

## Invocation contract (docs/PHASE0.md D2)

```
agy --print= --input-format stream-json --output-format stream-json \
    --dangerously-skip-permissions \
    [--agent <role>] [--model <id>] [--conversation <id>] \
    [--json-schema <file>] --print-timeout <N>s
```

followed by one stdin line `{"event":"user","message":{"role":"user","content":"<prompt>"}}`,
then stdin is closed — one-shot task run, not a multi-turn session.

**Verified against the real binary** (agy 1.2.14, `gemini-3.8-flash-low`,
`AGYHQ_REAL_AGY=1 npx vitest run packages/runner/test/real-agy.test.ts`):
outcome `ok`, non-empty `conversationId`, ~8.3s wall time — exactly the
contract above, no deviations found.

One detail not spelled out in the task description but required by the real
CLI (confirmed live and via an orchestrator note from the `mcp` package's own
real-agy test): `--print-timeout` needs a Go-duration **unit suffix**
(`60s`, `2m`); a bare number fails agy's argument parsing. This package
always formats it as `` `${Math.ceil(timeoutMs / 1000)}s` ``, floored at `1s`
— `0` would mean "no timeout" to agy (its own default), which would silently
disable agy's internal cutoff and leave only this package's much coarser
watchdog as a backstop.

### Sharp edges this package handles (see `docs/PHASE0.md` §2 / spike FINDINGS.md)

- **Timeout = success**: on `--print-timeout`, agy reports `status: SUCCESS`,
  an empty response, and exit 0. The only tell is a stderr line containing
  `print timeout after ... returning partial output`. Checked explicitly,
  never inferred from status/exit code.
- **Denied tools = success**: a fully-denied turn also reports
  `status: SUCCESS`, with a populated `denied_actions` array instead.
  Checked explicitly before falling through to the `error`/`empty` checks.
- **No `--continue`**: this package only ever resumes via an explicit
  `conversationId` the caller tracks; `--continue` resumes "the globally most
  recent conversation," a race condition in a concurrent harness.
- **Own watchdog, independent of agy's `--print-timeout`**: SIGTERM at
  `timeoutMs + 15s`, SIGKILL `5s` after that, as defense in depth against agy
  hanging despite its own timeout flag.

### Result classification (`RunResult.outcome`)

Checked in this order (a timed-out or denied turn otherwise looks like a
bland, empty success):

1. `timeout` — stderr contains the print-timeout marker, or the Runner's own
   watchdog fired.
2. `denied` — `result.denied_actions` non-empty.
3. `error` — spawn failure, non-zero exit, or no `result` event ever arrived.
4. `invalid_output` — `jsonSchema` was given but `structured_output` is
   missing or not an object.
5. `empty` — no text and no structured output.
6. `ok` — otherwise.

## Usage

```ts
import { runAgy } from "@agyhq/runner";

const result = await runAgy({
  cwd: "/path/to/workspaces/sdr-01",
  prompt: "Research acme.com and draft a first-touch email.",
  agent: "sales-sdr",
  model: "gemini-3.8-flash-low",
  timeoutMs: 120_000,
  env: {
    AGYHQ_AGENT_ID: "sdr-01",
    AGYHQ_TASK_ID: "task_abc",
    AGYHQ_API_URL: "http://127.0.0.1:7317",
    AGYHQ_TOKEN: "...",
  },
});

if (result.outcome === "ok") {
  // result.text, result.structured, result.usage, result.conversationId
}
```

Live/streaming variant:

```ts
import { startRun } from "@agyhq/runner";

const handle = startRun({ cwd, prompt, timeoutMs: 120_000 });
for await (const ev of handle.events) {
  if (ev.event === "step_update" && ev.step_update.step_type === "tool") {
    console.log(ev.step_update.tool_name);
  }
}
const result = await handle.result;
```

## Testing

```
npx vitest run packages/runner
```

Unit/integration tests run against a fake `agy` binary
(`test/fixtures/fake-agy.mjs`, scenario selected via `FAKE_AGY_SCENARIO`),
replaying NDJSON shapes trimmed from `spike/01-headless-io/raw/` and
`spike/04-concurrency-sdk/runs/probe-usage-0-*/stdout.json`. Scenarios:
`ok`, `ok_structured`, `print_timeout`, `denied_actions`, `empty`,
`missing_result`, `exit1`, `hang`. Argv/stdin the fake receives are recorded
to `FAKE_AGY_DEBUG_FILE` and asserted against the contract above.

One opt-in test exercises the real binary:

```
AGYHQ_REAL_AGY=1 npx vitest run packages/runner/test/real-agy.test.ts
```
