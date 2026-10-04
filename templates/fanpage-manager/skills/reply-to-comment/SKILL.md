---
name: reply-to-comment
description: >-
  Use when a visitor comments on the Page: classify the comment, answer
  questions from the knowledge base, thank praise, escalate complaints and
  price/refund questions, and decide when to say nothing.
---

# Reply to a comment

## 1. Read it properly

The comment, the post it is under and, if it is a thread reply, the comment
above it. The language of the comment is the language of your reply.

## 2. Classify (one class)

`question`, `praise`, `complaint`, `spam`, `sales_lead`, `off_topic`. Table and
precedence in the `comment-handling` rule. Spam has its own skill
(`moderate-spam`), sales leads `hand-off`.

## 3. Questions

1. `kb_search` with the commenter's own keywords (Vietnamese, then English
   product terms if nothing is found).
2. Answer only what the results say, in 1-3 sentences, in their language. Add
   the one link the KB gives for it, if any.
3. **Prices:** only a published price from `kb_search`, quoted exactly and only
   for the plan asked about. Anything custom (a quote, a volume, "cho doanh
   nghiệp", a comparison, a calculation): don't answer in public; if it is a
   buying signal it is a sales lead, otherwise `needs_human`.
4. Not in the KB: do not guess and do not say "chắc là". `needs_human` with the
   question and what was searched in `summary`. A reply is optional: "Bên mình
   sẽ kiểm tra và phản hồi bạn sớm nhé" is allowed only if it contains no
   timeframe and no promise of an outcome.

## 4. Praise

One warm line that is not generic every time, no new claims, no sales pitch.
"Cảm ơn bạn đã tin dùng!" is enough. Skip it for pure emoji or "ok".

## 5. Complaints and anything about money

`needs_human`. Put the detail a human needs in `summary`: what they say in
their own words, what they ask for, urgency (`high` for legal words, public
threats, "lừa đảo", repeated failures). Optionally one neutral holding reply
(see `comment-handling`); never apologise for a fact you can't verify, never
promise.

If the commenter says they already use or pay for the product and `handoff`
names an Account Manager, also create the hand-off task described in the
`hand-off` skill.

## 6. Draft once

`fb_draft_reply` with `commentId` exactly as given, `message` and a one-line
`reason` (which KB document answered it, or "holding reply for complaint").
Read the tool's answer: saved means done, don't draft again.

## 7. Finish

`data: { classification, action }` plus `escalationReason` / `urgency` for
escalations. `summary`: who said what in one line and what you did, so a human
reads it without opening the thread.
