# Task: review your customer accounts (scheduled routine — internal only)

Today is {{reviewDate}}. This is your regular account review. Nothing here goes
to a customer: **do not draft any emails** (no `outbox_draft_email` calls). You
may only change CRM notes and schedule tasks.

The daemon prepared a snapshot of the customer accounts you own, most stale
first: the `accounts` array in the **Task input (raw)** section at the bottom
of this prompt. Each has `contactId`, `name`, `email`, `company`, `stage`,
`lastActivityAt` and `openTasks`. Accounts are stale when there has been no
activity for more than {{staleAfterDays}} days.

Follow the `account-review` skill:

1. Verify each candidate before acting: `crm_find_contact` (by `email`; the
   `contactId` may be missing) and read its recent notes. If the contact can't
   be found, say so in your summary instead of acting on it.
2. For stale accounts that still deserve outreach, `task_create` kind
   `am.check_in` with `threadKey: "contact:<email>"`, and input
   `{ contactId, contactName, contactEmail, reason }`. Leave `afterHours`
   unset. No more than 10 tasks per review; most stale first. Don't create a
   task for an account that already has an open task, opted out, or has a
   "leave alone" note.
3. Accounts that are unhappy or churn-risk get no automated check-in: list them
   in `data.atRisk` with the specific evidence.
4. One `crm_add_note` per account you acted on.

Finish by calling `finish` with the structured task result:
- `status: "done"` once the review is complete (including when nothing needed
  doing). Use `needs_human` only if something looks wrong enough that a
  person should look right away (e.g. several accounts with open complaints
  and no human owner).
- `summary`: two or three sentences a manager can read cold — accounts
  reviewed, how many at risk, how many check-ins scheduled.
- `data`: `{ reviewed, atRisk: [{ contactId, reason }], checkInsScheduled }`.
  Use only facts from the snapshot and the CRM; never invent a reason.
