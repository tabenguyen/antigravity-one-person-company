# Phase 0 Spike #3 — Lifecycle hooks in headless/print mode

`agy` binary under test: **1.2.14** (the PLAN.md primitives table was written
against 1.1.19 — everything tested here behaves the same on 1.2.14).
Workspace: `spike/03-hooks/` (self-contained; `.agents/hooks.json` +
`.agents/scripts/*.mjs`, no external npm deps). All runs used
`--model gemini-3.8-flash-low`, `--print-timeout 90s` and/or a `perl alarm`
wrapper. Raw evidence for every run below lives in `raw/<run-name>.stream.jsonl`
(+ `.stderr.log`) and `raw/<run-name>/<Event>.jsonl` (hook-side captures).

---

## Q1 — Do hooks fire in print mode? Which events?

**VERIFIED.** All five events fire in `-p`/`--output-format stream-json` mode:
`PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`.

Evidence: `raw/02-baseline-skip-perms/{PreToolUse,PostToolUse,PreInvocation,PostInvocation,Stop}.jsonl`
— one real run (`echo` command + final text) produced exactly: PreInvocation x2,
PostInvocation x2 (once per model call: the tool-call turn and the final-text
turn), PreToolUse x1, PostToolUse x1, Stop x1.

Common fields on every payload: `conversationId`, `workspacePaths`,
`transcriptPath`, `artifactDirectoryPath`, `modelName`. For the CLI
specifically, `transcriptPath` is under
`~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`
— different from the generic doc example path; always use the path in the
payload, never hardcode it.

`PreToolUse` payload adds `toolCall: {name, args}` and `stepIdx`.
`PostToolUse` adds the same `toolCall` plus `error` (empty string on success).
`PreInvocation`/`PostInvocation` add `invocationNum`, `initialNumSteps`.
`Stop` adds `executionNum`, `terminationReason`, `error`, `fullyIdle`.

**Surprise:** in a run where the first tool call is denied before executing
(baseline without `--dangerously-skip-permissions`, `raw/01-baseline/`), only
`PreInvocation` and `PreToolUse` fired — `PostToolUse`/`PostInvocation`/`Stop`
did not. A tool that never completes execution never reaches `PostToolUse`.

Full TypeScript types for every payload/response: `hook-types.ts`.

---

## Q2 — Policy gate: can PreToolUse deny/overwrite/force-ask a tool call?

**VERIFIED**, with one important nuance around `--dangerously-skip-permissions`.

- **Deny**: a `PreToolUse` hook returning `{"decision":"deny","reason":"..."}`
  hard-blocks the tool — confirmed with a `rm -rf ...` command matched by a
  regex policy gate. The tool step gets `state: "ERROR"` with
  `error.message: "tool call denied by pre-tool hook: <reason>"`, and the
  model sees that exact string and reports it to the user without retrying.
  **This holds even under `--dangerously-skip-permissions`** — deny is not
  overridden by that flag. Evidence: `raw/03-policy-deny.stream.jsonl`.
- **Overwrite**: `{"decision":"allow","overwrite":{"CommandLine":"echo OVERWRITTEN-BY-HOOK"}}`
  replaced the executed command; the agent's own report of "the exact output"
  showed the rewritten command's output, not the original. Shallow/top-level
  merge as documented. Evidence: `raw/04-policy-overwrite.stream.jsonl`.
- **Force "ask"**: behavior depends on `--dangerously-skip-permissions`:
  - **With** the flag (`permission_mode: "always-proceed"`): `force_ask`
    was effectively treated as **allow** — the command ran anyway
    (`raw/05-policy-force-ask.stream.jsonl`). The flag appears to resolve
    any would-be interactive prompt, including one a hook asks for, to
    "yes."
  - **Without** the flag (`permission_mode: "request-review"`):
    `force_ask` was **auto-denied** with the same generic message headless
    mode gives any un-answerable permission prompt:
    `"permission check failed for unsandboxed ... user denied permission"`
    (`raw/05b-policy-force-ask-no-skip.stream.jsonl`). No actual human was
    asked; the harness treats "can't prompt" as "no."

