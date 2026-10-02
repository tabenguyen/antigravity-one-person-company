# Phase 0 spike #1 — headless I/O contract

Binary: `~/.local/bin/agy`, version **1.2.14** (PLAN.md says 1.1.19 — the CLI
has been auto-updated since the plan was written; `agy update` was not run by
this spike). All experiments below ran from
`/Users/nguyentam/Documents/Makini/agy-ui/spike/01-headless-io` (a trusted
workspace), mostly with `--model gemini-3.8-flash-low` to save quota. Raw
transcripts are in `raw/`; filenames are referenced inline below.

---

## Q1 — Event schema of `text` / `json` / `stream-json`

**VERIFIED.**

### `--output-format text`
Prints only the final assistant message as plain text to stdout. Nothing else.
(`raw/q1-trivial-text.txt`, `raw/q1-tools-text.txt`)

### `--output-format json`
A single JSON object on stdout when the run finishes:
```json
{
  "conversation_id": "...",
  "status": "SUCCESS" | "ERROR",
  "response": "<final text>",
  "error": "<only present when status=ERROR>",
  "duration_seconds": 3.72,
  "num_turns": 1,
  "structured_output": { "...": "..." },
  "json_schema": { "...": "..." },
  "usage": { "input_tokens": 0, "output_tokens": 0, "thinking_tokens": 0, "cache_read_tokens": 0, "total_tokens": 0 }
}
```
`structured_output`/`json_schema` only appear when `--json-schema` was used.
Tool calls are invisible in `json` mode — `num_turns` stays `1` even when the
agent ran `run_command` + `view_file` mid-turn (`raw/q1-tools-json.txt`). No
dollar-cost field was ever observed in any output mode.

### `--output-format stream-json`
NDJSON on stdout, one JSON object per line, each with a top-level `"event"`
field. Full event-type catalog observed (`raw/q1-trivial-stream.txt`,
`raw/q1-tools-stream.txt`, `raw/q3-schema-file-stream.txt`):

| event | when | key fields |
|---|---|---|
| `init` | first line, once | `conversation_id` (**top-level**, not nested), `init.model`, `init.cwd`, `init.tools[]` (58 built-in tool names), `init.permission_mode` (`always-proceed` or `request-review`) |
| `step_update` | one per lifecycle transition of a step | `step_update.conversation_id` (**nested**), `step_index` (monotonic, keeps climbing across turns), `state` (`ACTIVE`\|`DONE`\|`ERROR`), `step_type` |
| `result` | once per turn (terminal) | `result.conversation_id` (**nested**), `status`, `response`, `duration_seconds`, `num_turns` (cumulative), `usage` (cumulative), optional `structured_output`/`json_schema`/`denied_actions` |

`step_type` values seen: `user_input`, `agent_response` (carries incremental
`text_delta` on ACTIVE lines, final `usage` on the DONE line), `tool` (carries
`tool_name` + `tool_info.{parameters, output|error}`), `finish` (terminal
step when `--json-schema` forces a structured finish), `system_message`
(observed once, emitted by `--mode plan`'s automatic plan-acknowledgement —
see Q6).

**Surprises / gotchas:**
- `conversation_id` placement is inconsistent: top-level on `init`, nested
  inside the event payload on `step_update`/`result`. A naive `d.conversation_id`
  read will be `undefined` for 2 of 3 event kinds.
- There is **no distinct top-level `"error"` event type**. Errors show up as
  (a) a `result` with `status: "ERROR"` and an `error` string, (b) a
  non-JSON `Error: ...` line with no `init` at all for pre-flight
  validation failures (bad flags/schema — exits before the run starts), or
  (c) plain diagnostic text on **stderr** (not stdout) for runtime warnings
  like permission denials or print-timeout (prefixed `jetski:` or `[agy]`).
- No "thinking" event distinct from agent_response — `thinking_tokens` is
  just a usage counter; the model's reasoning content itself is never
  streamed as text in print mode (only tokens are billed/reported).
