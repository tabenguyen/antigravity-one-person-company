# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See [RELEASING.md](RELEASING.md) for how releases are made.

## [Unreleased]

## [0.3.0] - 2026-10-04

Adds the Fanpage Manager role and Facebook channel. Upgrading from 0.2.0 needs no manual
steps: database migration 8 runs on daemon start. Run `npm run build` before restarting the daemon.

### Added

- `hq` loads secrets from `<repoRoot>/.env` (gitignored; template `.env.example`; `AGYHQ_ENV_FILE` for another path) without overriding variables already set in the shell. `hq serve` logs the names it loaded, never values, and warns when the file is readable by other users.
- **Fanpage Manager role** (`templates/fanpage-manager`, [docs/FANPAGE.md](docs/FANPAGE.md)): drafts Facebook Page posts (related news with a cited source URL, features, releases, tips; Vietnamese by default) and answers or moderates comments (question / praise / complaint / spam / sales lead / off-topic: spam gets a hide proposal, complaints and price or refund questions go to a human, sales leads to the SDR). Nothing reaches Facebook without approval and approved posts are only ever scheduled (default 24h ahead). Built and tested against an in-memory fake Page; a real Page needs the Meta app, a token and the spike checks listed in the doc.
- **Facebook channel** (`@agyhq/channels`): `FacebookPageProvider` contract, `GraphApiFacebookProvider` (token in the `Authorization` header only, Graph version from config, 10 min to 75 day scheduling window checked client-side, typed errors) and `FakeFacebookProvider`; `facebook` config block in `agyhq.config.example.json`.
- Facebook secrets follow the mailbox-password pattern: Page token from env `AGYHQ_FB_PAGE_TOKEN`, optional app secret from env `AGYHQ_FB_APP_SECRET` (when set, every Graph call carries `appsecret_proof`, so "Require App Secret" can be enabled), `appId` in the config file; the config cannot hold a secret. `hq facebook doctor` reports the app secret and `appsecret_proof` status without printing values. `verifyWebhookSignature` (`X-Hub-Signature-256`) is ready for the later webhook endpoint.
- Comment poller (deduped by comment id, the Page's own comments never answered), `content_calendar` and `comment_poll` routines, Facebook KPIs, draft lint (`news_missing_source`, `unsourced_stat` plus the shared price / forbidden-claim / promise rules), `hq facebook doctor`, Facebook drafts in the Inbox (post preview / comment + reply), a Facebook page with scheduled posts, and a 12-case eval suite. New setting `defaultFanpageAgentId`; database migration 8.
- `hq facebook doctor` reads a Page token's scopes and expiry from `/debug_token` (authenticated as the app, token sent in the POST body, never the URL) when `appId` and the app secret are set, since a Page token has no `/me/permissions`. Token, Page identity and `appsecret_proof` verified against a real Page on Graph API v26.0.

### Changed

- Quota throttle is per model family. A drained Gemini bucket only holds back low-priority work of agents on Gemini models; agents on Claude/GPT models keep running on their own bucket (`QuotaMonitor.isThrottledFor(model)`, `tasks.claimNext(now, { skip })`). Unknown model ids still throttle when any bucket is low. Also fixes the throttled claim loop, which could claim low-priority tasks once any high-priority task was queued.
- Readiness: placeholder text in a **role's** knowledge base no longer pauses all outbound. `kb.no_placeholders` now covers the company KB only; the new `kb.role_placeholders` check warns, and while outbound is on the readiness monitor pauses just that role's agents (re-pausing them if resumed early, audit `agent.auto_paused`). Before, filling in nothing for a new role (e.g. the Fanpage Manager) stopped the SDR's email too.
- Web UI: sidebar navigation is grouped by function.
- docs: README demo screenshots for the v0.2.0 features (SDR → Account Manager hand-off, KPIs by role, Chief of Staff briefing, shadow run); `npm run demo:screenshots` now produces 7 images.

## [0.2.0] - 2026-10-03

Two new AI employees, hand-offs between them, and everything needed to start a
two-week shadow run on a real mailbox. Upgrading from 0.1.0 needs no manual
steps: the database migrates itself on daemon start. Run `npm run build` before
restarting the daemon so agents get the updated company MCP tools.

### Added

- **Account Manager / Customer Success role** (`templates/account-manager`, replaces the 0.1.0 stub): onboards new
  customers, answers questions from the knowledge base (tier-1 support), sends proactive check-ins and reviews its book
  of accounts on a schedule. Refunds, discounts, credits, price or contract changes, SLA/uptime promises, feature or
  bug-fix dates and cancellations always go to a human; new draft lint rules (`am_refund_promise`,
  `am_discount_promise`, `am_credit_promise`, `am_sla_promise`, `am_delivery_promise`, `am_contract_promise`, vi + en)
  refuse drafts that promise them.
- **Chief of Staff role** (`templates/chief-of-staff`), internal only (never drafts customer email): triages inbound
  mail no other agent owns and delegates it to the right agent and task, or hands it to you (prompt-injection attempts
  included); writes a daily digest, stored as a **briefing** (new Briefings page, `GET /v1/admin/briefings`,
  `hq briefings`).
- **SDR → Account Manager hand-off**: the SDR calls `contact_handoff` when a prospect becomes a customer, or you click
  "Hand off to Account Manager" on the contact page (`POST /v1/admin/contacts/:id/handoff`, `hq contact handoff`). The
  contact becomes `customer`, its SDR follow-ups are cancelled and an onboarding task is queued. New contact stages
  `customer` and `churned`.
- **Role-aware routing**: a reply goes to whoever owns the contact and is handled with that role's reply task; mail
  nobody owns goes to the default Chief of Staff for triage. New settings `defaultAmAgentId` / `defaultCosAgentId`.
- **Routines** `account_review` (Account Manager) and `daily_digest` (Chief of Staff).
- **Per-role KPIs** on the Dashboard (7/30 days) and `GET /v1/admin/kpis`, `hq kpis`. Rates with no data show "—",
  never 0.
- **Shadow runs**: start a bounded evaluation of shadow-tier agents on real mail (`hq shadow start|status|end|list`,
  `/v1/admin/shadow`, Shadow run page and Dashboard card). Each agent gets a verdict (on track / not enough data /
  below bar) against the promotion criteria, a rejection breakdown and a daily trend. The Chief of Staff digest flags a
  piling-up review queue. Runbook in Vietnamese: [docs/SHADOW-RUN.md](docs/SHADOW-RUN.md).
- **`hq email doctor`** (and `POST /v1/admin/email/doctor`): read-only preflight of the real mailbox — IMAP login,
  Sent folder detection, how many messages a first sync would ingest, a dry run of how recent mail would be classified
  and routed, SMTP auth without sending. `--send-test <address>` sends exactly one test email. Mailbox guide for Gmail,
  Microsoft 365 and Zoho: [docs/EMAIL-SETUP.md](docs/EMAIL-SETUP.md).
- **Opt-in Sent-folder sync** (`syncSent: true`, `sentFolder`): replies you send from your own mail client show up in
  the agents' thread context, cancel pending follow-ups on that thread and mark older drafts as superseded.
- **Eval suites** for the Account Manager (8 cases) and Chief of Staff (7 cases); the eval runner is role-generic
  (roster agents, delegated-task assertions, `pattern` / `notPattern` / `contains` on result data).
- `invented_availability` lint warning: flags an SDR draft that offers meeting times the agent cannot know.

### Changed

- **IMAP access is read-only**: mailboxes are opened with `EXAMINE` and fetched with `BODY.PEEK`, so agy-hq never marks
  your mail as read, moves or deletes it. The first sync only ingests mail that arrives after the first connection
  (`initialSyncDays`, default 0; `initialSyncMaxMessages`, default 200).
- The sender refuses any email from an agent in the `shadow` tier, even if it was approved (defence in depth on top of
  `held`).
- Approval inbox: **Save & approve** in one step (key `A`) records your edit; rejecting needs only a category (keys
  `1`–`8`), the written reason is optional (`hq outbox reject --category` alone works); the queue is worked
  oldest-first and shows `revised ×N` / `superseded` badges.
- A reply from a contact that is already a `customer` no longer moves it back to `replied`.

### Fixed

- **IMAP provider**, now tested against real IMAP/SMTP protocol servers: a dropped connection could crash the daemon;
  a failed connect was never retried; a wrong password was retried (risking an account lockout); the cursor could get
  stuck behind a long run of deleted messages.
- Settings page: saving before the stored values had loaded could overwrite them with defaults.
- **SDR evals 8/8 on real agy**: `first-touch-good-fit` no longer proposes a fixed slot ("15-minute call, I'm free
  Tuesday"): the write-first-touch skill example, voice-and-tone rule, first_touch prompt and handle-reply skill now say
  the SDR has no calendar and must ask a low-friction question or share the KB meeting link. New `invented_availability`
  lint warning (SDR, vi + en) flags offered times for the reviewer. `research-out-of-icp-answers-question` failed because
  the eval seeded the inbound message only as task text; the lead's email is now also an inbound event (as in production),
  so `Re: <their subject>` is not a deceptive subject; the research_lead prompt and the `deceptive_subject` refusal text
  say when "Re:" is allowed.
- **Lint false positive on echoed subjects**: a reply subject that repeats the customer's own subject ("Re: Uptime
  guarantee for our board paper", "Trả lời: ...") no longer makes the Account Manager promise rules (and the SDR
  placeholder / price / claim rules) refuse the draft. Lint reads only what the agent wrote: the echo is skipped, text
  added to the subject and the body (quoted `>` lines aside) is still linted. The Account Manager template drops its
  neutral-subject workaround. `am_sla_promise` also no longer fires on a pure acknowledgement / hand-off sentence ("I received your request
  regarding the uptime guarantee; I've passed it to our team"): no figures, timeframes or affirmations about the service.
- **Duplicate drafts**: `outbox_draft_email` keeps one live draft per email. A second draft for the same task and
  recipient rewrites the pending one in place (`revisions`, audit `outbox.revised`) or is refused once it was reviewed;
  a draft from another task on the same thread supersedes an older pending one only when the contact wrote since,
  otherwise it is refused. Scorecards, shadow-run stats and KPIs count each email once and ignore superseded drafts.
  The tool result now says that a saved draft is queued and its warnings are notes for the reviewer.

## [0.1.0] - 2026-10-02

First public release: run a one-person company with AI employees on the
Antigravity CLI (`agy`) you are already logged into — no API key, no per-token bill.
Tested with `agy` 1.2.14 on Node 20.

### Added

- **Sales SDR role** (`templates/sales-sdr`): researches leads and scores them
  BANT-lite, drafts personalized first-touch and follow-up emails in Vietnamese
  or English, handles replies (interested, not now, stop contacting, wrong
  person/referral), schedules follow-ups, and learns from human edits and
  rejections.
- **Setup wizard**: enter a company domain and a sandboxed researcher agent reads
  the website and drafts the company profile, ICP, sales playbook and objection
  handling, flagging conflicts and open questions. Nothing is saved until a
  human applies it.
- **Harness daemon**: task queue and state machine with retries, backoff and
  per-thread locking; one isolated `agy` workspace per agent rendered from a
  role template; SQLite state (agents, tasks, CRM, knowledge base, memory,
  outbox, audit log); quota poller that throttles to high-priority work when
  `agy` quota runs low.
- **Company MCP server** (`kb_*`, `crm_*`, `memory_*`, `task_create`,
  `outbox_draft_email`) and a fail-closed `PreToolUse` policy gate; agents never
  hold mailbox or API credentials.
- **Inbound**: IMAP and maildir polling plus web-form webhooks, deduplicated and
  routed deterministically (unsubscribe, bounce, auto-reply and spam need no model
  call). Email attachments are stored and readable by the agent working the thread.
- **Outbound safety**: draft-only by default, trust tiers
  (shadow → assisted → autonomous), human approval inbox, kill switch (off by
  default) that auto-trips on bounce spikes, quiet hours, send-rate limit,
  `List-Unsubscribe` and company footer, go-live readiness gate that pauses
  outbound when setup is incomplete.
- **Draft quality**: deterministic bilingual (vi/en) lint on every draft,
  including the company's forbidden claims;
  per-agent scorecards and promotion, recurring routines, and an SDR eval suite.
- **Web UI** (Dashboard, Inbox, Tasks with live stream, Contacts, Knowledge,
  Memory, Scorecards, Routines, Setup, Settings) and the `hq` CLI.
- **Real-world example**: NK Invoice company profile and knowledge base in
  `examples/nk-invoice/`.

### Known limitations

- Only the Sales SDR role is complete; Account Manager is a stub.
- Real IMAP/SMTP has been tested against few providers.
- Throughput is bounded by your Antigravity account quota.

[Unreleased]: https://github.com/tabenguyen/antigravity-one-person-company/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/tabenguyen/antigravity-one-person-company/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tabenguyen/antigravity-one-person-company/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tabenguyen/antigravity-one-person-company/releases/tag/v0.1.0
