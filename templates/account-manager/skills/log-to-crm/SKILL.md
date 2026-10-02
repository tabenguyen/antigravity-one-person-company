---
name: log-to-crm
description: >-
  Reference for how and when to log activity on a customer in the CRM. Use
  alongside every other skill that touches a customer.
---

# Logging to the CRM

The CRM is how the next person (or agent) understands this customer without
reading transcripts.

## Always log

- **Every inbound message handled**: what they asked, classification, what you
  answered (and the KB source) or why you escalated.
- **Every draft**: tie it to context (onboarding welcome, check-in type, holding
  reply).
- **Every escalation**: the request in the customer's words, the urgency, and
  that nothing was promised.
- **Every commitment found in the handoff or history** that you couldn't verify
  — so a human can confirm it.
- **Upsell/feature-request signals** and **churn-risk signals**, with the
  customer's own words.
- **Every stage change**, with a reason.

## Good notes

Lead with the fact, not the narration: "Customer reports CSV export fails on
files over 5k rows (their words); KB workaround sent" beats "I responded to
their email". Short. Dates as written by the customer. No guesses stated as
facts.

## Stage

Customer lifecycle after the sale: `customer` → `churned` (only on an explicit
cancellation, see `escalate`). `contacted` and `replied` are set by the system —
never set them yourself. Don't move a customer back to a sales stage.
