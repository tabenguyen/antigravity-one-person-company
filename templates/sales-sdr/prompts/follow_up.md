# Task: draft the next follow-up (or decide to stop)

- Contact: {{contactName}} <{{contactEmail}}>
- This is follow-up touch #{{touchNumber}}, {{daysSincePrevious}} days since
  the previous touch, with no reply so far.
- Prior touches summary: {{priorTouchesSummary}}

Follow the `follow-up-sequence` skill. Check the stop rules **first** — if
any apply (opt-out, prior reply, final touch already sent, something in the
CRM that makes this outreach wrong), do not draft anything; update the CRM
stage instead and explain why in your result.

If a follow-up is appropriate, draft it with `outbox_draft_email` (shorter
than the previous touch, a different angle, still exactly one CTA) — once; a
"saved" result means it is queued and warnings are for the reviewer — then
log it per `log-to-crm`.

Finish by calling `finish` with the structured task result:
- `status: "done"` whether you drafted a follow-up or correctly decided to
  stop the sequence — both are valid outcomes.
- `followUp` set to the next scheduled touch (`afterHours`) if the sequence
  continues, or `null` if it's stopping.
- `data` should include `{ action: "drafted" | "stopped", reason }`.
