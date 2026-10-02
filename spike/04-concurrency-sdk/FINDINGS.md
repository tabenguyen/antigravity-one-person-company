# Spike 04 — Concurrency, quota & Python SDK

(Written by the orchestrator from the spike agent's final report; raw data in
`results.json`, `runs/`, `sdk/`.)

Environment: `agy` **v1.2.14** (auto-updated from 1.1.19 during the spike),
Node 20.20.2, Python 3.14.7. Spikes 01–03 were running agy concurrently during
measurement. 19 agy invocations total.

## A. CLI concurrency / latency / quota

**1–2. Parallel runs, collisions — VERIFIED**

| N | wall p50 | wall p95 | failure rate | unique conv. IDs |
|---|---|---|---|---|
| 1 | 7.0s | 7.0s | 0% | 1/1 |
| 3 | 6.6s | 6.8s | 0% | 3/3 |
| 5 | 6.8s | 11.1s | 0% | 5/5 |

- No conversation-ID collisions, no lock contention, no rate-limit errors in
  `~/.gemini/antigravity-cli/log/`. Each run gets its own `presence/<id>.lock`.
- N=5 had one straggler (11.1s). Only one sample per N — re-measure before
  sizing the worker pool.
- `--output-format json` emits one blob at EOF; use `stream-json` for real
  time-to-first-token.

**3. Quota visibility — VERIFIED**
- `agy -p "/usage" --output-format json` → structured JSON per model group
  (`Gemini Models`, `Claude and GPT models`): weekly + 5-hour buckets with
  `remaining_fraction` and `reset_time`. Zero tokens consumed — cheap to poll.
- `agy -p "/credits" --output-format json` → `{"remaining_credits":0,...}`
  (this account is quota-based).
- Spike consumption: Gemini weekly 62% → 61%, 5h 63% → 62%.
- Normal turns include a per-turn `usage` object for cost accounting.

**4. Cross-model & cold start — VERIFIED**
- `gemini-3.8-flash-low` and `claude-sonnet-4-6` in parallel: 7.1s / 8.6s, no
  interference.
- "Cold" start 7.7s ≈ warm 7.0s → ~7s fixed overhead per `agy -p` call.
  True cold start (fresh machine) not measured.

## B. Python SDK `google-antigravity` (0.1.20)

**5. Auth / runtime — VERIFIED**
- Installs on Python 3.14 in a local venv.
- Does **not** spawn `agy`; ships its own 118MB Go binary
  (`google/antigravity/bin/localharness`), protobuf over stdio.
- Does **not** reuse the CLI's Google login. Requires `GEMINI_API_KEY` or
  Vertex AI (ADC). State dir `~/.gemini/antigravity/`. → separate billing
  and quota from the CLI.
- Live chat call: **NOT TESTED** (no API key; Vertex billing not authorized).

**6. Feature surface — PARTIAL (construction-level only)**
All construct correctly (`sdk/02_feature_surface_construction_only.py`):
system instructions (`CustomSystemInstructions(text=)`,
`TemplatedSystemInstructions`), Python tools, policies
(`deny/allow/ask_user`; specific-deny > specific-ask > specific-allow >
wildcard-deny > wildcard-ask > wildcard-allow), structured output
(`response_schema`), hooks (`on_session_start/end`, `pre/post_tool_call`,
`pre/post_turn`, `on_tool_error`, `on_interaction`, `on_compaction`, `stop` —
a superset of CLI hooks), MCP (stdio / streamable HTTP), subagents.
Gotchas: `SystemInstructions` is a Union (not constructible); hook functions
must name their parameter `context`.

**7. Recommendation — spawn the `agy` CLI from Node for Phases 1–3.**
Reuses the authenticated consumer quota, stays in TypeScript, and uses every
CLI primitive the plan relies on. Switch the runner to the SDK (Python
sidecar, API key or Vertex billing) only if consumer quota becomes the
limiting factor.

## Follow-ups
- More samples per N before sizing concurrency.
- Get a `GEMINI_API_KEY` (or explicit OK for Vertex billing) to test the SDK
  live.