- Tool `tool_info.output` shape is tool-specific and informal (e.g. a raw
  shell-output string for `run_command`, a "N lines, M bytes" summary string
  for `view_file`) — do not assume a consistent schema across tools.

**Recommendation for Runner:** parse NDJSON defensively (one JSON.parse per
line, swallow non-JSON lines as diagnostics rather than crashing), always
read `conversation_id` via a per-event-kind accessor, and treat stderr as a
first-class error channel alongside stdout.

---

## Q2 — `--input-format stream-json` message shape; multi-turn

**VERIFIED**, shape differs from Claude Code's convention.

- `-p`/`--print`/`--prompt` are all **greedy**: they unconditionally consume
  the very next argv token as the prompt text, even if it looks like another
  flag (e.g. `-p --input-format stream-json` makes `--input-format` the
  prompt and errors). For stdin-driven stream-json input you must pass an
  **explicit empty value**: `--print=''` (bare `--print` with nothing after
  it on argv errors with "flag needs an argument"). (`raw/q2-input-variant-claudecode.txt`)
- Claude-Code-style `{"type":"user","message":{"role":"user","content":"..."}}`
  is rejected — the field is not `"type"`, it's `"event"`, and the only
  accepted value is `"user"`. Guessed alternatives (`"user_input"`,
  `"message"`, `"prompt"`, `"user_message"`) all produce
  `warning: ignoring unsupported stream input message event "<x>"` on
  stderr and are silently skipped — no error, no turn runs. The real shape
  was found by reading the Go unmarshal error text itself
  (`StreamInputMessage.message` of type `printmode.StreamInputUserMessage`).
- **Working shape**, confirmed by trial/error:
  ```json
  {"event":"user","message":{"role":"user","content":"your prompt text"}}
  ```
  (`raw/q2-input-variants2.txt`, final working form)
- **Multiple turns over one process**: confirmed. Write multiple NDJSON
  lines to stdin (one `{"event":"user",...}` per turn); the process emits a
  full `step_update`s → `result` cycle **per line** (one shared `init`),
  and conversation state (memory) persists between them in the same
  process — a second turn correctly recalled a secret word given in the
  first (`raw/q2-multiturn.txt`). `result.num_turns` and `result.usage`
  accumulate across turns rather than resetting per turn.

**Recommendation for Runner:** the TS wrapper (`agy-events.ts`) encodes the
exact `--print=''` + `{"event":"user","message":{"role":"user","content":...}}`
contract. Long-lived multi-turn processes are viable for a single
task-scoped conversation, but given PLAN.md's preference for short
task-scoped conversations + written summaries (section 3.3), the harness
should default to one-shot `-p "<prompt>"` processes and only keep a
stream-json process alive when a task genuinely needs several dependent
turns in quick succession.

---

## Q3 — `--json-schema` (inline and file)

**VERIFIED**, works identically both ways.

- Both an inline JSON string and a path to a `.json` file work
  (`raw/q3-schema-inline-json.txt`, `raw/q3-schema-file-stream.txt`).
