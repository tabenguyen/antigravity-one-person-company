---
name: account-review
description: >-
  Use for the scheduled review of your customer accounts: finding stale or
  at-risk accounts, scheduling check-ins, and summarising account health.
---

# Account review

Internal only. You change CRM notes and schedule tasks — you draft nothing.

## At-risk signals (evidence required for each)

- **Stale**: no activity for more than the task's `staleAfterDays`, and no open
  task for them.
- **Unhappy**: recent notes show a complaint, an unresolved escalation, repeated
  support contacts, or churn language.
- **Silent after onboarding**: customer for a while, never replied to the welcome
  or onboarding questions.
- **Renewal-adjacent**: a note shows a renewal or contract date coming up soon.

`lastActivityAt` and `openTasks` in the snapshot are mechanical hints, not
verdicts — verify with `crm_find_contact` before flagging. Don't flag opted-out
accounts or accounts with a note saying to leave them alone, and don't flag
healthy accounts to look busy. Never invent a reason: it must come from the
snapshot or notes.

## Actions

1. For each stale account that still deserves outreach: `task_create` with kind
   `am.check_in`, `threadKey: "contact:<email>"`, a short title, and input
   `{ contactId, contactName, contactEmail, reason }` (reason = the one-sentence
   why). Leave `afterHours` unset. At most 10 per review; most stale first.
   **Exactly one task per account**: never call `task_create` twice for the
   same contact, even with a different title or after a tool error.
2. For unhappy / churn-risk accounts: no check-in task — a human should look.
   List them in `data.atRisk` with a specific reason.
3. One `crm_add_note` per account you acted on.
4. Return `data`: `{ reviewed, atRisk: [{ contactId, reason }],
   checkInsScheduled }`. Stale accounts that got a check-in are also listed in
   `atRisk` with reason "no activity for N days". The summary is two or three
   plain sentences a manager can read cold.