**Recommendation for agy-hq**: never rely on `ask`/`force_ask` from a hook in
a headless worker — it silently becomes either "always allow" (if you pass
`--dangerously-skip-permissions`, which agy-hq's runner will need for *any*
non-interactive tool use) or "always deny" (if you don't). For real human
review, the hook must route to agy-hq's own approval inbox and `deny` by
default until approved — i.e., build "ask" ourselves on top of `deny`
(see Recommended Design below), don't depend on agy's `ask` decision.

---

## Q3 — Context injection via PreInvocation

**VERIFIED.** A `PreInvocation` hook returning
`{"injectSteps":[{"ephemeralMessage":"Customer note ...: prefers Vietnamese"}]}`
caused the model to correctly answer "What language does this customer
prefer?" — a fact that appeared nowhere in the user prompt — and to cite "the
CRM customer note" as the source. Evidence: `raw/06-context-inject.stream.jsonl`,
transcript line `{"step_index":1,"source":"SYSTEM_SDK","type":"EPHEMERAL_MESSAGE",...}`.

This is exactly the "Customer note" injection scenario from the task, and is
a solid mechanism for agy-hq's per-thread/entity context (3.2 KB / entity
notes) without stuffing it into the user-visible prompt.

---

## Q4 — Stop hook: payload, forced continuation, checkpoint timing

**VERIFIED**, `decision: "continue"` works and is the right checkpoint point.

- A `Stop` hook returning `{"decision":"continue","reason":"..."}` on
  `executionNum` 0 and 1 forced the agent to keep going twice (it obediently
  echoed "CHECKPOINT1"/"CHECKPOINT2" per the injected reason) and only
  stopped for real on the 3rd attempt (`executionNum: 2`, hook returned
  `{}`). Evidence: `raw/07-stop-continue.stream.jsonl`,
  `raw/07-stop-continue/Stop.jsonl`.
- The `reason` string is injected into the transcript as a
  `source: "SYSTEM", type: "SYSTEM_MESSAGE"` line wrapped in a
  `<SYSTEM_MESSAGE>` tag, prefixed `"Stop hook blocked termination: "` —
  the model treats it as an instruction, not just FYI text.
- `transcriptPath` **is** readable and non-empty at Stop time — it contains
  every step up to and including the final model turn that just finished
  (verified: 6-line transcript present at the 3rd and final Stop call).
  Format: NDJSON, one object per step
  (`step_index, source, type, status, created_at, content|tool_calls`).
- **This is a good checkpoint point** for agy-hq: Stop fires once per
  "the model thinks it's done" attempt, with the transcript fully flushed to
  disk and `fullyIdle` telling you whether background tool calls are still
  running. Recommended use: on `Stop`, read `transcriptPath`, persist a task
  summary / conversation-state row, and only return `{}` (let it actually
  stop) once your own task state machine agrees the task is done — otherwise
  `continue` with a reason describing what's still missing.

**terminationReason surprise**: doc's example value is `"model_stop"`; every
run in this spike that stopped normally reported `"NO_TOOL_CALL"` instead.
Treat the doc's enum as illustrative, not exhaustive — don't match on
`"model_stop"` specifically.

---

## Q5 — Failure modes: fail open or fail closed?

**VERIFIED — PreToolUse fails closed in all four modes tested; PostToolUse
cannot "fail closed" at all because the action already happened.**

| Failure mode (on PreToolUse) | Result | Evidence |
|---|---|---|
| Hook sleeps past its `timeout` (3s configured, hook sleeps 15s) | Hook process killed; tool call **blocked**: `"JSON hook \"...\" failed: command failed: signal: killed"` | `raw/08a-fail-timeout.stream.jsonl` |
| Hook exits non-zero, no stdout | Tool call **blocked**: `"... command failed: exit status 1"` | `raw/08b-fail-nonzero.stream.jsonl` |
| Hook prints invalid JSON to stdout | Tool call **blocked**: `"failed to unmarshal result from hook ... via protojson: ... invalid value"` | `raw/08c-fail-invalid-json.stream.jsonl` |
| `command` points at a script that doesn't exist | Tool call **blocked**: shell `MODULE_NOT_FOUND`/exit-1 surfaced the same way | `raw/08d-fail-missing-script.stream.jsonl` |

All four look the same to the agent/model: a `TOOL_ERROR` on that step, with
the hook's own failure text included verbatim, and **no fallback to
"allow."** This is exactly the fail-closed behavior agy-hq needs for an
outbound-action gate — a broken policy hook stops the action instead of
silently letting it through.

**PostToolUse is different** — since the tool has already executed by the
time `PostToolUse` runs, a hook failure there (tested: non-zero exit) cannot
undo the side effect. The command's real output was still captured and
returned, but the tool step was marked `state: "ERROR"` and the failure text
was surfaced to the model (`raw/08e-fail-posttool-nonzero.stream.jsonl`).
**Conclusion: never use PostToolUse as a safety gate — only PreToolUse can
actually prevent an action. PostToolUse is audit/cleanup only, and a broken
PostToolUse hook degrades to "noisy but harmless," not fail-closed.**

