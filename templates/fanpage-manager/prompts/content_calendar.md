# Task: plan the Page's posts for {{weekStart}} to {{weekEnd}}

- Routine: {{routineName}}
- Posts to plan: {{postsPerWeek}}
- Allowed post types: {{postTypes}}
- Already scheduled on Facebook (do not duplicate): {{scheduled}}
- Drafts already waiting for a human (do not duplicate): {{pendingDrafts}}
- Recently published (avoid repeating): {{recent}}

Follow the `plan-content-calendar` skill. In short: `kb_search` for what the
company can truthfully talk about (new features, recent releases, how-to
tips); pick up to {{postsPerWeek}} distinct topics from the allowed types that
are not already covered above; for each, create ONE task with `task_create`:
kind `fanpage.draft_post`, a short title, and input
`{ "postType": "<type>", "topic": "<what to write about, naming the KB
document>", "publishAt": "<ISO 8601 time inside the window, spread over
different days, morning or early evening Vietnam time (UTC+7)>" }`.

Rules: never plan a `news` post (it needs a human-supplied source URL); never
plan a topic the knowledge base has nothing about; never draft a post
yourself in this task (don't call `fb_draft_post`); never create more than
{{postsPerWeek}} tasks; if there is nothing sourced to write about, create
none and say so.

Finish by calling `finish` with the structured task result:
- `status: "done"` with `data: { planned: [{ postType, topic, publishAt }] }`
  (an empty list is a valid, honest answer).
- `status: "needs_human"` only if the knowledge base is empty or looks like
  unfilled template text.
