# agy-hq — an AI staff harness built on Antigravity CLI (`agy`)

Goal: run the non-engineering roles of a small company (Sales, Account/Customer
Success, Accounting, Marketing) as long-lived AI "employees" on top of `agy`,
with humans approving anything risky.

Status: brainstorm / plan v0 — 2026-10-01

Decisions: "Account" = Account Management / Customer Success (not accounting) ·
first role = **Sales SDR** · language = **TypeScript**.

---

## 1. What `agy` already gives us (verified on agy 1.2.14 — see PHASE0.md)

| Need | `agy` primitive | How we use it |
|---|---|---|
| Run an agent from code | `agy -p --output-format stream-json --input-format stream-json` | The harness runs `agy` headless and parses NDJSON events |
| Persona per employee | Custom agents: `.agents/agents/<name>.md` (YAML: `name`, `description`, `tools`, `mainAgent`, `subagent`, …) + `--agent <name>` | One agent file per role |
| Per-agent context isolation | `.agents/` + `AGENTS.md` are found by walking up from the **cwd** | Each employee gets its **own workspace directory** with its own rules, skills, hooks, MCP config |
| Continuity | `--conversation <id>`, `--continue`, `--project` | Map an external thread (email thread, deal) to an agy conversation |
| Structured results | `--json-schema` | Force a typed result per task (e.g. `{status, summary, actions[]}`) |
| Business tools | MCP (`agy mcp add`, per-workspace `mcp_config.json`) | A "company MCP" server exposes CRM, KB, memory, inbox, outbox |
| Guardrails / audit | `hooks.json`: `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop` (JSON on stdin/stdout) | Policy gate, audit log, state checkpoint on Stop |
| Procedures (SOPs) | Skills `skills/<name>/SKILL.md` (progressive disclosure) | "How to qualify a lead", "How to chase an overdue invoice" |
| Background / cron | Sidecars (`~/.gemini/config/sidecars/*/sidecar.json`, `builtin: schedule`, `agentapi new-conversation`) | Optional; we probably run our own scheduler for control |
| In-task delegation | `invoke_subagent` (research, browser, custom) | Agents can fan out research *inside* one task |
| Packaging | Plugins (skills + agents + rules + MCP + hooks) | Ship each role as a plugin: `sales-pack`, `accounting-pack` |
| Programmatic alternative | Python SDK `google-antigravity` (`Agent`, policies, hooks, structured output) | Fallback runner if the CLI is too limiting |

Key insight: **agy is the "brain + hands" for one task. Everything that must
survive across tasks — who the employees are, what they know, the state of the
business, what comes in and goes out — lives in the harness, not in agy.**

---

## 2. Architecture

```
            ┌──────────────── Inbound ────────────────┐
  Email · Web forms · Chat (Slack/Telegram/Zalo) · Webhooks (Stripe, CRM) · Cron
            └──────────────────┬──────────────────────┘
                               ▼  normalize → Event
┌──────────────────────── agy-hq (control plane) ─────────────────────────┐
│  Router ──► Task queue ──► Scheduler/Workers ──► Runner (spawns agy)    │
│     │            │                                   │                  │
│  Agent registry  State DB (business + tasks)   Audit log / costs        │
│  Approval inbox  Knowledge index (FTS + vectors)                        │
└───────┬───────────────────────────────┬─────────────────────────────────┘
        │ HTTP API                       │ spawns per task, cwd = workspace
        ▼                                ▼
   agy-ui (web)          workspaces/<agent>/  ── agy -p --agent <role> …
   dashboard, approvals,      AGENTS.md, .agents/{agents,skills,hooks.json},
   KB editor, org chart       mcp_config.json → company MCP
                                        │
                                        ▼
                         company MCP server (tools the agents call)
                         kb_* · memory_* · crm_* · task_* · inbox_* · outbox_*
                                        │
            ┌──────────────── Outbound (gated) ───────┐
            ▼                                          ▼
     Outbox: policy → approval → rate limit → send (email, chat, social, CRM, invoices)
```

