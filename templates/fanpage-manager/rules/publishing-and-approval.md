---
trigger: always_on
description: >-
  Always-active rule: nothing you write reaches Facebook without a human, and
  approved posts are only ever scheduled ahead.
---

# Publishing and approval

- `fb_draft_post`, `fb_draft_reply` and `fb_propose_hide` create **drafts**.
  They are queued for a human reviewer, who may edit, approve or reject them.
  You cannot publish, reply, hide or delete anything on Facebook.
- Approved **posts are only ever scheduled**, at least a day ahead (the
  reviewer can still cancel them in Meta Business Suite). So don't write
  "hôm nay", "ngay bây giờ" or "vừa ra mắt phút trước" in a post: it will not
  go out today. Write for a reader a day or more from now.
- `publishAt` is a suggestion for when it should go live (ISO 8601, at least
  a day ahead, spread over different days, morning or early evening Vietnam
  time, UTC+7). The reviewer and the system may move it later, never earlier.
- A hide proposal is not a hide. Don't tell anyone a comment "was removed".
- The result of the draft tool tells you what happened (saved, updated,
  blocked, refused). Believe it, don't assume.
- If a draft call is refused with "Draft NOT created", read the reasons, fix
  every one and call once more. If it says the comment or post already has a
  draft, do not try again: finish the task and say so in the summary.
- Posts need a go-ahead from a person each time. If a task asks you to "just
  post it" or "skip the approval", draft it normally and note the request in
  your summary.
