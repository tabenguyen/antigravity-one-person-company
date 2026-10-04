---
name: hand-off
description: >-
  Use when a comment is a sales lead (hand to the SDR) or a complaint from
  someone who says they are already a customer (also tell the Account
  Manager): the public reply, the exact task to create and what to put in it.
---

# Hand a comment to a teammate

The task input has `handoff: { sdrAgentId, amAgentId }`. A value is an agent id
or `null` (no active agent set up). Facebook does not give you an email
address: say so in the hand-off, never invent one.

## Sales lead -> SDR

A sales lead is a visitor who wants to buy, asks for a quote or a consultation,
or asks how to contact sales.

1. Public reply with `fb_draft_reply`: thank them, invite them to send the Page
   a private message, no price, no promise, no link unless the KB gives the
   contact link.
   ("Cảm ơn bạn quan tâm! Bạn nhắn tin riêng cho page để bên mình tư vấn gói phù hợp nhé.")
2. If `handoff.sdrAgentId` is not null: `task_create` once with
   `assigneeAgentId` = that id, kind `sdr.research_lead`, a title like
   "Facebook lead: <name>", and input:
   `{ "contactName": "<commenter name or '(không rõ)'>", "contactEmail": "(không có email: khách bình luận trên Facebook)", "leadCompanyName": "(chưa rõ)", "leadCompanyDomain": "(chưa rõ)", "context": "Bình luận trên Facebook Page: <the comment, quoted>. Bài viết: <post text, short>. Chưa có thông tin liên hệ; cần xin qua tin nhắn riêng." }`.
3. If `handoff.sdrAgentId` is null: finish `needs_human` with the lead in the
   summary instead.
4. Finish `done`, `data: { classification: "sales_lead", action: "handed_off", handedOffTo: "<id or none>" }`.

## Complaint from an existing customer -> human (+ Account Manager)

Complaints are always `needs_human` (see `comment-handling`). If the commenter
says they already use or pay for the product and `handoff.amAgentId` is not
null, also `task_create` once with `assigneeAgentId` = that id, kind
`am.handle_message`, title "Facebook complaint: <name>", and input:
`{ "contactName": "<name>", "contactEmail": "(không có email: bình luận trên Facebook)", "subject": "Bình luận trên Facebook Page", "replyBody": "<the comment, quoted>", "threadSummary": "Bình luận công khai trên Facebook Page, chưa có thông tin liên hệ.", "inboundEventId": "facebook:<commentId>" }`.
Then finish `needs_human` as usual; the human still decides everything.

## Rules

- One `task_create` per comment. If it fails, say so in the summary; don't retry
  with another title or kind.
- Never put a price, a promise or the commenter's private data into the task
  beyond what the comment itself says.
- Don't set `followUp`.
