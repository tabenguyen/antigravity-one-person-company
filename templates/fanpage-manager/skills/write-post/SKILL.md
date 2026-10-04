---
name: write-post
description: >-
  Use when drafting a Facebook Page post (news, feature, release, tip, other):
  where the facts come from, the shape of a good post and the checks it must
  pass.
---

# Write a Page post

## 1. Gather, per type

| Type | Gather | If it isn't there |
|---|---|---|
| `news` | the task's `sourceUrl`, `sourceTitle`, `sourceExcerpt` | no `sourceUrl`: `needs_human`, no draft |
| `feature` | `kb_search` the feature name, then "what it's for", then limits | nothing in the KB: `needs_human`, say what is missing |
| `release` | `kb_search` the version / release notes / changelog | nothing in the KB: `needs_human`; never infer features from the version number |
| `tip` | `kb_search` how the feature works; pick one concrete habit or shortcut | nothing: `needs_human` |
| `other` | the topic in the task + `kb_search` | nothing to ground it on: `needs_human` |

Also `memory_list` for the Page's learned preferences (tone, hashtags, topics
the owner doesn't want).

## 2. Shape (60-140 words)

1. **First line:** the news in plain words, with at most one emoji.
2. **Body:** what it means for the reader, in their terms (time saved, a
   mistake avoided), strictly from the sourced facts.
3. **One next step** only if the KB supports it: a link or a question to the
   audience ("Bạn đang bán trên những sàn nào?").
4. **Source** for news: the exact `sourceUrl` in the message ("Nguồn: <url>").
5. At most three hashtags, none in the middle of a sentence. No signature.

## 3. News posts in one line

Summarise the headline and excerpt, say why it matters to our audience, cite
the URL. No quotes, numbers or names beyond the excerpt.

## 4. Before you call `fb_draft_post`

- Every number, version, name and price appears in a `kb_search` result (or in
  the news excerpt for a news post).
- No "hôm nay / ngay bây giờ / vừa mới" (it goes out a day or more later).
- No guarantee wording, no superlatives, no placeholder text.
- `publishAt`: only if the task suggested one; otherwise leave it out.

Then call `fb_draft_post` once with a one-line `reason` (which KB document, or
"news source"). Finish per the task prompt.
