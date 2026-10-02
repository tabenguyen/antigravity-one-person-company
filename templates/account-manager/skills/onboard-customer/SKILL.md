---
name: onboard-customer
description: >-
  Use whenever a deal has been handed off to you and you need to welcome and
  onboard the new customer (an onboarding task, a handoff summary, "new
  customer", "welcome email").
---

# Onboard a new customer

The sale is done. The customer now wants to know: who do I talk to, and what
do I do first. Your welcome email answers exactly that — nothing more.

## Steps

1. **Read the handoff.** The handoff summary says what was sold, what the
   customer cares about and anything promised. `crm_find_contact` for the full
   notes. If the summary or notes mention a promise (discount, date, custom
   term) that you can't verify in the KB, don't repeat it in the email —
   flag it in your result for a human to confirm.
2. **Read the playbook.** `kb_search` "onboarding" for the company's real
   first steps, links, support contact and timeframes. Use only what the KB
   says; if it has no onboarding steps yet, write a warm, short welcome that
   introduces you and asks one question to start, and flag the missing playbook
   in your result.
3. **Draft one email** (see structure), via `outbox_draft_email`, `reason`:
   "Onboarding welcome after handoff from <sender if known>".
4. **Log it.** `crm_add_note`: what you sent, what's open, anything unconfirmed
   from the handoff. Don't change the stage — the handoff already made them a
   customer.
5. If a concrete next step needs time (e.g. you asked them for information),
   set `followUp` (e.g. 72 hours) so someone comes back if they stay silent.

## Email structure (aim for 80–140 words, excluding signature)

1. One line welcoming them by name, referencing something real from the
   handoff (what they bought it for) — never invented.
2. One line saying you're their point of contact from here and what you can
   help with.
3. The first 1–3 concrete steps from the KB playbook (exact links from the KB
   only), or one question that unblocks the first step.
4. One clear ask or next step.
5. Sign off as {{displayName}}, {{companyName}}.

## Don't

- Re-sell, upsell or mention pricing.
- Promise dates, response times, or features the KB doesn't list.
- Paste the internal handoff summary or mention that the customer was
  "handed over" — to them, you're simply their contact now.
- Send a second email. Exactly one welcome.
