# Phase 4 — More roles + coordination (contract)

Status: built 2026-10-03 (backend, templates, UI, real-agy evals). This
file is the shared contract between the backend, template and UI work. If code
and this file disagree, fix one of them in the same change.

Routes below are written as the daemon serves them: every admin route lives
under `/v1/admin/...` (the first draft of this file said `/admin/...`). Wire
types: the "Phase 4 additions" block at the end of
`packages/server/src/admin-types.ts`.

Scope of this phase:

1. **Account Manager / Customer Success** becomes a real role (was a stub).
2. **Chief of Staff** role: triages inbound nothing else owns, writes a daily
   digest for the owner. Internal only — it never drafts customer email.
3. **Handoffs**: a won deal moves from the SDR to the AM; replies then route to
   whoever owns the contact, using that owner's role.
4. **Per-role routines**: `account_review` (AM), `daily_digest` (CoS).
5. **Per-role KPIs** and **per-role eval suites**.

Out of scope (later): Marketer role (needs publishing channels), Postgres,
multi-tenant.

---

## 1. Domain changes (`@agyhq/core`)

- `LeadStage` gains `"customer"` and `"churned"`. (Name kept for
  compatibility; it is now the contact lifecycle stage.)
- `HqSettings` gains `defaultAmAgentId: string | null` and
  `defaultCosAgentId: string | null` (both default `null`).
- `RoutineKind` gains `"account_review"` and `"daily_digest"`.
- New `Briefing { id, agentId, taskId, periodStart, periodEnd, markdown, createdAt }`.
- New audit kinds: `contact.handoff`, `briefing.created`.

## 2. Template additions (`template.json`)

Optional `routing` block, read by the inbound router:

```json
"routing": { "replyKind": "am.handle_message", "followUpKinds": ["am.check_in"] }
```

`sales-sdr` gets `{ "replyKind": "sdr.handle_reply", "followUpKinds": ["sdr.follow_up"] }`.
`chief-of-staff` has no `routing` (it never owns contacts).
Fallback when absent: `config.routing.*`, but only for a role whose template
defines `config.routing.replyKind` as a task kind (custom SDR templates that
predate the block). A role with neither (chief-of-staff) never answers
replies. The loader rejects a `routing` block naming a kind that is not in
`taskKinds`; `followUpKinds` defaults to `[]`. The loaded `Template` exposes it
as `template.routing` (`null` when absent); the server reads it through
`packages/server/src/routing.ts` (`roleRouting`, `roleTaskKinds`, `buildRoster`).

## 3. Task kinds and inputs

### account-manager

| kind | input | does |
|---|---|---|
| `am.onboard` | `contactId, contactName, contactEmail, companyName?, handoffSummary, fromAgentId?` | Read handoff + KB, draft a welcome/onboarding email (one), note on contact. |
| `am.handle_message` | same shape as `sdr.handle_reply`: `contactName, contactEmail, subject, replyBody, threadSummary, inboundEventId` | Answer a customer question from KB; tier-1 support. Refunds, discounts, price changes, contract terms, SLA/uptime promises, bug commitments, cancellations → `needs_human` (draft at most a short holding reply that promises nothing). Churn signal → `crm_set_stage(churned)` only if the customer explicitly cancels. |
| `am.check_in` | `contactId, contactName, contactEmail, reason` | Proactive check-in (adoption / renewal). Draft one short email or decide not to (`done` with reason). |
| `am.account_review` | `accounts: [{contactId, name, email, company, stage, lastActivityAt, openTasks}]`, `staleAfterDays` | Routine. Flag at-risk accounts, `task_create` `am.check_in` for stale ones. Drafts no email. Returns `data.atRisk: [{contactId, reason}]`. |

AM MCP tools: `kb_search, memory_list, memory_propose, crm_find_contact,
crm_add_note, crm_set_stage, task_create, outbox_draft_email`.

`am.account_review` input as the routine builds it (see §6): `routineName,
reviewDate` (YYYY-MM-DD), `staleAfterDays`, `accounts: [{contactId, name,
email, company, stage, lastActivityAt, daysSinceActivity, openTasks: [{kind,
status, wakeAt}], staleHint}]` (the last two are additions to the list above).

### chief-of-staff

| kind | input | does |
|---|---|---|
| `cos.triage` | `inboundEventId, fromAddress, fromName, subject, body, classification, roster: [{agentId, role, displayName, kinds: string[]}]` | Decide who handles it. Either `task_create` with `assigneeAgentId` + a kind from the roster, or `needs_human`, or `done` (“no action: <why>”). Returns `data.decision: { action: "delegated" \| "needs_human" \| "no_action", assigneeAgentId?, kind?, reason }`. |
| `cos.daily_digest` | `periodStart, periodEnd, snapshot: { kpis, pendingApprovals, failedTasks, needsHuman, newContacts, handoffs }` | Write a short markdown brief for the owner (Vietnamese by default, follows company language): what happened, what needs the owner today (ranked), risks. Returns `data.digestMarkdown`. No tools needed beyond `kb_search`. |