- In `json` output: result object gains `structured_output` (parsed object,
  conforming exactly to the schema's declared properties) and `json_schema`
  (echo of the schema supplied).
- In `stream-json` output: same two fields appear inside the terminal
  `result` event; a `finish` step_update also appears as the second-to-last
  line.
- The underlying model's raw text response (visible in `response`) may
  contain **extra keys beyond the schema** (observed: `toolAction`,
  `toolSummary` — internal tool-call scaffolding the model emitted as part
  of its structured-output tool call). `structured_output` itself is
  correctly filtered down to just the schema's declared keys — safe to
  consume directly.
- Malformed schema JSON is caught **before** the run starts: plain
  `Error: invalid --json-schema: schema is not valid JSON: ...` text (no
  `init` event, exit code 1) (`raw/q3-bad-schema.txt`).

**Recommendation:** have the Runner always pass `--json-schema` as a file
path (not inline string) for anything beyond a trivial schema, to avoid
shell-quoting fragility, and consume `structured_output` directly rather
than re-parsing `response`.

---

## Q4 — Conversation continuity

**VERIFIED** for `--conversation`; **VERIFIED with an important caveat** for
`--continue`/`-c`; **PARTIAL** for `--project`/`--new-project`.

- `--conversation <id>` resumes a specific conversation by UUID across
  separate process invocations; the model correctly recalled a value from
  the first process in a second, independent process
  (`raw/q4-conv1.txt` → `raw/q4-conv2-resume.txt`).
- `-c`/`--continue` resumes "the most recent conversation" and worked in
  isolation (`raw/q4-continue.txt`, `num_turns` kept climbing). **Caveat:**
  "most recent" appears to be scoped globally (per machine/user, not per
  cwd/workspace) — in a concurrent multi-agent harness running several `agy`
  processes at once (exactly the Phase-0 setup, with sibling spikes running
  in parallel directories), `--continue` is a race condition waiting to
  happen: a worker could silently resume a different agent's conversation.
  **Recommendation: never use `--continue`/`-c` in the harness; always pass
  an explicit `--conversation <id>` that the Runner tracks itself** (per
  PLAN.md section 3.3's `(agent, thread) → conversationId` mapping).
- `--new-project` and `--project <name>` both ran without error
  (`raw/q4-new-project.txt`, `raw/q4-project-named.txt`), but neither
  surfaces a project id/name anywhere in `json`/`stream-json` output, so
  their effect could not be fully confirmed from the CLI's own output alone
  within this spike's scope — marking this **PARTIAL**. Side investigation
  found project bindings live as JSON files at
  `~/.gemini/config/projects/<id>.json` (schema: `id`, `name`,
  `projectResources.resources[].{gitFolder|folderUri}`, `permissionGrants`),
  keyed by folder — this looks like the mechanism PLAN.md section 3.1 could
  use for per-role workspace trust/permission presets, but needs a
  dedicated follow-up spike to pin down `--project`'s exact print-mode
  semantics.
- **Conversation storage**: each conversation is a standalone SQLite file:
  `~/.gemini/antigravity-cli/conversations/<uuid>.db`. There's also a
  `~/.gemini/antigravity/conversations/<uuid>.db` tree (older/parallel
  location — not explored further) and a
  `~/.gemini/antigravity-cli/conversation_summaries.db` that appears to
  index/summarize them. Did not open or modify any of these (per the "don't
  touch ~/.gemini except what agy writes" constraint — these are agy's own
  writes from the runs above).

---

## Q5 — `--print-timeout` behavior; exit codes

**VERIFIED — and this is the single biggest gotcha found in this spike.**

- On a `--print-timeout 3s` against a prompt that triggers a 20-second
  `sleep` tool call: agy returns after ~3s (not 20s) with a `result` event
  reporting **`"status": "SUCCESS"`**, empty `"response"`, `duration_seconds: 0`,
  and all-zero `usage` — and **exits with code 0**, identical to a real
  success. The *only* indication a timeout happened is a line on **stderr**:
  `[agy] print timeout after 3s with turn in progress; returning partial output`
  (`raw/q5-timeout.txt`, `raw/q5-timeout-stream.stdout.txt` /
  `.stderr.txt` / `.exit.txt`).
  **A Runner that only checks `status`/exit code will misclassify a timed-out
  task as a trivially-successful empty response.** Must explicitly scan
  stderr for this marker (or treat `status: SUCCESS` + empty `response` +
  all-zero `usage` as suspect and re-verify).
- Exit codes confirmed:
  - `0` — process completed, **including a `--print-timeout` cutoff** (see
    above — NOT a reliable success signal on its own).
  - `1` — runtime error (`status: "ERROR"` in JSON output, e.g. invalid
    model/effort combo) (`raw/q5-bad-model.txt`).
  - `2` — CLI usage error: unknown flag, missing required value
    (`raw/q5-bad-flag.txt`).
- Pre-flight validation errors (bad model id, bad effort, invalid schema)
  print plain `error: ...`/`Error: ...` text — **not JSON**, even when
  `--output-format json`/`stream-json` was requested — and exit 1. No
  `init` event is ever emitted for these. The Runner must special-case "no
  JSON at all on stdout" as its own error path, separate from "got JSON
  with status ERROR".

---

## Q6 — Permissions in print mode; `--mode`; `--sandbox`

**VERIFIED**, and the behavior is good news for the harness design.

- **Without `--dangerously-skip-permissions`** (default `request-review`
  mode), a tool call needing approval (`run_command`, `write_to_file`) does
  **NOT hang** and does **NOT** stop the run. It's **auto-denied**
  immediately (<20ms): the tool's `step_update` goes to `state: "ERROR"`
  with `tool_info.error = {type: "TOOL_ERROR", message: "permission check
  failed for ... user denied permission ..."}`, the agent gets that denial
  back as a tool result and continues its turn, and the final `result`
  still reports **`status: "SUCCESS"`** but with a new
  `"denied_actions": [{"action": "command", "display_name": "RunCommand"}]`
  array. (`raw/q6-no-skip-permissions.txt`, `raw/q6-write-no-skip.txt`)
  **Recommendation: the Runner must always check `denied_actions`, not just
  `status`** — a fully-blocked, useless turn still reports SUCCESS.
  Stderr also carries a human-readable hint (`jetski: ... Add an allow-rule
  under permissions.allow in settings.json ... Alternatively, re-run with
  --dangerously-skip-permissions`).
- **`--mode accept-edits`** (no `--dangerously-skip-permissions`): file
  writes/edits (`write_to_file`) are auto-approved and succeed
  (`raw/q6-write-accept-edits.txt`, confirmed file was actually written).
  **`run_command` is still auto-denied** under `accept-edits`
  (`raw/q6-run-accept-edits.txt`) — this is a genuinely useful
  fine-grained trust tier: an agent can be allowed to edit/produce files
  without also being allowed to run arbitrary shell commands.
- **`--mode plan`**: the agent first writes an implementation-plan markdown
  file into agy's own internal state dir
  (`~/.gemini/antigravity-cli/brain/<conversation_id>/*.md` — this write is
  auto-approved, it's not touching the workspace), emits a `system_message`
  step (an automatic plan-acknowledgement — there's no human in headless
  mode to click "approve plan", so it appears to auto-continue past the
  plan gate), and then attempts the actual file write, which is denied
  exactly like the no-skip-permissions case above
  (`raw/q6-write-plan-mode.txt`). Net effect in headless use: `--mode plan`
  behaves like "always deny the real mutating action, but still let the
  agent narrate/plan it" — useful for a `shadow` trust tier (PLAN.md
  section 3.1) where you want to see what the agent *would* do.
- **`--sandbox`** (combined with `--dangerously-skip-permissions` to
  isolate its effect from the permission system): a plain `echo` via
  `run_command` succeeded normally (`raw/q6-sandbox.txt`). This only
  confirms `--sandbox` doesn't block trivially benign commands; this spike
  did **not** have budget to probe what it actually restricts (network
  access, specific binaries, filesystem scope outside the workspace) —
  flagged as a good target for a focused follow-up in the hooks/permissions
  spike (sibling dir `03-hooks`).

**Recommendation for Runner/trust tiers:** map PLAN.md's `shadow` →
`--mode plan` (its deny behavior is already fail-closed), `assisted` →
`--mode accept-edits` plus a narrow `permissions.allow` list of specific
vetted commands for anything beyond file edits, `autonomous` →
`--dangerously-skip-permissions` scoped to a locked-down workspace +
`--sandbox`. In all tiers, always inspect `denied_actions` in the result,
never rely on `status` alone.

---

## Q7 — `--model` / `--effort`

**VERIFIED.**

- `agy models` lists 14 ids (as of 1.2.14): `gemini-3.8-flash-{high,medium,low}`,
  `gemini-3.7-flash-{high,medium,low}`, `gemini-3.6-flash-{high,medium,low}`,
  `gemini-3.1-pro-{high,low}`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`,
  `gpt-oss-120b-medium` (`raw/agy-models.txt`).
- `--model <id>` works for every family tried, including cross-vendor
  (`claude-sonnet-4-6` ran successfully, `raw/q7-claude-model.txt`).
- `--effort` is **mutually exclusive with model ids that already encode an
  effort level in their name** — e.g. `--model gemini-3.8-flash-low --effort
  high` errors with `--model ... conflicts with --effort=...`
  (`raw/q7-effort-high.txt`). It also errors for models with no effort
  concept at all (`claude-sonnet-4-6 --effort low` →
  `--effort is not supported for model "claude-sonnet-4-6"`,
  `raw/q7-claude-effort.txt`).
- `--effort` **does** work when combined with a bare model id that has no
  suffix, e.g. `--model gemini-3.1-pro --effort low` succeeds and the `init`
  event reports `model: "gemini-3.1-pro"` (`raw/q7-bare-model-effort-ok.txt`).
  Passing an effort level the model doesn't support errors with a clear
  message listing valid options (`raw/q7-bare-model-effort.txt`:
  `gemini-3.1-pro has no "medium" effort (available: low, high)`).

**Recommendation:** the Agent registry (PLAN.md section 3.1) should store
model selection as a single resolved id (the full `-high/-medium/-low`
suffixed form agy already lists), not a separate `(model, effort)` pair —
it's simpler and avoids this conflict class entirely. Only use the bare
`--model` + `--effort` combo if a future model ships without baked-in effort
suffixes.

---

## Deliverables

- `agy-events.ts` — full `AgyEvent` discriminated union, `getConversationId()`
  helper to paper over the inconsistent id placement, `runAgy()` wrapper
  (spawns agy, parses NDJSON defensively, exposes `events`/`exitCode`/
  `stderrLines`), and a demo `main()`. **Actually run** via `npx tsx
  agy-events.ts` — see `raw/demo-run.txt` for full output (tool calls fired,
  README.md read, marker string correctly extracted, clean exit 0).
- `demo-multiturn.ts` — second demo exercising the `inputTurns` /
  stream-json-input path of the wrapper; confirmed cross-turn memory and
  per-turn `result` events (`raw/demo-multiturn-run.txt`).
- `run-with-timeout.sh` — `perl alarm`-based timeout wrapper used for every
  experiment above (macOS has no `timeout`/`gtimeout` by default).
- `raw/` — 40+ captured transcripts, one or more per question above,
  referenced by filename throughout this document.

## Overall status for Phase 0 checklist items covered here

| Item | Status |
|---|---|
| stream-json event schema | VERIFIED |
| json output shape | VERIFIED |
| stream-json input shape, multi-turn | VERIFIED |
| `--json-schema` inline + file | VERIFIED |
| `--conversation` resume | VERIFIED |
| `--continue`/`-c` | VERIFIED (works) but **not recommended** for concurrent use |
| `--project`/`--new-project` | PARTIAL — runs clean, effect not fully observable from CLI output alone |
| `--print-timeout` behavior | VERIFIED — and a real footgun (silent SUCCESS) |
| exit codes | VERIFIED (0/1/2) |
| permission auto-deny in print mode | VERIFIED — fails closed, doesn't hang |
| `--mode plan`/`accept-edits` | VERIFIED — meaningfully different trust tiers |
| `--sandbox` | PARTIAL — doesn't block benign commands, deeper restrictions unexplored |
| `--model`/`--effort` | VERIFIED |

No items are NOT POSSIBLE — everything in this spike's question list was
answerable with the time/quota budget available; the two PARTIAL items
(`--project` semantics, `--sandbox` restrictions) are good candidates for a
few more cheap-model experiments in a follow-up pass rather than blockers.
