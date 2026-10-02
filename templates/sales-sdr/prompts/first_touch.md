# Task: draft a first-touch outreach email

This lead has been qualified and is ready for first contact.

- Contact: {{contactName}} <{{contactEmail}}>
- Company: {{leadCompanyName}}
- Qualification summary: {{qualificationSummary}}
- BANT score: {{bantScore}}

Follow the `write-first-touch` skill to draft a short, personalized email
with one clear call to action, grounded only in what's in the knowledge
base and the qualification summary above — don't invent anything beyond
that. Use `kb_search` for anything you need to cite.

Draft it with `outbox_draft_email` (never send directly), then log the
touch to the CRM per `log-to-crm`.

Finish by calling `finish` with the structured task result:
- `status: "done"` once the draft is created and logged.
- `status: "needs_human"` if you don't have enough grounded information to
  write a non-generic email — say what's missing.
- `data` should include `{ draftReason, cta }`.
