# Fanpage Manager — contract

Status: built 2026-10-04 against the fake provider only (no Facebook credentials were available; nothing in this
repo has called graph.facebook.com). This file is the shared contract between the channel, backend, template and UI
work. If code and this file disagree, fix one of them in the same change. Background and the Meta app setup:
[FANPAGE-RESEARCH.md](FANPAGE-RESEARCH.md). Role pattern: [PHASE4.md](PHASE4.md).

Scope: a fourth role, **Fanpage Manager** (the "Marketer" deferred in Phase 4), that
1. drafts Page posts (related news, new features, releases, tips) which a human approves and which go out as
   **scheduled** posts, and
2. answers comments on the Page, with spam hidden and complaints, price and refund questions escalated.

Out of scope for v1: webhooks, photos/video, Messenger private replies, ads, editing a published post, multi-Page.

---

## 1. Safety model (the part that must not break)

- **Nothing reaches Facebook without a human approval.** Every Facebook draft is `pending_approval`. Post and hide drafts
  are never auto-approved at any trust tier. Only *comment replies* of an `autonomous`-tier agent may be auto-approved
  (same `autonomousRequiresPriorApproval` rule as email, same scorecard promotion).
- **Approved posts are only ever scheduled**, at `max(proposed publishAt, now + scheduleLeadHours)` (default 24h, min
  1h, max 75 days). The sender never publishes immediately, so a human can still cancel the post in Meta Business Suite
  (or from the Scheduled posts page). `immediate` exists in the provider contract for tests and the doctor only.
- Same gates as email: the **kill switch** (`outboundEnabled`), quiet hours for replies/hides, hourly rate limit, the
  `shadow` tier never sends (approving parks the draft in `held`), draft lint blocks bad drafts at draft time.
- The token only ever travels in the `Authorization: Bearer` header; it is read from an env var, never stored in the
  config file, the DB, audit rows or error messages (`scrubSecrets`).
- Comment text is untrusted data (prompt injection): the agent has no web tools, and a comment can never change policy.

## 2. Domain changes (`@agyhq/core`)

- `AgentRole` gains `"fanpage-manager"`.
- `OutboxChannel` gains `"facebook_post" | "facebook_reply" | "facebook_hide"`. `OutboxItem.payload: OutboxPayload | null`
  (`null` for email) carries the structured parts:
  - post: `{ kind: "post", postType, link, sourceUrl, publishAt, scheduledPublishTime?, fbPostId? }`
  - reply: `{ kind: "reply", commentId, postId, commentText, commenterName, fbReplyId? }`
  - hide: `{ kind: "hide", commentId, postId, commentText, commenterName, reason }`

  `to` is `fb:page:<pageId>` / `fb:comment:<commentId>` / `fb:hide:<commentId>`; `subject` a short label; `body` the post
  or reply text (the reason for a hide).
- `HqSettings.defaultFanpageAgentId` (default `null`): receives new comments.
- `RoutineKind` gains `content_calendar` and `comment_poll`.
- New audit kinds: `facebook.comment_received`, `facebook.post_scheduled`, `facebook.replied`, `facebook.hidden`,
  `facebook.scheduled_cancelled`, `facebook.preview_created`.
- Channel contract (`channels.ts`): `FacebookPageProvider`, `FbPost`, `FbComment` (`from` is **optional**),
  `OutgoingFbPost` (`mode: immediate | scheduled | preview`), `OutgoingFbReply`, `FbInspection`, and the stored shapes
  `FbPostRecord`, `FbCommentRecord`, `FbReplyRecord`.

## 3. Channel (`@agyhq/channels`)

- `FakeFacebookProvider`: in memory (`addPost`, `addComment`, scheduled/replied/hidden inspection, one-shot failures).
  A reply it accepts appears in the next fetch as a comment written by the Page, like on Facebook.
- `GraphApiFacebookProvider`: `fetch` against `https://graph.facebook.com/<apiVersion>/...`.
  Token in the `Authorization` header only; `POST /{page}/feed` (message, link, `published=false`,
  `scheduled_publish_time`), `GET /{page}/scheduled_posts`, `DELETE /{post}`, `POST /{comment}/comments`,
  `POST /{comment}` (`is_hidden=true`), `GET /{page}/feed?fields=...,comments.filter(stream){...}` for polling.
  The 10 minute to 75 day scheduling window is validated client-side (`FacebookScheduleWindowError`). Errors are typed
  (`FacebookError` with `code` auth / permission / rate_limit / schedule_window / not_found / invalid_request / network /
  api, and `transient`), see `facebook-errors.ts`.