Components:

1. **Control plane daemon** — owns the queue, state, scheduling, and the only
   path to the outside world.
2. **Runner** — wraps `agy` behind an interface (`run(agent, task) → result`),
   so we can swap to the Python SDK later.
3. **Company MCP server** — the agents' only window into business data and
   outbound actions. Agents never get raw SMTP/API credentials.
4. **Workspaces** — one directory per employee, generated from role templates.
5. **agy-ui** — web console for humans (this repo).

---

## 3. Feature areas

### 3.1 Multiple agents management

- **Agent registry**: id, role, display name, model (`gemini-3.x`, `claude-*`),
  effort, tool allowlist, MCP scopes, budget, schedule, status
  (active / paused / shadow), manager.
- **Role templates → workspaces**: `templates/sales-sdr/` renders into
  `workspaces/sales-01/` (AGENTS.md persona, skills, hooks, mcp_config).
  Editing a template can re-render all agents of that role.
- **Org chart & routing**: a lightweight **Chief-of-Staff agent** triages
  ambiguous inbound events and delegates; deterministic rules handle the
  obvious ones (invoice email → accounting) without spending a model call.
- **Inter-agent handoff**: via the task queue (`task_create(assignee="am-01",
  …)`), not via agy subagents. Subagents stay for in-task research only.
- **Concurrency**: N worker slots globally, per-agent limit, and a **per-thread
  lock** (two tasks for the same customer never run at once).
- **Trust levels** per agent and per action type:
  `shadow` (draft only, nothing sent) → `assisted` (human approves) →
  `autonomous` (within limits). Promotion based on measured approval rate.
- **Budgets & quotas**: track tokens/credits per agent and task; pause on
  overspend. agy model quotas (`/usage`) are a real ceiling — see risks.
- **Observability**: live task view (stream-json events), transcripts, tool
  calls, cost, success/failure, per-agent KPIs.

### 3.2 Knowledge base — per agent

Three layers, all plain Markdown in git so humans can edit and review:

| Layer | Scope | Examples |
|---|---|---|
| Company KB | shared, read-only for agents | products, pricing, policies, brand voice, FAQ, org info |
| Role KB | per role | sales playbook, objection handling, ICP; chart of accounts, tax rules; content calendar, SEO guide |
| Agent memory | per agent, agent-writable | learned preferences, "customer X prefers Vietnamese", what worked |

Plus **entity notes** (per contact / company / deal) stored with the record in
the state DB, so any agent touching that customer sees them.

- Retrieval: `kb_search(query, scopes)` MCP tool over SQLite FTS5 + embeddings
  (sqlite-vec) — hybrid search, returns cited snippets.
- Stable SOPs go in **skills** (loaded on demand); always-true rules go in
  `AGENTS.md`; facts go in the KB. Don't stuff everything into the prompt.
- **Memory writes are reviewed**: agent proposes `memory_write`, harness
  dedupes, and humans can see/revert in the UI. Prevents memory poisoning
  from inbound content.
- Ingestion: upload PDFs/docs/URLs → chunk → index; re-index on file change.

### 3.3 State management

Separate the layers; the LLM is never the source of truth.

1. **Business state** (SQLite → Postgres): contacts, companies, deals/pipeline,
   conversations/threads, invoices, payments, campaigns, content items,
   tickets. Agents read/write only through typed MCP tools with validation.
2. **Task state machine**:
   `queued → running → waiting_approval | waiting_external → done | failed | cancelled`,
   with retries, timeouts (`--print-timeout`), idempotency keys, and a
   `wake_at` for follow-ups ("chase again in 3 days").
3. **Conversation state**: map `(agent, thread)` → agy `conversationId`.
   Prefer **short task-scoped conversations + a written summary** over one
   endless conversation; resume with `--conversation` only within a thread.
