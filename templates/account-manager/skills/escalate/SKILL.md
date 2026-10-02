---
name: escalate
description: >-
  Use whenever a customer message needs a human decision: refund, discount,
  credit, price/contract change, SLA or uptime promise, bug-fix or feature
  date, cancellation, data/legal/security request, a very angry customer, or
  anything you can't answer from the knowledge base.
---

# Escalate to a human — fast, complete, without promising

The goal: a teammate reads your summary once and can act, and the customer
knows someone is on it, with nothing promised.

## Steps

1. **Stop deciding.** Don't weigh whether the request is reasonable. If it is in
   the `commitments-and-escalation` list, it's a human's call.
2. **Collect the facts** a human needs: `crm_find_contact` (stage, notes, past
   escalations), what exactly the customer asks (their words), amounts/dates
   *they* mention (attribute them: "customer says…"), and urgency (deadline,
   anger, legal language, churn language).
3. **`crm_add_note`** (mandatory — never `finish` an escalation without it): the facts above, plainly.
4. **Optional holding reply** (`outbox_draft_email`) per the
   `commitments-and-escalation` rule: acknowledge the specific request, say a
   teammate will reply personally, promise nothing — no outcome, no timeframe,
   no numbers. Skip it when the customer asked about a real person, is making a
   legal threat, or asked to stop emails. Draft it once. When their subject
   itself carries the promise wording ("uptime guarantee", "refund me"), use a
   neutral subject ("Re: Board paper") — the draft check refuses a subject that
   echoes it. Close with a plain line such as "tell me if anything changes on
   your side" so it isn't flagged `no_cta`.
5. **Finish** `status: "needs_human"`; `summary`: "<Customer> (<company>)
   asks <what>. Needs <decision/owner>. <Urgency/anger note>. No commitment
   made." `data`: `{ classification, escalationReason, urgency:
   "low" | "normal" | "high" }`.

## Churn signals

- **Explicit cancellation** ("I'm cancelling", "tôi muốn hủy dịch vụ" — a clear
  decision, not a question): `crm_set_stage` → `churned` with the customer's words as the
  reason, `needs_human`. Don't try to retain with offers.
- **Churn risk** (anger, "thinking of leaving", comparing competitors,
  question about how to cancel): do **not** set `churned`. Note it, mark
  `urgency: "high"`, `needs_human`.
