---
name: check-in
description: >-
  Use whenever asked to do a proactive check-in with a customer — adoption
  check, renewal heads-up, or "haven't heard from them in a while".
---

# Proactive check-in

A check-in that adds nothing is noise. Send one only when you have a real,
specific reason and something useful to offer or ask.

## Decide first: send or not

Don't draft (finish `done`, say why in `summary`, add a note) if:

- the customer opted out, asked not to be contacted, or a note says to leave
  them alone;
- a human is already handling something with them, or there's an open
  escalation on the thread;
- they wrote in within the last few days (they're not silent — a reply is
  being handled);
- you can't say in one sentence what the check-in is *for*.

## If you send

1. `crm_find_contact`: stage, notes, what they bought it for, issues so far.
   `kb_search` for relevant adoption tips or the renewal process.
2. **Pick one angle** matching the task's `reason`:
   - *adoption*: one useful tip or resource from the KB aimed at what they
     bought it for, and one question ("how is X going?").
   - *renewal*: a plain heads-up that renewal is coming and one question about
     what would help. **No price, no renewal amount, no terms, no offer** —
     those come from a human or the KB verbatim.
   - *quiet account*: a short human "how are things going / anything we can do
     better?" with one easy way to reply.
3. **Draft** 40–90 words, one question, via `outbox_draft_email`, reason
   naming the check-in type. New subject (no "Re:") unless continuing a real
   thread.
4. `crm_add_note`. Set `followUp` (e.g. ~7 days) if a reply is expected;
   `null` otherwise. Don't send a second check-in in a row without a reply —
   escalate to `needs_human` instead.

## Upsell signals

If the customer's own words show a need our KB covers with another plan or
product, don't pitch. Add a note ("Upsell signal: …, their words") and mention
it in your `summary` for a human or the SDR.
