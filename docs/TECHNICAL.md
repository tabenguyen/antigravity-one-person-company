# Technical reference (agy-hq internals)

A TypeScript harness that runs AI business agents (first role: **Sales SDR**)
by driving Google's [Antigravity CLI](https://antigravity.google) (`agy`)
headlessly. agy-hq keeps a task queue, renders an isolated workspace per
agent, spawns `agy` per task, and records every result, tool call, and
approval in SQLite.

See [`docs/PLAN.md`](PLAN.md) and [`docs/PHASE0.md`](PHASE0.md) for
the full design and the spike findings it's built on.

## Prerequisites

- Node 20+
- The `agy` CLI installed and logged in (`agy --version` should print
  something like `1.2.14`). agy-hq shells out to it — see
  [`docs/PHASE0.md`](PHASE0.md) for the invocation contract and its
  sharp edges.

## Install & build

```sh
npm install
npm run build     # builds @agyhq/hooks and @agyhq/mcp into dist/ — the
                   # daemon refuses to start without these (clear error if missing)
npm run typecheck
npm test
```

## Configure

Copy the example config and edit it (every field is optional — see
`packages/server/src/config.ts` for defaults):

```sh
cp agyhq.config.example.json agyhq.config.json
```

At minimum you'll want to set `companyName`. Everything else — `dataDir`
(SQLite db + rendered workspaces), `host`/`port`, `templatesRoot`, `kbRoot`,
worker concurrency, timeouts, quota throttle thresholds — has a sensible
default. The admin API's bearer token is auto-generated on first run and
persisted to `<dataDir>/admin-token` (mode `600`) unless you set
`AGYHQ_ADMIN_TOKEN` or `adminToken` in the config file.

### Configure email (Phase 2)

Outbound is **disabled by default** (`outboundEnabled: false` — a human must
turn it on, see "Kill switch" below) and sending is only possible once
`email.kind` is something other than `"none"`. Three provider kinds
(`packages/channels`, falling back to a local equivalent if that package
isn't built yet):

```jsonc
// agyhq.config.json
{
  "email": { "kind": "none" },        // default: inbound/outbound both off

  // local dev / the real e2e test:
  "email": { "kind": "maildir", "root": "./data/maildir", "address": "sdr@yourcompany.com" },

  // a real mailbox:
  "email": {
    "kind": "imap-smtp",
    "address": "sdr@yourcompany.com",
    "imap": { "host": "imap.yourmail.com", "port": 993, "secure": true, "user": "sdr@yourcompany.com", "pass": "" },
    "smtp": { "host": "smtp.yourmail.com", "port": 465, "secure": true, "user": "sdr@yourcompany.com", "pass": "" },
    "sentFolder": "Sent"              // omit/null if your provider (e.g. Gmail) already saves sent mail
  },

  "sender": { "name": "Your Company Sales", "address": "sdr@yourcompany.com", "companyAddressLine": "Your Company, 123 Main St" },
  "unsubscribeMailto": "unsubscribe@yourcompany.com",
  "webhooks": { "typeform": { "secret": "change-me" } }
}
```

Real-mailbox specifics (read-only access, first-sync policy `initialSyncDays`, opt-in Sent-folder sync `syncSent`,
`hq email doctor`, provider notes in Vietnamese): [`docs/EMAIL-SETUP.md`](EMAIL-SETUP.md).

For `imap-smtp`, **don't put real passwords in the config file** — set
`AGYHQ_IMAP_PASS` / `AGYHQ_SMTP_PASS` env vars instead; they override
whatever `imap.pass` / `smtp.pass` the file has.

`sender.companyAddressLine` and `unsubscribeMailto` are appended as a footer
to any outgoing email that doesn't already contain the address line (CAN-SPAM
-style disclosure + a `List-Unsubscribe` header). Inbound web-form leads come
in via `POST /v1/inbound/webhook/<source>` with header
`x-agyhq-webhook-secret: <webhooks[source].secret>` — see
`packages/server/src/admin-types.ts` for the body shape
(`WebhookLeadRequestZ`).

## Run the daemon

```sh
npm run hq -- serve
```

This opens the SQLite db, re-renders every agent's workspace, syncs the
knowledge base, starts the scheduler and quota poller, and serves the admin
API + agent-facing API (hooks/MCP) on `http://127.0.0.1:7317`.

## Use the CLI (`hq`)

In another terminal (talks to the running daemon over HTTP):

