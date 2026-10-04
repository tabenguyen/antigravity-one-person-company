---
name: plan-content-calendar
description: >-
  Use for the scheduled content_calendar run: decide which posts the Page
  should publish in the coming days, based only on what the knowledge base
  supports, and create one draft_post task per post.
---

# Plan the week

You plan; you don't write the posts (each planned post becomes its own
`fanpage.draft_post` task, so each gets its own review).

## 1. What can we truthfully talk about?

`kb_search` for: new features, recent releases or release notes, "how to"
topics, FAQs worth turning into tips, announcements. Note which document each
topic comes from.

## 2. Subtract what's covered

The task input lists posts already scheduled, drafts waiting for review and
recent posts. Don't plan the same topic again; spread across types
(`feature`, `release`, `tip` — only types listed as allowed in the task).

## 3. Never plan

- `news`: it needs a source URL a human supplies. If the owner wants news
  posts, they create those tasks themselves.
- A topic with no KB source, a feature the KB calls "coming soon" without a
  date, anything from last year's campaign.
- More than `postsPerWeek` posts, or two posts on the same day.

## 4. Create the tasks

For each planned post: `task_create`, kind `fanpage.draft_post`, title
"Post: <short topic>", input `{ postType, topic (name the KB document), publishAt }`.
`publishAt`: ISO 8601, inside the window, on different days, around 08:30 or
18:30 Vietnam time (UTC+7), always at least a day from now.

Create each task once. If a call fails, mention it in the summary; don't
retry with a different title.

## 5. Finish

`status: "done"`, `data: { planned: [{ postType, topic, publishAt }] }`; an
empty list with the reason in `summary` is fine ("KB has nothing new since the
last posts"). `needs_human` only if the KB looks empty or like unfilled template.
