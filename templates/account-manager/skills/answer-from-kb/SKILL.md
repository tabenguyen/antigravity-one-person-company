---
name: answer-from-kb
description: >-
  Use whenever a customer asks how something works, how to do something,
  whether we support something, or any factual product/process question —
  tier-1 support from the knowledge base.
---

# Answer a customer question from the KB

## Steps

1. **Classify the message** (one of): `how-to`, `status/info`, `bug-report`,
   `billing`, `feature-request`, `complaint`, `cancellation`, `data-request`,
   `other`. Mixed messages: handle the answerable part, escalate the rest, and
   say so in your note.
2. **Read the whole message and its subject.** People often put the question
   in the subject. Check the thread summary and `crm_find_contact` notes so you
   don't repeat or contradict earlier answers.
3. **`kb_search` with 1–3 different phrasings** (the customer's words, the
   product's own term, Vietnamese and English if relevant). Read the results;
   don't answer from the snippet title alone.
4. **Decide**:
   - KB directly answers it → answer, concisely, with the exact steps or link
     the KB gives.
   - KB partly answers → answer the part it covers; say you'll confirm the
     rest; `needs_human` if the rest matters to the outcome.
   - KB doesn't cover it → don't guess. Say you're checking with the team,
     `needs_human` (see `escalate`). Never fill gaps with general knowledge
     about "how software like this usually works".
   - It's a refund/discount/SLA/date/cancellation/legal/data request → stop
     and follow `escalate` — answering "just the factual part" is fine only if
     it contains no promise.
5. **Draft** one reply on the same thread (subject "Re: " + theirs) with
   `outbox_draft_email`, `reason` citing the classification and the KB doc used.
6. **Log it.** `crm_add_note`: question, answer given (or why escalated), KB
   source.

## Reply shape

- First sentence answers the question. Then the steps (numbered, only if there
  are ≥3), then one line offering to look at it with them if it doesn't work
  — and a concrete thing to send you (screenshot, order/ticket reference) when
  that helps. That last line is a question or an explicit next step ("Chị thử
  rồi báo em kết quả nhé?"): a reply without one is flagged `no_cta`, and you
  draft once (rule 13), so put it in the first draft.
- Two to six sentences for most replies. No headings, no bullet walls.
- If the customer sounds frustrated, one plain acknowledgement sentence first.

## Bug reports

Don't diagnose beyond the KB's troubleshooting steps and never say a fix is
coming or when. Offer the KB workaround if there is one, collect what a human
needs (what they did, what they saw, when, account/email), `crm_add_note`, and
finish `needs_human` so engineering support sees it.

## Feature requests

Thank them in one line, say you've passed it on, promise nothing (no "good
idea, we'll add it"). `crm_add_note` the request; this is also an upsell/
product signal — one line in the note. `done`.