```sh
# Provision a Sales SDR agent from templates/sales-sdr/
npm run hq -- agent create sdr-01 --role sales-sdr --display-name Mai

npm run hq -- agent list
npm run hq -- agent show sdr-01

# Pull in company/role/agent knowledge-base markdown
npm run hq -- kb sync
npm run hq -- kb search --query "pricing" --scopes company,role:sales-sdr

# Add a lead and kick off work
npm run hq -- contact add --email jane@acme.com --name "Jane Doe" --company-name Acme
npm run hq -- task create --agent sdr-01 --kind sdr.research_lead --title "Research Acme" \
  --input '{"contactName":"Jane Doe","contactEmail":"jane@acme.com","leadCompanyName":"Acme","leadCompanyDomain":"acme.com","context":"inbound demo request"}' \
  --thread-key contact:jane@acme.com

npm run hq -- task list
npm run hq -- task watch <task-id>    # tails live events until it settles

# Review what the agent drafted before anything goes out
npm run hq -- outbox list
npm run hq -- outbox approve <outbox-id>

# Review/accept learned preferences before the agent relies on them
npm run hq -- memory list
npm run hq -- memory accept <memory-id>

npm run hq -- quota

# Phase 2: inbound review, settings, kill switch, daemon health
npm run hq -- inbound list
npm run hq -- inbound show <inbound-id>
npm run hq -- settings show
npm run hq -- settings set sendRatePerHour 10
npm run hq -- killswitch on                 # outboundEnabled = true — a human must opt in
npm run hq -- killswitch off --reason "investigating bounce spike"
npm run hq -- status                        # email provider health, quiet hours, quota throttle, running tasks

# Edit a drafted reply before approving it, or reject with feedback the agent
# will remember (rejection reasons become accepted agent memory)
npm run hq -- outbox edit <outbox-id> --body "revised wording"
npm run hq -- outbox approve <outbox-id> --reviewer alice
npm run hq -- outbox reject <outbox-id> --reason "too pushy" --reviewer alice
npm run hq -- outbox retry <outbox-id>      # failed -> approved
```

Every command group also takes `--help` (e.g. `hq outbox --help`).

Every command accepts `--json` for scriptable output, and `--config
<path>` / `--url <url>` / `--token <token>` to point at a different daemon
(`AGYHQ_CONFIG`, `AGYHQ_ADMIN_TOKEN` env vars work too).

`hq agent create` validates the id, loads the role's
`templates/<role>/template.json`, and renders
`<dataDir>/workspaces/<id>/` (`AGENTS.md`, `.agents/{agents,rules,skills,
hooks.json,mcp_config.json}`) — see `packages/workspace/README.md` for the
template format. `hq agent rerender` (or the admin API's rerender-all, run
automatically at daemon startup) re-renders a workspace after a template
edit without touching agent-instance state.

## Phase 1 scope

- Agents run through a state machine (`queued → running → waiting_approval |
  waiting_external → done | failed | cancelled`) with retries, exponential
  backoff, and per-thread mutual exclusion — see `packages/server/src/
  orchestrator.ts`.
- Every tool call an agent makes is policy-checked and audited by the
  agent-facing API (`packages/server/src/agent-api/`) before it reaches
  `@agyhq/db`.
- Outbound email is **draft-only**: `outbox_draft_email` creates a
  `pending_approval` row; a human approves or rejects it via `hq outbox` or
  the admin API. Sending it is Phase 2.
- A quota poller throttles to high-priority (inbound-reply) tasks when `agy`
  reports a model-group quota bucket below the configured floor.

## Phase 2 scope

- **Inbound**: an email poller (`packages/server/src/inbound.ts`) and a
  webhook endpoint (`POST /v1/inbound/webhook/:source`) normalize into one
  `InboundEvent`, deduped by Message-ID / `(source, externalId)`. Routing is
  **deterministic** (no model call on this path): `unsubscribe` opts the
  contact out, cancels queued thread tasks, and rejects pending/approved
  outbox items to them; `bounce` marks the contact `emailBounced` +
  `doNotContact` and annotates the sent item; `auto_reply`/`spam` are
  ignored; a `reply` on a known thread becomes a priority-10
  `sdr.handle_reply` task for the contact's owning (or default) agent, with a
  deterministic thread-history summary; an unknown sender becomes a
  `sdr.research_lead` task (or stays `received` with a reason if no default
  SDR agent is configured).
- **Outbox policy**: autonomous-tier agents auto-approve
  (`policy:autonomous`) once `settings.autonomousRequiresPriorApproval` is
  off or the recipient already got one human-approved send; a human
  "approving" a **shadow**-tier agent's draft parks it in `held` — never
  sent, and that's terminal so promoting the agent later can't release old
  practice drafts. Rejection reasons become an accepted agent memory
  (`"Human rejected your draft to <to>: <reason>"`).
