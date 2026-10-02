# Task: review your pipeline (scheduled routine — internal only)

Today is {{reviewDate}}. This is your regular pipeline review. Nothing here
goes to a prospect: **do not draft any emails** (no `outbox_draft_email`
calls) — the only things you may change are CRM notes/stages and scheduled
follow-up tasks.

The daemon has prepared a snapshot of the leads you own (stages: researching,
contacted, replied, qualified, meeting_booked, nurture), most stale first. It
is the `pipelineSnapshot` array in the **Task input (raw)** section at the
bottom of this prompt. For each lead it gives the stage, when we last reached
out (`lastTouchAt`, `daysSinceLastTouch`), when they last replied, any open
tasks on that thread, and `staleHint` — a mechanical guess, not a verdict.

## What to do

1. **Flag stale leads.** A lead is stale when it is in stage `contacted`, we
   reached out more than {{staleAfterDays}} days ago, they have not replied,
   and there is no follow-up task scheduled for them. Verify each
   `staleHint: true` lead before acting: `crm_find_contact` (by `email`) and
   read its recent notes. Don't flag leads that opted out, that a note says
   to leave alone, or that already have an open task.
2. **Schedule the missing follow-ups.** For each stale lead that should
   continue the cadence (see the `follow-up-sequence` skill — including its
   stop rules), call `task_create` with kind `sdr.follow_up`, the lead's
   thread (`threadKey: "contact:<email>"`), a short title, and an input of
   `{ contactName, contactEmail, touchNumber, daysSincePrevious,
   priorTouchesSummary }`. Leave `afterHours` unset so it is picked up
   promptly. If the cadence is exhausted or a stop rule applies, do not
   create a task: `crm_set_stage` to `nurture` (or `disqualified` for an
   opt-out) with a one-line reason.
3. **Log it.** One `crm_add_note` per lead you acted on, saying what you
   decided and why.
4. Do not create more than 10 follow-up tasks in one review — if more leads
   qualify, handle the most stale first and mention the rest in your summary.
5. Reply-handling, new research and drafting are other tasks: if you notice
   a lead who replied but has no handling task, say so in the summary
   rather than answering them yourself.

## Result

Finish by calling `finish` with the structured task result:
- `status: "done"` once the review is complete (including when nothing needed
  doing). Use `needs_human` only if something looks wrong enough that a person
  should look (e.g. many leads contacted with zero replies and no follow-ups).
- `summary`: two or three sentences a manager can read cold — how many leads
  reviewed, how many stale, how many follow-ups scheduled.
- `data` should include `{ reviewed, stale, followUpsScheduled, flagged }`
  where `flagged` is a short list of `{ email, reason }` for leads that need
  a human's attention.