4. **Agent memory**: see 3.2.
5. **Event log / audit**: append-only record of every inbound event, tool call
   (via `PostToolUse` hook), outbound action, approval, and state change.
   Enables replay, debugging, and "why did the agent do this?".

### 3.4 Inbound / Outbound

**Inbound** — connectors normalize everything into one `Event`
(`source, channel, thread_id, sender, body, attachments, raw`):

- Email (Gmail API / IMAP), web forms & webhooks, chat (Slack, Telegram,
  Zalo OA, WhatsApp), calendar, payment/CRM webhooks, scheduled triggers.
- Pipeline: dedupe → identify contact/thread → classify → route → create task.
- Inbound text is **untrusted** (prompt injection): tag it as data in the
  prompt, never let it change policy, and keep high-risk tools behind approval.

**Outbound** — a single **Outbox** with a fail-closed gate:

- Agents call `outbox_send(channel, to, content, reason)` → creates a draft.
- Policy per action type: `auto` / `approve` / `block`, plus rate limits,
  recipient allowlists, quiet hours, disclosure footer, unsubscribe handling.
- Hard rules: money movement, contracts, refunds, price changes, and anything
  to a new recipient domain need human approval at every trust level.
- Kill switch: one toggle stops all outbound; auto-trip on complaint/bounce/
  negative-reply rate (same idea as nkseed's `publish_gate` and kill metric).
- Channels: email (SMTP/Gmail), chat replies, social posts, CRM updates,
  invoice issuing, document generation (proposals, reports).

---

## 4. Additional features worth planning for

- **Human approval inbox** (the core UX of agy-ui): diff-style review, edit
  then approve, reject with feedback that becomes agent memory.
- **Scheduling**: recurring routines per role (daily pipeline review, weekly
  marketing report, month-end close checklist).
- **Evaluation**: golden test sets per role (sample inbound → expected
  action), run before promoting a template change.
- **KPIs per role**: reply rate, meetings booked, DSO (days sales
  outstanding), content shipped, approval/edit rate.
- **Secrets**: per-connector credentials in the harness only; agents get
  scoped MCP tools, never tokens.
- **Multi-language**: per-contact language preference (vi/en).

---

## 5. Role catalogue (first cut)

| Role | Core jobs | Risky actions (always gated early) |
|---|---|---|
| Sales SDR | lead research, personalized outreach, follow-ups, qualify, book meetings, CRM hygiene | cold email sending, discounts |
| Account manager / CS | onboarding, answer customer questions from KB, renewals, upsell signals, tier-1 support | refunds, commitments, SLA promises |
| Marketer | content calendar, blog/social/newsletter drafts, SEO briefs, campaign reports | publishing, ad spend |
| Chief of Staff | triage, delegation, daily digest to the owner | none (internal only) |

Rule: numbers (prices, discounts, renewal amounts) come from tools, never
from the model's head.

---

## 6. Phased plan

**Phase 0 — Spike** ✅ done 2026-10-01 — see [PHASE0.md](PHASE0.md)
- [x] stream-json event schema, multi-turn stdin input, `--json-schema`, resume, timeouts.
- [x] Custom agents, rules, skills, workspace isolation, workspace MCP, local plugins.
- [x] All 5 hooks headless; `PreToolUse` fail-closed gate; `PreInvocation` context injection.
- [x] 1/3/5 parallel runs (0% failures, ~7s overhead); `/usage` quota JSON.
- [x] Python SDK assessed → CLI runner chosen (SDK needs separate API key/billing).

**Phase 1 — Core harness** ✅ done 2026-10-01 — real e2e: research → first-touch draft (pending approval) → follow-up scheduled
- Agent registry + role templates → workspace generator (layout: PHASE0 D6).
- Runner (agy CLI, contract: PHASE0 D2), task queue + state machine, SQLite
  state DB, audit log, quota poller (`/usage`).
- Hook package: `PreToolUse` policy gate, audit, context injection, Stop
  checkpoint (PHASE0 D5).
- Company MCP: `kb_*`, `memory_*`, `task_*`, `state_*`.
- CLI: `hq agent create|list|pause`, `hq task run`.

**Phase 2 — I/O + human loop** ✅ built 2026-10-01 — maildir e2e verified (reply → handle_reply draft → approve → sent with threading/footer); real IMAP/SMTP not yet tested
- Inbound: email + webhook connectors, router.
- Outbox with policy gate, approval inbox, kill switch.
- agy-ui v1: agents, tasks (live stream), approvals, KB editor.

**Phase 3 — First role end-to-end in shadow mode** — tooling ✅ built 2026-10-01 (readiness gate + setup, draft lint, scorecards/promotion, routines, SDR eval suite: baseline 7/7 on gemini-3.8-flash-medium); the 2-week shadow run itself needs a real mailbox + company profile
- Sales SDR, real inbox, nothing auto-sent.
- Measure edit/approve rate for 2 weeks, then promote to `assisted`.

**Phase 4 — More roles + coordination** ✅ built 2026-10-03 — see [PHASE4.md](PHASE4.md): Account Manager + Chief of Staff roles, SDR→AM handoff, role-aware routing, account_review / daily_digest routines, briefings, per-role KPIs; real-agy evals AM 8/8, CoS 6/6 (SLA-bait case occasionally flaky). Marketer deferred (needs publishing channels).
- Remaining roles, Chief-of-Staff triage, handoffs, recurring routines,
  per-role KPIs, evals.

**Phase 5 — Hardening**
- Postgres, multi-tenant (several companies), packaging roles as agy plugins.

**Known issues (fix later)** — found by the Phase 4 real-agy eval runs, 2026-10-03
- [ ] SDR evals 6/8 (pre-existing, also fail before Phase 4):
  `research-out-of-icp-answers-question` drafts "Re: …" with no prior thread →
  refused by `deceptive_subject` lint; `first-touch-good-fit` about half the
  runs proposes a fixed "15-minute call, I'm free Tuesday" CTA.
- [ ] Duplicate drafts: `outbox_draft_email` stores a draft that has only lint
  warnings, the agent sees the warning and drafts again → two drafts in the
  approval queue. Fixed in the AM template only; SDR still exposed. Better fix
  is server-side (e.g. one pending draft per task/thread, or return warnings
  without storing).
- [ ] AM lint false positive: `quality/am-lint.ts` scans the subject, so
  "Re: <customer subject containing refund / uptime guarantee>" is refused.
  Lint only text the agent wrote, not the echoed subject. (The AM template
  works around it with neutral subjects; `message-sla-uptime-bait` is still
  occasionally flaky.)
- [ ] Small API gaps the UI works around: `GET /v1/admin/audit` has no
  `contactId` filter; `GET /v1/admin/contacts` has no stage filter (UI filters
  the latest 200 client-side).
- [ ] Eval runs against real agy have no npm script / CLI entry for non-SDR
  suites; `draft.lintErrors` only supports `equals` (no `max`).

---

## 7. Risks & open questions

- **Quotas / terms**: agy runs on Google account quotas ("AI credits"). A 24/7
  multi-agent workload may hit limits or fall outside intended use. Keep the
  runner swappable (SDK, or another CLI).
- **agy's own permissions are effectively off** (MCP needs
  `--dangerously-skip-permissions`; `tools:` doesn't gate MCP). Mitigated by
  the layered security model in PHASE0 D3.
- **Headless sharp edges**: timeouts and denied tools both report `SUCCESS`;
  global `~/.gemini/config` bleeds into every workspace → dedicated OS user.
  See PHASE0 §2.
- **agy auto-updates** — record version per run, re-test before upgrades.
- **Prompt injection via inbound** content → strict outbound gating.
- **Legal**: anti-spam rules for outreach, AI disclosure, data privacy.