- **Sender** (`packages/server/src/sender.ts`): a background loop that only
  sends when `settings.outboundEnabled`, outside `settings.quietHours`, and
  under `settings.sendRatePerHour` — plus a final guard right before the
  network call (opt-out/bounce/archived-agent can't slip through between
  approval and send). Composes `In-Reply-To`/`References` from the latest
  inbound message on the thread, a disclosure + `List-Unsubscribe` footer,
  and retries transient failures (backoff) before giving up. Auto-trips the
  kill switch if the bounce rate over the last `settings.autoTrip.windowSize`
  sends exceeds `settings.autoTrip.maxBounceRate`. Crash-safe: anything left
  `sending` at startup is recovered back to `approved`.
- **Admin API additions**: outbox edit/approve/reject/retry, inbound
  list/get, settings get/patch, `/v1/admin/killswitch`, `/v1/admin/status`
  (email health, cached `verify()`), `/v1/admin/stats`, a contact detail
  timeline, a task transcript viewer (parses the agy
  `transcript_full.jsonl` the `hook.stop` audit row points at), and KB
  document/file editing (path-traversal-safe) — see the "Phase 2 additions"
  contract at the end of `packages/server/src/admin-types.ts`. The built
  `agy-ui` (if present at `config.uiDist`) is served at `/`, SPA-fallback
  style, and never shadows `/v1/*`.

## Phase 4 scope (roles + coordination)

Contract and definitions: [`docs/PHASE4.md`](PHASE4.md). Summary of what the daemon does:

- **Roles**: `sales-sdr`, `account-manager`, `chief-of-staff` all provision from
  `templates/<role>/`. A template's optional `routing { replyKind, followUpKinds }`
  tells the inbound router which task kind answers a reply for that role.
- **Inbound routing** (`inbound.ts`, `routing.ts`): a reply goes to the contact's
  owner using the *owner's role* reply kind; a `customer` is never downgraded to
  `replied`; a `new_lead` from a known customer is a reply to its owner; `other`
  and unroutable mail go to the default Chief of Staff as `cos.triage` (with a
  roster of active agents and their task kinds) when `defaultCosAgentId` is set.
- **Handoff** (`handoff.ts`): MCP tool `contact_handoff({contactId, toRole, summary})`
  and `POST /v1/admin/contacts/:id/handoff {toRole?, summary?}` move a won contact
  to `settings.defaultAmAgentId` in one transaction (owner, stage `customer`, note,
  cancel the previous owner's follow-ups on the thread, `am.onboard` task, audit
  `contact.handoff`).
- **Routines**: `account_review` (AM) and `daily_digest` (CoS) join `prospecting`,
  `pipeline_review`, `custom_task` (`hq routine create --kind ...`). A finished
  `cos.daily_digest` with `data.digestMarkdown` is stored as a Briefing.
- **Admin API**: `GET /v1/admin/kpis?days=N` (per-role KPIs, nulls where there is no
  data), `GET /v1/admin/briefings[?limit=&agentId=]`, `GET /v1/admin/briefings/:id`,
  `POST /v1/admin/contacts/:id/handoff`, and `PATCH /v1/admin/settings` now takes
  `defaultAmAgentId` / `defaultCosAgentId`. Types: "Phase 4 additions" in
  `packages/server/src/admin-types.ts`. SSE adds `contact.handoff`, `briefing.created`.
- **Quality**: AM drafts are linted for promises (refund, discount, credit, SLA, delivery
  dates, contract changes; vi + en). Eval suites exist per role
  (`templates/<role>/evals/`, `hq eval run --suite <role>`).
- **UI** (`packages/ui`): role picker in New agent; default AM / CoS in Settings; contact page with owner, stage badge, "Hand off to Account Manager" and handoff history (`contact.handoff` audit rows, notes as fallback); Briefings page (`/briefings`); per-role KPI cards on the Dashboard (7/30 days, `—` for null rates); `account_review` / `daily_digest` in the routine form; structured `cos.triage` decision / `am.*` notes on the task page.
- **CLI**: `hq kpis [--days n]`, `hq briefings [list|show <id>]`,
  `hq contact handoff <id> [--summary ...]`, `hq routine create --kind account_review|daily_digest`.

## Shadow run (evaluation period)

