# Task: research and qualify a lead

Research this lead, then qualify it.

- Contact: {{contactName}} <{{contactEmail}}>
- Company: {{leadCompanyName}} ({{leadCompanyDomain}})
- Context from inbound event / assignment: {{context}}

Follow the `research-lead` skill to gather and log what's known, then the
`qualify-lead` skill to produce an ICP fit decision and, if it passes, a
BANT-lite score with reasoning. Log everything to the CRM as you go.

If the lead passes, hand off the outreach: `task_create` with kind
`sdr.first_touch` and input `{ contactName, contactEmail, leadCompanyName,
qualificationSummary, bantScore }`. Don't set `followUp` — nobody has been
contacted yet.

If the lead fails ICP fit **but the context above is a message they sent us
with a concrete question or request** (e.g. "how do I get X", "do you support
Y"), don't leave them unanswered when the knowledge base answers it:

- `kb_search` for their question. Only if the results directly answer it
  (e.g. a free tool or self-serve option the knowledge base says is enough
  for needs like theirs, or a plain "not supported today"), draft **one**
  short reply with `outbox_draft_email` to {{contactEmail}}: answer the
  question in their language using only what the knowledge base says, with
  the exact link if it gives one, and no sales pitch, paid plan, price, or
  meeting request. Subject: "Re: " plus their own subject when the context
  above starts with the subject of an email they sent us; for a lead list or
  anything else with no message from them, a short plain subject with no
  "Re:". Log the reply in the CRM.
- If the knowledge base doesn't answer it, or the context is not a message
  from them (e.g. a lead list or research assignment), draft nothing — never
  send a "sorry, you're not a fit" email.

Either way the lead stays `disqualified` and no `sdr.first_touch` is created.

Finish by calling `finish` with the structured task result:
- `status: "done"` if you completed research and qualification (even if the
  result is "disqualify" — that's a completed, useful outcome).
- `status: "needs_human"` if you couldn't find enough to qualify confidently
  and a human should look at it.
- `data` should include `{ fit: "pass" | "fail", bantScore, recommendation }`
  when qualification ran, plus `answeredQuestion: true` if you drafted a
  reply to a disqualified lead's question.
