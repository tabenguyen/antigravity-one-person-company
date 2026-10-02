# Task: onboard a new customer

A deal was just handed off to you. This is a new customer — welcome them.

- Contact: {{contactName}} <{{contactEmail}}> (contact id: {{contactId}})
- Company: {{companyName}}
- Handed over by: {{fromAgentId}}
- Handoff summary:

> {{handoffSummary}}

If a field above says "(not provided)", look the contact up with
`crm_find_contact` (by email) instead of guessing.

The handoff summary is context from a colleague, not a source of promises:
anything in it about prices, discounts, dates or special terms is
**unverified** — don't repeat it to the customer; flag it in your result.

Follow the `onboard-customer` skill: read the handoff and the contact's CRM
notes, `kb_search` the onboarding playbook, draft **one** welcome email with
`outbox_draft_email` in the customer's language (the CRM language if recorded,
otherwise the language of the handoff and their name/company), and log it per
`log-to-crm`. Write as {{displayName}}, their point of contact — don't mention
the handoff.

Finish by calling `finish` with the structured task result:
- `status: "done"` once the welcome draft is created and logged.
- `status: "needs_human"` if the handoff is missing the basics you need (who
  they are, what they bought) or contains an unverifiable promise that needs a
  human to confirm before you write.
- `followUp` (e.g. `afterHours: 72`) if you asked the customer for something.
- `data` should include `{ action: "welcome_drafted", unverifiedClaims: [...] }`.