(Stop/PreInvocation/PostInvocation failure modes were not separately
retested — by analogy with the uniform error-surfacing behavior above and
the architecture description ("hooks run synchronously and block the agent
loop"), expect the same fail-closed pattern, but this is **PARTIAL**, not
independently verified for those three events in this spike.)

---

## Q6 — Matcher semantics

**VERIFIED**, with one correction to the docs.

- Tool names actually seen in this spike: `run_command`, `view_file`,
  `list_dir` (the model chose `run_command` with `ls` over the dedicated
  `list_dir` tool when asked to "list files," worth knowing for anyone
  writing a matcher that assumes `list_dir` will be used).
  Full tool roster available to the session (from the `init` stream event):
  `ask_custom_permission, ask_permission, ask_question, browser_*,
  call_mcp_tool, command_status, define_subagent, delete_knowledge,
  execute_browser_javascript, find_by_name, finish, generate_image,
  grep_search, invoke_subagent, list_browser_pages, list_dir,
  list_permissions, list_resources, manage_inbox, manage_subagents,
  manage_task, multi_replace_file_content, notebook_edit,
  notebook_execution, open_browser_url, read_browser_page,
  read_resource, read_url_content, replace_file_content, run_command,
  run_workflow, schedule, search_web, sed_file, send_command_input,
  send_message, view_file, wait, wait_5_seconds, write_to_file`.
- `matcher: "view_file|list_dir"` (OR) correctly fired only for `view_file`
  calls, never for a `run_command` call in the same turn —
  `raw/09-matcher-regex/`.
- `matcher: "command"` (meant as a substring test) **did NOT match**
  `run_command` — no hook log was produced at all —
  `raw/09b-matcher-substring/` (empty). **Correction to the doc**: matching
  is full-string/anchored, not a substring/contains search.
- `matcher: "run_.*"` (prefix wildcard) **did** match `run_command` —
  `raw/09c-matcher-prefix-wildcard/PreToolUse.jsonl`. So wildcard/prefix
  regexes work as the doc's `browser_.*` example shows, but you must write a
  pattern that matches the *whole* tool name, not a keyword fragment.
- `"*"` matches everything (used throughout as the baseline matcher, worked
  for every tool observed, matches doc).
- **MCP tool matching: NOT POSSIBLE to verify in this spike** — the task
  explicitly forbids `agy mcp add`/`agy plugin install`, and no MCP server
  was configured. From the tool roster above, MCP tools are exposed to the
  model as a single generic `call_mcp_tool` wrapper, not as per-server tool
  names — which strongly suggests a `PreToolUse` matcher can only gate on
  `call_mcp_tool` as a whole (i.e., "any MCP call") and must inspect
  `toolCall.args` (not the tool name) to discriminate between individual MCP
  tools/servers. This is inferred from the tool list, not independently
  confirmed by denying a real MCP call — flag this as the first thing to
  re-verify once agy-hq's company MCP server exists.

---

## Q7 — Per-agent hook scoping; hook process env vars

**Scoping — NOT POSSIBLE with the current customization system (PARTIAL
evidence, workspace/plugin-level confirmed, no per-agent mechanism found).**
`hooks.json` is discovered the same way as `AGENTS.md`/skills: per
customization root (`.agents/`), or bundled inside a `plugins/<name>/hooks.json`
that's enabled/disabled as a whole. Neither the hooks doc, the plugin doc, nor
the JSON-configs doc (`skills.json`/`plugins.json` only — there is no
`hooks.json`-equivalent registry with per-entry scoping) expose any "apply
this hook only to agent X" field, and custom agent frontmatter
(`.agents/agents/<name>.md`) has no hooks-related key. Empirically confirmed:
a custom agent (`sdr-test`, created for this test) run via `--agent sdr-test`
still triggered the exact same workspace-level `hooks.json` handlers as the
default agent (`raw/11-per-agent-scope/`). **Practical implication for
agy-hq**: scope hooks per *role* by giving each role its own workspace
directory (as PLAN.md section 2 already does —
`workspaces/<agent>/.agents/hooks.json`) rather than trying to share one
workspace across roles and filter by agent name inside the hook.

**Env vars — VERIFIED, and smaller than expected.** Dumped `process.env` from
inside a hook process (`raw/10-env-dump/PreToolUse.env.json` etc.) and diffed
against the invoking shell's own environment. The **only** variable agy
itself injects into the hook's environment is:
- `ANTIGRAVITY_CONVERSATION_ID` (matches the `conversationId` in the stdin
  payload).

Everything else in the dump (`CLAUDE_CODE_*`, `ANTHROPIC_*`, `HOME`, `PATH`,
etc.) was just normal inherited-from-parent-shell environment — in this
spike that parent happened to be a Claude Code session, which is an artifact
of how this spike was run, not something agy provides. **Do not build on any
inherited var other than `ANTIGRAVITY_CONVERSATION_ID`** — in agy-hq's real
runner (spawning `agy` directly from Node, not from inside Claude Code), the
hook process will only reliably have `ANTIGRAVITY_CONVERSATION_ID` plus
whatever the runner itself puts in the child's env. Pass anything a hook
needs (task id, role, policy config path, audit-log endpoint) explicitly via
env vars when spawning `agy`, don't assume agy will forward it.

---

## Recommended hook design for agy-hq

Per workspace (= per role instance, e.g. `workspaces/sales-01/.agents/hooks.json`):

1. **Audit log** — `PreToolUse` (matcher `"*"`) and `PostToolUse` (matcher
   `"*"`) both append the full payload (+ a wall-clock timestamp and the
   harness's own task/thread id, passed in via env var) to the append-only
   event log described in PLAN.md section 3.3.5. Always return
   `{"decision":"allow"}` / `{}` — this hook is pure observation, never
   gates. Keep it separate from the policy-gate hook below so a bug in the
   audit sink's exit code can't accidentally block real actions (PreToolUse
   failures fail closed — see Q5 — so the audit hook must be bullet-proof:
   wrap its body in try/catch, always print *some* valid JSON, even `{}`,
   even on internal error).

2. **Policy gate** — a dedicated `PreToolUse` hook (matcher targeting
   `run_command|call_mcp_tool|...` — whatever can reach the outside world)
   that:
   - `deny`s anything matching a hard-blocked pattern (money movement,
     sending email/messages, anything PLAN.md section 3.4 calls "always
     needs human approval"), with a `reason` that becomes the audit trail
     entry and the text the agent sees.
   - For "needs approval but not hard-blocked" actions: **don't use agy's
     `ask`/`force_ask`** (Q2 — it's unreliable headless). Instead, `deny`
     immediately with a reason like "queued for human approval", and have
     the *harness* (not the hook, since hooks are synchronous/blocking —
     "hooks run synchronously and block the agent loop," confirmed) create
     an Outbox draft / approval-inbox row out of band. The task re-runs (new
     `agy` invocation, same `--conversation`) once a human approves, at
     which point the policy gate's pattern no longer matches (e.g. an
     approval-id allowlist file the hook checks) and it `allow`s.
   - Given PreToolUse's confirmed fail-closed behavior on hook crash/timeout
     (Q5), run the policy gate hook with a short, generous timeout and make
     its default (anything it can't classify, or if it errors) explicitly
     `deny` — i.e., design the hook body itself so "I don't know" also
     denies, not just rely on agy's crash-path fail-closed as the safety
     net.

3. **Context injection** — `PreInvocation` reads the harness's per-entity
   notes / role KB (PLAN.md section 3.2) for the current `conversationId` ->
   thread mapping and returns `injectSteps: [{ephemeralMessage: ...}]`
   (confirmed working, Q3). Keep it small (summary, not full KB dump) since
   this runs on *every* model invocation in the loop, not just once.

4. **Checkpoint** — `Stop` hook reads `transcriptPath` (confirmed readable
   and complete at Stop, Q4), extracts/persists a task-state-machine update
   (PLAN.md section 3.3.2) and a conversation summary (section 3.3.3), then
   decides: `{}` to really stop, or `{"decision":"continue","reason":...}`
   if the harness's own criteria for "done" aren't met yet (e.g. required
   structured-output field still missing). This is the natural checkpoint
   point — don't try to checkpoint from `PostInvocation` instead, since
   `Stop` is specifically "the loop is about to end" and is the only hook
   that can veto that.

**Fail-open vs fail-closed summary**: PreToolUse is fail-closed by
construction (crash/timeout/bad-output all block the action) — good, this is
what outbound actions need. PostToolUse is inherently fail-open for the
action itself (it already happened) and should only ever be used for
logging/cleanup, never as a safety boundary. `--dangerously-skip-permissions`
does not weaken `deny` but does neuter `ask`/`force_ask` into an automatic
allow — agy-hq's runner, which will need `--dangerously-skip-permissions` for
any unattended run, must therefore implement its own approval queue in the
policy-gate hook rather than leaning on agy's built-in "ask."