CoS MCP tools: `kb_search, crm_find_contact, crm_add_note, task_create`.
Never `outbox_draft_email`.

Neither new role gets `read_url_content` / `search_web`: URLs in customer or
inbound text are an injection/exfiltration vector and neither role needs them.

Extra result fields the UI may show: `am.onboard` → `data.unverifiedClaims`
(promises in the handoff summary the AM refused to repeat); escalations →
`data.urgency`. Manipulative inbound (prompt injection) → CoS returns
`needs_human` so the owner sees the attempt.

## 4. Handoff

- MCP tool `contact_handoff({ contactId, toRole: "account-manager", summary })`
  (SDR policy gets it; `summary` required, 1..2000 chars). Returns
  `{ contact, task, fromAgentId, toAgentId }`. Also admin endpoint
  `POST /v1/admin/contacts/:id/handoff { toRole?, summary? }` for the human
  “Won → hand to AM” button (same response; `summary` optional for a human,
  `toRole` defaults to `account-manager`).
- Effect (one transaction): resolve target = `settings.defaultAmAgentId`
  (error `invalid_request` if unset/inactive); set `ownerAgentId`; set stage
  `customer`; add a note (“Handed off from X to Y: summary”); cancel the
  previous owner’s queued follow-up kinds on thread `contact:<email>`; create
  `am.onboard` task (threadKey `contact:<email>`, `createdByAgentId` = caller
  or null); audit `contact.handoff`; emit `contact.handoff`.
- Allowed from stages `qualified`, `meeting_booked`, `replied` (agent) or any
  stage (human). Idempotent: handing off to the current owner is an error
  (`conflict`).
- Errors (`invalid_request` unless noted): no/inactive/wrong-role default AM;
  the AM template has no `am.onboard`; contact without an email; an agent from
  a disallowed stage; an agent that is not the contact's owner (an unowned
  contact may be handed off by whoever is handling it). `not_found` for an
  unknown contact. The cancelled follow-up kinds are the previous owner's role
  `routing.followUpKinds` (the caller's role when the contact had no owner).

## 5. Inbound routing

- `reply`: owner = the first of `contact.ownerAgentId`, `defaultAmAgentId`
  (only when the contact is a `customer`), `defaultSdrAgentId` that exists, is
  not archived and whose role has a reply kind; kind = owner role’s
  `routing.replyKind` (fallback config). Cancel the owner role’s
  `followUpKinds` on the thread. Stage → `replied` unless the contact is a
  `customer` (never downgrade `customer`).
- `new_lead` whose sender is an existing contact with an owner whose role has
  `routing.replyKind`, and stage `customer`: route as a reply to the owner.
- `other` (and any reply/new_lead with no resolvable agent): if
  `defaultCosAgentId` is set (active, not archived) → `cos.triage` task
  (priority 10 for a reply, else 5) with input `{inboundEventId, fromAddress,
  fromName, subject, body, classification, roster}`; the roster is every
  active non-chief-of-staff agent with the kinds its template defines; the
  event is `routed` (audit `inbound.routed` carries `action: "triage"`). Else
  today’s behaviour (`received` with a reason, or `ignored: unclassified` for
  `other`). The email classifier never emits `other` today; the branch exists
  for webhook/future sources.

## 6. Routines

- `account_review` config `{ maxAccounts: 1..200 = 40, staleAfterDays: 1..180 = 14 }`;
  snapshot = contacts owned by the routine's agent with stage `customer` (not
  opted out), stale first then quietest first. `lastActivityAt` = newest of an
  email we sent them and a message they sent us. Runs skip while the previous
  `am.account_review` is queued/running, and queue nothing when there are no
  customers.
- `daily_digest` config `{ lookbackHours: 1..168 = 24 }`; snapshot assembled
  server-side (`DigestSnapshot` in admin-types.ts: `kpis` for the window,
  `pendingApprovals {count, oldestAt, items}`, `failedTasks`, `needsHuman`
  (tasks currently waiting for a human), `newContacts`, `handoffs`, each
  `{count, items}` capped at 20). Input: `{ routineName, periodStart,
  periodEnd, snapshot }`. Always queues a digest (an empty day is still a
  digest); skips while the previous one is queued/running.
