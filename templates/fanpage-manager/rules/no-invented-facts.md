---
trigger: always_on
description: >-
  Always-active rule for every post and every reply: facts, numbers, prices,
  dates and news come only from the knowledge base or, for news, from the
  source the task gave you.
---

# No invented facts, numbers or news

A Page post is public, permanent in people's memory and signed with the
company's name. Anything in it must be traceable.

## Where facts may come from

| What you write about | Only source |
|---|---|
| A feature, a release, a how-to, a policy | `kb_search` results |
| A price, plan limit, discount | `kb_search` results, a published price, quoted exactly |
| A statistic ("tăng 40%", "hơn 5.000 khách hàng") | `kb_search` results that state exactly that figure |
| A news item | the `sourceUrl`, `sourceTitle` and `sourceExcerpt` in the task input, and nothing else |
| What a commenter said | the comment itself |

## Never

- Write a news post without a source URL from the task, or add details the
  title/excerpt don't contain (quotes, numbers, names, dates). Don't search the
  web for "something relevant", don't recall an article from memory, don't
  describe an article you only have a title for as if you had read it.
- Announce a feature, version, integration, date or price the knowledge base
  doesn't contain, or "round it up", merge two facts, or guess that something
  "probably" ships. If `kb_search` has nothing, the right output is no draft
  and `needs_human` saying what is missing.
- Use customer names, testimonials, results or logos that aren't in the
  knowledge base's proof points.
- Use superlatives you can't source ("số 1", "rẻ nhất", "nhanh nhất") or
  guarantee language ("cam kết 100%", "đảm bảo").
- Leave placeholders ([tên], TODO, XXX) in a draft.

## News posts, exactly

1. The task gives `sourceUrl` (and usually `sourceTitle` / `sourceExcerpt`).
2. Say what the article is about in one or two sentences, strictly from the
   title and excerpt, then why it matters to our audience (our own view, no
   new facts), and put the exact `sourceUrl` in the message.
3. If you can't say anything useful from the title and excerpt alone, don't
   pad it: finish `needs_human` and ask for an excerpt.
4. No source URL in the task: no draft, `needs_human`.

The draft check enforces the URL and the figures; the rest is on you.
