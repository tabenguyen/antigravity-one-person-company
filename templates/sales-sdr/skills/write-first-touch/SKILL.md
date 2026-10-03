---
name: write-first-touch
description: >-
  Use whenever asked to draft a first-touch / cold outreach email to a
  qualified lead who hasn't been contacted before.
---

# Write a first-touch email

Short, personalized, one call to action. The entire point is to earn a
reply, not to explain the whole product.

## Structure (aim for 60–100 words total, excluding signature)

1. **One line that proves you did your homework.** Something specific from
   `research-lead` — not "I noticed you're in e-commerce" (that's not
   specific, that's a filter).
2. **One line connecting that to a real pain point** the product solves —
   from the KB, not invented. Frame it as a question or observation, not a
   pitch.
3. **One line of concrete value** — what changes for them, not a feature
   list. No adjectives doing the work a fact should do.
4. **One clear call to action, as a low-friction question.** You can't see
   anyone's calendar, so never offer days, times or "I'm free…", and don't
   state a call length unless the KB gives one. Ask whether a short call
   would be useful and let them name the time ("Open to a quick call? Reply
   with what works for you."), or point to the meeting link if the KB has
   one.
5. **Sign off as {{displayName}}, {{companyName}}**, with the compliance
   footer (opt-out line) per the compliance rule.

## Example — EXAMPLE ONLY, replace tone/specifics with your company's real voice and offer

> Subject: Overselling across Shopee + your own site?
>
> Hi Linh,
>
> Saw Hanoi Fashion Chain is running 20 stores across Shopee and your own
> site — noticed a few of your SKUs show different stock counts on each.
>
> {{companyName}} syncs inventory across channels in real time, so a sale on
> Shopee can't oversell your own site's stock. One of our customers cut
> overselling incidents to near zero within their first month.
>
> Would a short call be useful to see if it'd help before your next sale
> event? Just reply with a time that works for you.
>
> {{displayName}}, {{companyName}}
> *(Don't want these emails? Just reply "unsubscribe" and I'll stop.)*

## Before drafting, always check

- The KB for anything specific to this prospect's industry/segment that
  makes the email less generic.
- That every factual claim traces to the KB or the prospect's own words —
  no made-up customer names, no rounded-up stats.
- That there's exactly one CTA. Two asks in one email means zero clear asks.

Then `outbox_draft_email` **once** with a `reason` describing why now (e.g.
"BANT 15/20, strong need+timeline signal from research"). A "saved" result
means the draft is queued for the human; warnings in it are notes for the
reviewer, so do not draft again because of them. Redraft only after a
"Draft NOT created" refusal listing `[error]` items.
