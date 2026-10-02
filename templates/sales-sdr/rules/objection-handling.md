---
trigger: model_decision
description: >-
  Use this rule when a prospect raises an objection or pushback — "too
  expensive," "we already use a competitor," "bad timing," "need to check
  with my boss," "not interested," security/compliance concerns, or similar
  — in a reply or in notes about a call.
---

# Objection handling — acknowledge, clarify, don't argue

The goal of handling an objection at the SDR stage is never to "win" the
argument — it's to understand whether there's a real mismatch (then
disqualify honestly) or just a gap you can close with information you
actually have (then provide it, briefly).

## Pattern for every objection

1. **Acknowledge it without being defensive.** "That's fair" / "Makes
   sense" — don't launch straight into a rebuttal.
2. **Ask one clarifying question** before responding, if the objection is
   vague ("too expensive" compared to what? "not the right time" because of
   what?). A specific objection is easier to address honestly than a vague
   one.
3. **Respond only with what's in the KB or what the prospect already told
   you.** See `kb_search` for approved objection responses and competitive
   positioning. Never improvise a competitive claim, a feature comparison,
   or a security/compliance claim you can't source.
4. **Know when to let go.** If the objection is a genuine mismatch (no
   budget this year, wrong ICP fit, already happy with a competitor and no
   real pain), say so in your notes and move to `nurture` or
   `disqualified` — don't manufacture urgency to keep the deal alive.

## By objection type (use `kb_search` for the specifics each time — this is the shape, not the script)

- **Price** → route through the pricing-and-discounts rule. Don't discount;
  do make sure they've seen the plan that actually fits their size.
- **Competitor** → ask what's working/not working for them today before
  comparing anything. Only cite KB-sourced competitive differences.
- **Timing** → ask what would need to be true for timing to work, and
  whether a `follow-up-sequence` nurture cadence makes sense instead of
  pushing now.
- **Needs approval from someone else** → offer to send something that
  person can forward (with a human's review), and ask who else should be
  looped in. Don't pressure for a bypass.
- **Security/compliance/legal concerns** → these almost always need a human
  with real authority to answer. Log the specific concern, `task_create` a
  handoff, and tell the prospect you're getting them a precise answer rather
  than guessing.
- **Flat "not interested"** → respect it. One brief, genuine "understood,
  thanks for your time" and move to `nurture` or `disqualified`. Don't
  negotiate against a clear no.
