---
name: handle-reply
description: >-
  Use whenever asked to handle, classify, or respond to an inbound reply
  from a lead/prospect to a previous outreach email.
---

# Handle an inbound reply

First classify, then act. Don't skip straight to drafting a response — the
classification determines whether you should draft anything at all.

## Classification → action

| Classification | Signals | Action |
|---|---|---|
| **interested** | Asks for more info, wants a call/demo, asks a product question | `crm_set_stage` → `replied` (then `meeting_booked` once scheduled). Answer product questions using `kb_search` only. If they want to schedule, offer times / ask for theirs — don't invent a calendar link that doesn't exist. |
| **objection** | Pushback on price, timing, competitor, "need approval," etc. | Use the `objection-handling` rule. Don't treat this as a no — respond per that rule's pattern, then re-classify based on what they say next. |
| **not-now** | "Not a priority right now," "check back in a few months," genuine but not urgent | `crm_set_stage` → `nurture`. `task_create` a follow-up for yourself (`afterHours`) at a reasonable interval (e.g. 90 days, or whatever they suggested) — don't just drop it. |
| **unsubscribe** | Any opt-out language, in any language, in any form | Immediate: `crm_set_stage` → `disqualified`, reason = opt-out. No reply drafted at all beyond, if required by policy, a brief automated-style confirmation — check the compliance rule. This overrides every other rule. |
| **out-of-office** | Auto-reply, "I'm away until...", alternate contact given | Don't treat as a real reply. If an alternate contact was given, note it and consider researching them separately — don't just redirect outreach to them without re-qualifying. Otherwise, just note the return date and resume cadence after it (don't count this as a missed-cadence trigger). |
| **wrong-person** | "I'm not the right contact," "please contact X instead," bounced with role-not-found | `crm_add_note` with the correction. If a better contact was named, start `research-lead` on them as a new contact (don't assume they're equally qualified — redo BANT). Update/close out the original contact record appropriately. |
| **referral** | They forward you to a colleague, or ask you to loop someone in | Treat the new person as a new lead: `crm_upsert_contact`, note who referred them and why (a warm referral is a strong signal — reflect that in the new BANT pass). Don't lose the context of why the original contact routed you there. |
| **won** | They clearly confirm they are buying / signing up / becoming a customer ("let's go ahead", "send us the contract", "we'd like to start", "mình đồng ý, bắt đầu thôi") — not just interest, not "maybe" | Stop the sales cadence. Call `contact_handoff({ contactId, toRole: "account-manager", summary })` (get `contactId` from `crm_find_contact`). The `summary` is a crisp handoff for the next person, 3–6 lines: who they are (name, role, company), what they want it for, what they said they will do next, the channel/language they use, and anything **they** asked for or that was discussed but **not agreed** (pricing, discounts, dates — say plainly "nothing agreed"; never record a promise you can't source). Don't draft a reply: the Account Manager welcomes them. If they also asked for price, terms or a contract, that stays a human's call — `needs_human` as well. If the handoff is refused (e.g. no Account Manager set up), don't retry in a loop: log it and finish `needs_human`. |

## Always, regardless of classification

1. `crm_add_note` with the reply's substance and your classification.
2. Update `crm_set_stage` if it changed.
3. If you drafted a response, `outbox_draft_email` **once** with a `reason`
   citing the classification. A "saved" result means it is queued for the
   human; warnings are notes for the reviewer, so don't draft again because
   of them (redraft only after a "Draft NOT created" refusal listing
   `[error]` items). If a conflict says the draft was already reviewed, don't
   retry — finish and say so.
4. Return a task result summarizing the classification and what you did —
   a human scanning task history should understand the whole exchange from
   your summary alone.

If a reply is ambiguous or mixes signals (e.g. an objection plus genuine
interest), say so explicitly rather than forcing one category — qualify
your classification in the CRM note and lean toward the action that keeps
the most options open for the prospect (usually: answer honestly, don't
disqualify on a guess).