Runbook for the human: [`docs/SHADOW-RUN.md`](SHADOW-RUN.md). A shadow run is a stored window (`shadow_runs`: `startedAt`, `plannedDays`
default 14, `agentIds`, `notes`, `endedAt`; one active at a time) over shadow-tier agents. Everything else is computed on read
(`packages/server/src/shadow.ts`) from outbox/audit, reusing `quality/scorecard.ts` (`computeScorecardWindow`, `checkCriteria`) so the verdict
can never disagree with promotion eligibility.

- **API**: `GET /v1/admin/shadow` (active status, last finished status, history, agents a run could cover), `GET /v1/admin/shadow/:id`,
  `POST /v1/admin/shadow {plannedDays?, agentIds?, notes?}` (400 for a non-shadow agent or none to evaluate, 409 if one is active),
  `POST /v1/admin/shadow/:id/end {notes?}`. Audit `shadow.started` / `shadow.ended`, SSE `shadow.updated`. Types: "Shadow run" block in `admin-types.ts`.
- **CLI**: `hq shadow start [--days n] [--agents a,b] [--notes t]`, `hq shadow status [--id] [--daily]`, `hq shadow end [--id] [--notes]`, `hq shadow list`.
  `hq outbox reject` now takes `--category` (reason optional when a category is given).
