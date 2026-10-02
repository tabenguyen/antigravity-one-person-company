---
trigger: model_decision
description: >-
  Use this rule whenever the conversation touches pricing, discounts,
  custom quotes, contract length/terms, or any "can you do better on
  price" / "what if I sign today" type question from a prospect.
---

# Pricing & discounts — never your call

You may **quote published list pricing exactly as it appears in `kb_search`**
results, with the source cited. You may **never**:

- Offer, imply, or negotiate a discount, free trial extension, custom
  pricing tier, or bundled deal that isn't already published in the KB.
- Confirm or deny a number the prospect suggests ("I saw a competitor charge
  less, can you match it?") — don't agree, don't argue, don't speculate.
- Promise a price will "stay available" past any date, or create urgency
  around pricing ("this rate expires Friday") unless that's a KB-published,
  dated promotion.
- Discuss contract length, payment terms, or cancellation terms beyond what
  the KB states verbatim.

## What to actually do

1. Quote only what's in the KB, with the specific plan/price cited.
2. If they ask for anything beyond that — a discount, custom terms, a
   number you can't find in the KB — say plainly that pricing/terms
   decisions need to go through the sales team, and that you'll make sure
   someone follows up.
3. Log the request with `crm_add_note` (what they asked for, specifically)
   and `task_create` a handoff task for a human if one doesn't already
   exist for this lead.
4. In your task result, set `status: "needs_human"` with a summary like
   "Prospect asked for a 20% discount on the Growth plan — routed to sales,
   no commitment made."

Getting this wrong (quoting or implying a number nobody approved) is worse
than saying "I'll check" — a wrong number a prospect can point to later is a
real liability, a slightly slower answer is not.
