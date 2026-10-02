---
name: follow-up-sequence
description: >-
  Use whenever asked to draft the next follow-up for a lead who hasn't
  replied yet, or to decide whether a follow-up sequence should continue or
  stop.
---

# Follow-up sequence

A lead who didn't reply isn't necessarily a no — but there's a limit to how
many times "just checking in" is worth sending.

## Default cadence (tune per {{companyName}}'s own data; this is a reasonable starting point)

| Touch | Timing after previous | Tone / angle |
|---|---|---|
| 1 (first-touch) | — | See `write-first-touch` |
| 2 | Day 3 | Short bump — add one new, small piece of value or a direct restatement of the ask. Don't repeat the first email verbatim. |
| 3 | Day 7 | Different angle — a relevant stat, a short case study (KB-sourced only), or a different CTA (e.g. offer a shorter format: "quick async question instead of a call?"). |
| 4 (final) | Day 14 | Brief, no-pressure "closing the loop" — explicitly say you'll stop here unless they want to pick it back up, and make re-engaging easy. |

Each touch should be **shorter**, not longer, than the last. If touch 2
takes as many words as touch 1, start over.

## Stop rules — check before drafting every follow-up

Stop the sequence immediately (`crm_set_stage` to `nurture` or
`disqualified` with reason, no further draft) if:

- They replied at all (even a brief "not now") — hand off to
  `handle-reply` instead of continuing the cadence.
- They opted out or asked to stop (see AGENTS.md hard rule — always wins).
- Touch 4 (final) has already gone out with no reply — move to long-term
  `nurture`, don't keep sending "just following up" emails indefinitely.
- Something changed that makes the outreach wrong (e.g. CRM note says the
  company was acquired, contact left the company, email bounced).
- A human paused or reassigned this lead.

## Drafting a follow-up

1. Check the stop rules above first — most of the work is deciding *whether*
   to send, not what to write.
2. Re-read the prior touches so you don't repeat the same angle.
3. Keep it to 2–4 sentences. No "I wanted to follow up on my previous
   email" as the entire content — add something.
4. `outbox_draft_email` with `reason` noting the touch number and cadence
   day (e.g. "Follow-up #3, day 7, no reply to touches 1-2").
5. `crm_add_note` logging the touch regardless of outcome.
