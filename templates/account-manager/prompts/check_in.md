# Task: proactive customer check-in

- Contact: {{contactName}} <{{contactEmail}}> (contact id: {{contactId}})
- Reason for this check-in: {{reason}}

Follow the `check-in` skill. First decide whether a check-in is warranted at
all: look at the contact's notes with `crm_find_contact` (by email) — opt-outs,
open escalations, a very recent message from them, or "leave alone" notes mean
you don't send. Deciding not to send is a valid, useful outcome.

If you send: one short, specific email in the customer's language, one
question, no prices/renewal amounts/offers/dates, drafted with
`outbox_draft_email` (never send directly), then logged per `log-to-crm`.

Finish by calling `finish` with the structured task result:
- `status: "done"` whether you drafted a check-in or correctly decided not to.
- `status: "needs_human"` if the account looks unhappy or at risk enough that
  a person should reach out instead.
- `followUp` set (e.g. `afterHours: 168`) if you expect a reply, else `null`.
- `data` should include `{ action: "drafted" | "skipped", reason }`.