- `createFacebookProvider(cfg)` with `kind: "graph" | "fake" | "none"`.
- Polling cursor = ISO time of the newest comment seen. First poll (null cursor) returns no comments and sets the
  cursor to now: connecting a Page never replays its history. Paging uses `paging.cursors.after` on a URL we build, never a
  `paging.next` URL.

## 4. Task kinds and inputs (`templates/fanpage-manager`)

Writes Vietnamese unless the company profile says English only.

| kind | input | does |
|---|---|---|
| `fanpage.draft_post` | `postType` (`news`/`feature`/`release`/`tip`/`other`), `topic`, `sourceUrl?`, `sourceTitle?`, `sourceExcerpt?`, `publishAt?`, `notes?` | Draft **one** post with `fb_draft_post`. `news`: cites the given `sourceUrl`, uses only the given title/excerpt, never invents news (no source URL -> `needs_human`). `feature`/`release`/`tip`: every fact and number from `kb_search`; nothing in the KB -> `needs_human`, no draft. |
| `fanpage.reply_comment` | `commentId`, `postId`, `postText`, `commentText`, `commenterName?`, `commentedAt`, `parentCommentText?`, `handoff: { sdrAgentId, amAgentId }` | Classify (`question` / `praise` / `complaint` / `spam` / `sales_lead` / `off_topic`) and act. Returns `data.classification`, `data.action`. |
| `fanpage.content_calendar` | `routineName`, `weekStart`, `weekEnd`, `postsPerWeek`, `postTypes`, `scheduled: [...]`, `recent: [...]`, `pendingDrafts` | Routine. Plans the week and `task_create`s one `fanpage.draft_post` per slot. Drafts no post itself. |

`reply_comment` rules:

| classification | action |
|---|---|
| `question` | `kb_search`, `fb_draft_reply` with only what the KB says; unanswerable -> `needs_human`. A price is quoted only if `kb_search` returns it and the pricing rule allows it, otherwise escalate. |
| `praise` | one short thank-you reply (or nothing, `done`). |
| `complaint` | no public argument: `needs_human` (urgency in `data.urgency`), at most a short neutral holding reply inviting them to message the Page. Customers who are known: `task_create` for the Account Manager (`handoff.amAgentId`). |
| refund / price disputes | always escalate (`needs_human`), never a public promise. |
| `spam` | `fb_propose_hide` only, no reply. |
| `sales_lead` | short public reply inviting a private message (no price) **and** `task_create` for the SDR (`handoff.sdrAgentId`, kind `sdr.research_lead`; Facebook gives no email, so the SDR gets the context and returns `needs_human` for contact details). |
| `off_topic` | `done`, no reply. |

Fanpage MCP tools: `kb_search, memory_list, memory_propose, crm_find_contact, crm_add_note, task_create,
fb_draft_post, fb_draft_reply, fb_propose_hide`. No `read_url_content` / `search_web` (comments are an injection and
exfiltration vector), no `outbox_draft_email`.

`routing`: none (the role never owns contacts); comments reach it through the poller / `comment_poll`, not the email router.

## 5. Approval and sending flow

```
poller -> fb_comments (dedupe by comment id) -> fanpage.reply_comment task
agent  -> fb_draft_reply | fb_propose_hide | fb_draft_post -> outbox (pending_approval, lint on every draft)
human  -> approve (edit first if needed; the Inbox shows the post / the comment + the reply)
          shadow tier -> held (nothing sent) ; otherwise approved
FacebookSender (gates: kill switch, quiet hours for replies/hides, rate limit, final guard)
          post  -> createPost(mode "scheduled", at max(publishAt, now + lead))  -> sent, fb_posts row, audit facebook.post_scheduled
          reply -> replyToComment -> sent, fb_replies row (the mapping), comment status "replied"
          hide  -> hideComment    -> sent, comment status "hidden"
```