- **Status**: day N of M (`day` can exceed `plannedDays`; `complete` = planned length reached), per agent: drafts, approved unchanged / with edits
  (edited = body ratio > 0 or subject changed; median edit ratio of the edited ones, plus the scorecard's median over all approved), rejected by
  category, lint errors, needs-human escalations (transitions into `waiting_approval`), median review time, waiting drafts, per-criterion progress,
  and a daily trend (drafts by creation day; decisions by decision day). Nulls where there is no data.
- **Verdict** (`shadowVerdict`): `below_bar` = compliance rejections over the limit (any volume) or, once at least `min(minDecided, 10)` drafts are
  decided, approval rate / median edit ratio failing (lint rate once that many drafts exist); `not_enough_data` = too few decisions to judge, or quality
  fine but the decision pace will not reach `minDecided` by the planned end; `on_track` otherwise. Every verdict carries a one-line reason with the numbers.
- **Digest**: `DigestSnapshot.shadowRun` (null without an active run) carries day / plannedDays, the period's approve / edit / reject counts,
  pending drafts, the oldest unreviewed draft, `pilingUp` (>= 10 pending or oldest >= 24h), every agent's verdict and `agentsBelowBar`. The Chief of
  Staff's digest skill puts a piled-up backlog into "needs you today" (case `07-daily-digest-shadow-run-backlog`).
- **UI**: Dashboard card, `/shadow` page (start / end with confirm dialogs, per-agent breakdown, daily trend), Inbox banner while a run is active.

## Setup wizard (backend)

The Setup page lets a non-technical owner go from "a domain" to a live SDR without editing config files or restarting
the daemon. Contract: the "Setup wizard" block at the end of `packages/server/src/admin-types.ts`; code:
`packages/server/src/admin-setup-wizard.ts` + `packages/server/src/setup/`.

1. **Research a domain with agy** — `POST /v1/admin/setup/generate {domain, extraUrls?, notes?, model?, language?}`
   starts an async job (one at a time, 409 otherwise; `GET /v1/admin/setup/generate[/:id]`, `POST .../:id/cancel`;
   SSE `setup.job.updated` / `setup.job.progress`; last 20 jobs in kv `setup_jobs`; a job left running by a dead
   daemon becomes `failed: daemon restarted`). A dedicated **company-researcher** agent runs in
   `<dataDir>/setup-workspace/` (re-rendered per job) with `--json-schema`: it reads the site (~15 pages + any extra
   URLs), and returns the company profile, three role KB files (`icp.md`, `sales-playbook.md`,
   `objection-handling.md`), a suggested sender, `sources`, `conflicts` (e.g. two different price lists) and
   `openQuestions`. Facts come only from pages read. The result is validated (company profile schema, placeholder
   scan, KB completeness); on failure ONE repair turn resumes the same conversation with the exact errors, then the
   job fails with a clear message. **Nothing is saved** until the human applies it via `PUT /setup/company` and
   `PUT /setup/role-kb`. Model: request `model`, else config `setupModel` / `AGYHQ_SETUP_MODEL`, else the sales-sdr
   template's `defaultModel`.
   *Security:* the researcher reads untrusted web pages, so its workspace has no MCP config, `tools:` limited to
   `read_url_content`, `search_web`, `view_file`, `list_dir`, and a fail-closed `PreToolUse` gate
   (`.agents/hooks/setup-gate.mjs`, generated, no dependencies) that allows only those tools plus `finish`; fetches
   must be public http(s) (no loopback/RFC1918/link-local/credentials, DNS is resolved and checked); `view_file` /
   `list_dir` only inside the workspace or `~/.gemini/antigravity-cli/brain/<conversationId>/` (where agy spills
   fetched pages), symlinks resolved.
2. **Role knowledge base** — `GET/PUT /v1/admin/setup/role-kb`. `kbRoot/roles/<role>/*.md`, if present, is ingested
   as scope `role:<role>` and `templates/<role>/kb` is *not* (previously ingested template docs are pruned);
   `kbRoot/roles/` is never ingested as company scope. PUT replaces the directory (new files written first, stale
   `.md` removed), re-syncs and audits `kb.edited`.
3. **Email in the UI** — `GET/PUT /v1/admin/setup/email`, `POST /v1/admin/setup/email/test`. Settings live in kv
   `email_settings` and override the config file's `email`; passwords are AES-256-GCM encrypted with
   `<dataDir>/secret.key` (random 32 bytes, created on first use, mode 600; a looser mode is warned about and
   tightened) and are never returned or logged (the view only says `hasPassword`). An omitted/empty password keeps the
   stored one; `AGYHQ_IMAP_PASS` / `AGYHQ_SMTP_PASS` still win. Saving **hot-swaps** the provider (`EmailRuntime`): the
   Sender, inbound poller, status endpoint and readiness verifier all read it through the runtime, the old provider is
   closed, the poller restarts and `status.changed` is emitted. Poll cursor: kept when the mailbox identity (address,
   IMAP host/port/user, mailbox, maildir root) is unchanged (e.g. a password or SMTP change), reset when it changes —
   the new mailbox is then read "from now on" (no backfill; mail that arrived in it before the swap is not processed).
   The test endpoint checks IMAP (login + open mailbox) and SMTP separately against unsaved settings (stored
   passwords fill in), ~20s timeout each, errors scrubbed of the password.
4. **Sender identity** — `GET/PUT /v1/admin/setup/sender` (kv `sender_settings`). `effectiveSender()` is the single
   source for the From header, footer, `List-Unsubscribe`, own-address detection and the `sender.identity` /
   `unsubscribe.mailto` readiness checks; the config file's `sender` / `unsubscribeMailto` are only the fallback.

Opt-in real run (uses a temp data dir, costs quota):
`AGYHQ_REAL_AGY=1 AGYHQ_SETUP_DOMAIN=example.com AGYHQ_SETUP_OUT=/tmp/out.json npx vitest run packages/server/test/real-setup-generate.test.ts`.

## Packages

| Package | What it is |
|---|---|
| `@agyhq/core` | Shared domain types + the HTTP contract between the daemon and hook/MCP processes |
| `@agyhq/db` | SQLite persistence (agents, tasks, conversations, audit, KB, memory, CRM, outbox, quota) |
| `@agyhq/runner` | Spawns `agy` headlessly and classifies the outcome |
| `@agyhq/workspace` | Renders a role template into a per-agent workspace; renders per-task prompts |
| `@agyhq/hooks` | The `PreToolUse`/`PostToolUse`/`PreInvocation`/`PostInvocation`/`Stop` scripts `agy` invokes |
| `@agyhq/mcp` | The company MCP server (`kb_*`, `crm_*`, `memory_*`, `task_create`, `contact_handoff`, `outbox_draft_email`) |
| `@agyhq/server` | The daemon: config, provisioning, KB ingestion, orchestrator, quota, inbound pipeline, sender, admin API, agent-facing API |
| `@agyhq/channels` | Email providers (`imap-smtp`, `maildir`, `fake`) + parsing/classification, behind `@agyhq/core`'s `EmailProvider` contract |
| `@agyhq/cli` | `hq` — the command-line client for the admin API |

## Testing

```sh
npm test                              # fast, offline — fakes the agy binary and email provider
AGYHQ_REAL_AGY=1 npx vitest run packages/server/test/real-e2e.test.ts
AGYHQ_REAL_AGY=1 npx vitest run packages/server/test/real-e2e-phase2.test.ts
```

The real end-to-end tests spawn the actual `agy` CLI (costs quota/time).
`real-e2e.test.ts` is the Phase 1 flow (research → first-touch draft).
`real-e2e-phase2.test.ts` drops a reply `.eml` into a maildir inbox, waits for
the daemon to route it to a real `sdr.handle_reply` run, approves the
resulting draft via the admin API, and asserts the Sender actually delivers
it to maildir's `sent/` with correct `In-Reply-To`/`References`/
`List-Unsubscribe` headers and the disclosure footer.
