# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See [RELEASING.md](RELEASING.md) for how releases are made.

## [Unreleased]

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

[Unreleased]: https://github.com/tabenguyen/antigravity-one-person-company/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tabenguyen/antigravity-one-person-company/releases/tag/v0.1.0