Final guard (checked again right before the call): agent not archived / not shadow; the comment is not already
answered or hidden; the comment was not written by the Page. A transient provider error (rate limit, network) retries
up to 3 attempts; anything else fails the item with the typed message.

Draft rules (`fb_*` tools, `agent-api/fb-draft.ts`): one draft per task per target (a second call rewrites the pending
draft in place, a reviewed one is a `conflict`); one live draft per comment across tasks (`conflict`); the comment must
exist in `fb_comments` and not be ours; a hide and a reply to the same comment cannot both be pending; `news` needs
`sourceUrl` and the message must contain it.

## 6. Duplicate comments, own comments

- `fb_comments.id` (the Facebook comment id) is the primary key: a comment seen again (every poll overlaps by design) is
  one row, and a row gets a task at most once (`task_id` is set in the same transaction that creates the task).
- A comment is skipped (`status: own`, no task) when `from.id` is the Page, **or** its id is a reply we posted
  (`fb_replies.reply_id`). The second rule is why `from` being optional is safe.

## 7. Routines

- `content_calendar` config `{ postsPerWeek: 1..14 = 3, postTypes: PostType[] = ["feature","tip","release"], daysAhead: 1..30 = 7 }`.
  Runs on a cron (default suggestion: Monday 08:00). Snapshot = scheduled/pending posts + the last published posts. Skips
  while the previous `fanpage.content_calendar` is queued/running. `news` slots are never planned by the routine: a news
  post needs a human-supplied source URL (`hq task` / UI "New task").
- `comment_poll` config `{ maxPerRun: 1..100 = 20 }`. Pure db: assigns stored comments that have no task (status `new`) to the
  routine's agent. The network part is the daemon's `FacebookPoller` (config `facebook.pollIntervalMs`, default 120000) which
  fetches, stores, and assigns to `defaultFanpageAgentId` when set; the routine is the scheduled, per-agent sweep for
  everything the poller could not assign. Both use the same `intakeComments()`.

## 8. KPIs and quality

- `roles["fanpage-manager"]`: `{ agents, postsDrafted, postsScheduled, commentsReceived, repliesDrafted, repliesSent, hideProposals, escalations, handoffs }`
  (same windowing and null rules as PHASE4 section 7).
- Draft lint (`quality/fanpage-lint.ts`, errors block at draft time): `news_missing_source`, `unsourced_stat` (percentages and
  counts not in the KB), plus the shared placeholder / `unknown_price` / `forbidden_claim` / `ai_self_reference` rules and
  the AM promise rules (refund, discount, SLA, delivery date) on every reply. Warnings: `fb_reply_too_long`, `fb_too_many_hashtags`.
- Scorecards, promotion criteria and shadow runs apply unchanged (they are per-agent over outbox items).
- Evals: `templates/fanpage-manager/evals` (12 cases: news cites its source, news without a source, release without KB
  facts, release with KB facts, price question, spam hide, complaint, duplicate comment, prompt injection, sales lead to
  the SDR, praise, content calendar). Comments are staged in a `FakeFacebookProvider` and ingested by the real poller, so the
  dedupe and task creation are the production path. Runner additions: optional `contact`, a `facebook` seed
  (`post`, `comments[]` with `repeat` for duplicate delivery), assertions `outbox.count.channel` and `task.total`.

## 9. Config

`agyhq.config.json` (example in `agyhq.config.example.json`):

```json
"facebook": { "kind": "graph", "pageId": "<page id>", "appId": "<app id>", "apiVersion": "v26.0",
              "pollIntervalMs": 120000, "scheduleLeadHours": 24, "lookbackDays": 14, "appMode": "development" }
```

Same pattern as the mailbox passwords (`AGYHQ_IMAP_PASS` / `AGYHQ_SMTP_PASS`): secrets come from the environment and the file
cannot hold them (the `facebook` block is strict, so an `accessToken` / `appSecret` / `token` field is a load error, not silently
ignored).

| Where | What |
|---|---|
| config file `facebook.appId` | the Meta app's id (not secret) |
| env `AGYHQ_FB_PAGE_TOKEN` | the Page (or System User) access token; required for `kind: "graph"`. `facebook.tokenEnv` can name a different variable |
| env `AGYHQ_FB_APP_SECRET` | the app secret; **optional**. When set, `GraphApiFacebookProvider` sends `appsecret_proof` (hex HMAC-SHA256, key = app secret, message = token) on every call, which is what lets you switch on "Require App Secret" in the app dashboard. When it is not set, do not switch that on (every call would be rejected) |

