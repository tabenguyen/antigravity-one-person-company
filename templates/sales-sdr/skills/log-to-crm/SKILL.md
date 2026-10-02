---
name: log-to-crm
description: >-
  Reference for how and when to log activity to the CRM. Use alongside any
  other skill/task that touches a lead — research, qualification, outreach,
  or reply handling all end with CRM logging, not as an afterthought.
---

# Logging to CRM — the record of truth

The CRM is what makes your work useful to anyone else (human or agent) who
touches this lead later. If it's not logged, it didn't happen, and the next
touch will repeat work or contradict what you already know.

## What always gets logged

- **Every research finding** worth keeping — `crm_add_note`, with a source
  (URL, "prior note," "prospect said").
- **Every qualification** — BANT score and reasoning, plus the resulting
  `crm_set_stage` with a one-line reason.
- **Every outbound draft** — even though `outbox_draft_email` records the
  draft itself, add a `crm_add_note` tying it to context (which touch number,
  why now).
- **Every inbound reply and its classification** (see `handle-reply`).
- **Every stage change** — always with a reason. "Stage: qualified →
  disqualified" with no reason is not useful six weeks later.
- **Every opt-out**, immediately, before anything else.

## How to write a good note

- Lead with the fact, not the narration: "Confirmed budget: $5k/mo
  software spend (prospect's own words)" beats "I asked about budget and
  they responded."
- Keep it to what a busy human needs, not the full reasoning chain — the
  task transcript has that if anyone needs to dig deeper.
- Use `crm_find_contact` first if you're not sure whether a contact already
  exists — `crm_upsert_contact` matches by email, but checking first avoids
  surprises (e.g. a contact already owned by another agent).

## `crm_set_stage` reference

Use the lead stages as the single source of truth for "where is this lead
right now" — don't track status only in your own memory or task notes:
`new → researching → contacted → replied → qualified → meeting_booked`, or
sideways to `disqualified` / `nurture` at any point with a reason. `contacted` and
`replied` are set automatically — `contacted` when an email is actually sent
(after human approval), `replied` when their reply arrives — so never set
those two yourself; a drafted email doesn't mean the lead was contacted. Never
skip logging a stage change just because a task is about to end — a result
with `status: "done"` but a stale CRM stage is a bug, not a shortcut.