- When a `cos.daily_digest` task finishes `done` with `data.digestMarkdown`,
  the orchestrator stores a `Briefing` (once per task, markdown capped at
  50k chars, period from the task input) and audits `briefing.created`; bus
  event `briefing.created { briefingId, agentId, taskId }`.

## 7. KPIs

`GET /admin/kpis?days=7` →

```ts
{
  windowDays: number,
  roles: {
    "sales-sdr":       { agents, leadsResearched, firstTouchDrafted, emailsSent, replies, replyRate, qualified, meetingsBooked, handoffs },
    "account-manager": { agents, accounts, messagesHandled, medianFirstResponseMinutes, escalations, checkInsDrafted, churned },
    "chief-of-staff":  { agents, triaged, delegated, escalated, digests },
  },
  common: { tasksDone, tasksFailed, needsHuman, approvalRate, medianEditRatio }
}
```

Null where there is no data (never fake a 0 rate): counts are always numbers
(0 is a real count); `replyRate`, `medianFirstResponseMinutes`, `approvalRate`,
`medianEditRatio` are `null` when there is nothing to divide. `days` is an
integer 1..365 (default 7). `GET /v1/admin/briefings` (latest first, `limit`,
`agentId`) and `GET /v1/admin/briefings/:id`.

Definitions (implemented in `packages/server/src/kpis.ts`): the window is the
last `days` days; tasks and drafts are cohorted by `createdAt` (like stats and
scorecards), `emailsSent` by send time, stage counts by the time of the
stage-change note. `agents` = non-archived agents of the role. `replies` =
inbound replies routed to an agent of the role; `replyRate = replies /
emailsSent` capped at 1. `accounts` = contacts currently `customer`
(point in time). `messagesHandled` = `am.handle_message` done. `escalations` /
`common.needsHuman` = transitions into `waiting_approval` (audit), so a task
resumed and escalated again counts twice. `medianFirstResponseMinutes` =
customer message received → first email *sent* for it (null until one is
sent, e.g. forever for a shadow agent). `triaged` = `cos.triage` done or
waiting for a human; `delegated` = done with `data.decision.action ==
"delegated"`. `handoffs` = `contact.handoff` events. `approvalRate` /
`medianEditRatio` use the scorecard definitions over all drafts in the window.

## 8. Quality

- Draft lint is role-aware: AM drafts flag promises of refunds, discounts,
  credits, SLA/uptime %, delivery dates for features/bug fixes, and contract
  changes (vi + en phrases) as `error`. Codes: `am_refund_promise`,
  `am_discount_promise`, `am_credit_promise`, `am_sla_promise`,
  `am_delivery_promise`, `am_contract_promise` (`quality/am-lint.ts`). Matching
  is per sentence on diacritic-folded text; a sentence that declines or hedges
  ("can't offer a refund", "chưa thể hoàn tiền") is not a promise, and quoted
  (">") lines are ignored. They block the draft at draft time like the other
  errors, so the agent must rewrite it as a holding reply.
- Each role has `templates/<role>/evals/suite.json` + cases; the eval runner
  is role-generic. AM ≥ 6 cases, CoS ≥ 4 cases. Runner additions: the eval
  daemon's template copy contains every role (plus `_shared`); a case may list
  `agents: [{id, role, displayName?}]` and every `input.roster[]` entry is
  provisioned too (shadow tier, `maxConcurrency` 0 so they never run) so
  `task_create` to them succeeds; `contact.ownerAgentId` / `contact.stage`
  (incl. `customer`, `churned`) seed the contact (owner defaults to the eval
  agent, none for chief-of-staff); the task input gets `contactId`; the
  `task.created` assertion takes `assigneeAgentId` and sees tasks created for
  any agent; `result.data.path` takes `pattern`, `notPattern` and `contains`
  (ANDed with `equals`/`oneOf`).
- Readiness: `kb.no_placeholders` scans only the role KBs of roles with an
  active agent; `agents.sdr_present` is a warning (not a failure) when only
  account managers exist; `settings.default_am` / `settings.default_cos`
  appear once an agent of that role exists or the setting is set.
- Settings: `PATCH /v1/admin/settings` accepts `defaultAmAgentId` (active
  `account-manager`) and `defaultCosAgentId` (active `chief-of-staff`) or
  `null`; 400 otherwise.
- DB: migration 4 adds `briefings` (unique per task) and owner/stage/kind
  indexes; stages and roles are plain TEXT, so no CHECK changes.

## 9. UI

- Create agent: role picker (SDR / AM / CoS). Settings: default AM, default CoS.
- Contact page: owner + stage, “Hand off to Account Manager” button, handoff
  history (from notes/audit).
- Briefings page (list + markdown view).
- Dashboard: per-role KPI cards.
- Routines: create `account_review` / `daily_digest`.