The same secret verifies webhook deliveries later (`verifyWebhookSignature`, header `X-Hub-Signature-256`, in
`@agyhq/channels`); the webhook endpoint itself is not v1. `kind: "fake"` runs everything offline. Default `none`.
`hq facebook doctor` shows `appId`, whether the app secret is set and whether `appsecret_proof` is being sent; it never prints a
token or secret value.

Instead of exporting them in the shell, the env vars can live in `<repoRoot>/.env` (gitignored, `chmod 600`; template
`.env.example`). `hq` loads it at start (`AGYHQ_ENV_FILE` names another file), a variable already set in the shell wins,
`hq serve` logs which names came from the file (never values), and a file readable by other users gets a warning.

## 10. CLI, API, UI

- `hq facebook doctor [--local | --daemon]`: token valid, `/me` Page identity (matches `pageId`), the five permissions, app mode,
  app secret / `appsecret_proof`, safety facts. Works offline with the fake provider. Exit 1 on a failing check.
- `GET /v1/admin/facebook/status`, `GET /v1/admin/facebook/scheduled` (live from the provider, else what we sent),
  `POST /v1/admin/facebook/scheduled/:postId/cancel`, `GET /v1/admin/facebook/comments?status=`,
  `POST /v1/admin/facebook/doctor`, `POST /v1/admin/facebook/preview/:outboxId` (an unpublished preview post).
  `PATCH /v1/admin/outbox/:id` takes `publishAt` for a post draft (the human moves the planned time).
- UI: the Inbox shows a post preview (type, text, link, source, planned time) or the comment with our reply under it;
  "Scheduled posts" page (list + cancel); Settings default Fanpage agent; routine form kinds; Dashboard KPI card.

## Not built (known gaps)

- **Readiness is email-centric.** The go-live checklist still wants a verified mailbox and a sender identity; a
  Facebook-only company has to pass those or force-enable the kill switch. There is no Facebook step in the setup wizard
  (use `hq facebook doctor` and the Facebook page instead).
- **No auto-trip on negative signals** (hidden or reported replies, negative reactions): v1 does not read them. The kill
  switch, the shadow tier and the approval queue are the brakes.
- **Webhooks, photos/video, editing a published post, Messenger private replies, several Pages.**
- **Unpublished preview** exists as `POST /v1/admin/facebook/preview/:outboxId` (it leaves an unpublished post on the Page
  that a human has to delete), with no UI button yet.
- **Real Page untested.** Everything was exercised against `FakeFacebookProvider` and a mocked `fetch`; the Graph request
  shapes follow the research doc and Meta's reference and have to be confirmed on the sandbox Page (L1).

## Pending spike (open questions that would change the design)

Each is solved by a design that works under both answers; check them on the sandbox Page and update this section.

1. **Is `from` returned for strangers' comments?** Everything treats `FbComment.from` as optional; own-comment detection
   falls back to the reply mapping. A page admin replying by hand in Business Suite with `from` stripped would create a
   draft (harmless: still needs approval).
2. **Do `feed` webhooks need Advanced Access?** v1 polls, which works either way; add a webhook receiver later as a
   latency optimisation feeding the same `intakeComments()`.
3. **System-user Page token without Business Verification?** Config only names an env var; either token type works.
4. **Do unpublished (preview) posts render like published ones?** `createPost(mode: "preview")` exists; there is no UI
   flow built on it yet.
5. **Sandbox Page visibility settings.** No code depends on it.
6. **Which endpoint lists a Page or system-user token's scopes?** `/me/permissions` is used; if it is not readable for the
   token type the doctor reports the permission check as `warn` ("could not read"), never `pass`.
7. **App mode (development / live) is not exposed by the Graph API as far as we know.** The doctor reports `unknown`
   unless `facebook.appMode` is set in the config, and warns in development mode (strangers' comments may not arrive).
8. **Sales leads have no email.** v1 hands them to the SDR as an `sdr.research_lead` task with the comment as context; the SDR
   is expected to return `needs_human` for contact details. A social-lead task kind for the SDR is the likely follow-up.
