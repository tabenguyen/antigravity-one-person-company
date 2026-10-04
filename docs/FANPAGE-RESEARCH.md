# Fanpage Manager — research notes

Researched 2026-10-04, before building the Fanpage Manager role (the
"Marketer" deferred in Phase 4 because it needed a publishing channel).

Scope of the role:
1. **Scheduled posts**: related news, new features, release announcements, etc.
2. **Comment replies**: answer people who comment on the Page.

---

## 1. Which kind of Meta app

**Create the app with the "Manage everything on your Page" use case**
(Pages API), sign in with **Facebook Login for Business**, and link the app
to the company's **Business portfolio**. The current App Dashboard asks you
to choose a *use case* first. The old "app type" picker (Business /
Consumer / ...) only appears in legacy flows, and in that flow the equivalent
choice is **Business**.

The use case adds `business_management`, `pages_show_list` and
`public_profile` by default. Add these yourself:

| Permission | Why we need it |
|---|---|
| `pages_manage_posts` | create, schedule and edit Page posts (pulls in `pages_read_engagement` + `pages_show_list`) |
| `pages_read_engagement` | read posts, comments and reactions on the Page |
| `pages_manage_engagement` | reply to, hide and delete comments |
| `pages_read_user_content` | read user-generated content (visitor posts, comments) |
| `pages_manage_metadata` | subscribe the Page to webhooks (`/{page-id}/subscribed_apps`) |
| `pages_messaging` *(optional, later)* | private reply in Messenger to a commenter |

### Access level: we probably don't need App Review

Meta has two access levels:

- **Standard Access** is approved automatically for every permission with
  **no App Review**, and it **works in Live mode**. The catch is that it only
  applies to users who have a role on the app (Admin / Developer / Tester).
- **Advanced Access** works for any user. It needs App Review and
  **Business Verification**.

The owner of the company is an app Admin and also an admin of the Page. So
**Standard Access is enough to post and moderate on our own Page.** App
Review and Advanced Access only become necessary when we manage Pages for
people with no role on the app, which is the multi-tenant case in Phase 5.

### Token for the daemon

The daemon runs without anyone signed in, so it needs a token that does not
expire:

- **Preferred: a System User token** from the Business portfolio. It never
  expires. Assign the Page and the app to the system user. Because it acts
  as a system user, it needs `business_management`.
- **Fallback:** a Page token derived from a long-lived user token. It
  doesn't expire on a timer, but it stops working if the admin changes their
  password or loses their Page role.

Never put the token in a query string. Send it in the
`Authorization: Bearer` header, and keep it in the same secrets store as the
IMAP credentials.

---

## 2. API surface we'd use

**Posts**
- `POST /{page-id}/feed` takes `message`, `link`, `published`,
  `scheduled_publish_time`. Photos go to `POST /{page-id}/photos`.
- To schedule a post, send `published=false` with `scheduled_publish_time`
  (a UNIX timestamp **10 minutes to 75 days** in the future).
- A post sent with `published=false` and **no** schedule time is an
  **unpublished post**. It behaves like a normal post except that it never
  shows in `/feed`, so it's useful for a preview (see §3).
- To list scheduled or unpublished posts, read `/{page-id}/feed` with the
  `is_published` field (or use `/{page-id}/scheduled_posts`).
- Scheduled posts also show up in the Meta Business Suite planner. A human
  can see them there and cancel them before they go live, which gives us a
  last-chance review outside our own UI.

**Comments**
- Read: `GET /{object-id}/comments`
- Reply: `POST /{comment-id}/comments` (`pages_manage_engagement`)
- Hide: `POST /{comment-id}?is_hidden=true`. Delete: `DELETE /{comment-id}`
- Real-time: subscribe the Page with
  `POST /{page-id}/subscribed_apps?subscribed_fields=feed` and handle the
  `feed` webhook (`item=comment`). This needs a public HTTPS endpoint and
  SHA-256 signature checks.
- Without a public endpoint: poll `/{page-id}/feed?fields=comments{...}` on
  a routine. This fits how the daemon already polls IMAP, so **polling should
  be v1** and webhooks can come later.

---

## 3. Testing privately before anything goes public

### Constraints that shape the plan

- **Development mode:** the app can use every permission, but it can only
  touch data from users who have a role on the app, plus test users and test
  pages.
- **Webhooks in development mode** only deliver test notifications from the
  dashboard, or events created by people who have a role on the app. A
  stranger's comment won't trigger one.
- **Test pages** need a test user, and Meta has temporarily removed the
  ability to create new test users. Unless the app already has some, test
  pages are not available right now.

### Proposed test ladder

This is the same trust ladder the email SDR uses.

| Step | Where | What is real | Who can see it |
|---|---|---|---|
| **L0 Fake provider** | `FakeFacebookProvider` in memory, like `FakeEmailProvider` | nothing; agent evals and lint only | nobody |
| **L1 Sandbox Page** | a new Page we own with no followers and nothing promoting it; app in **dev mode** | Graph API calls, scheduling, real comments from app-role testers (add 1–2 people as *Testers*) | admins and testers; strangers could find it but nothing points them there |
| **L2 Preview on the real Page** | real Fanpage, posts created with `published=false` and no schedule | exactly how the post renders on the real Page | Page admins, through the post link and Business Suite |
| **L3 Shadow run** | real Page. The agent schedules posts **≥ 24 h ahead** and drafts comment replies into the approval queue. A human approves or posts them | everything except autonomous sending | public, after a human approves |
| **L4 Autonomous** | promote by scorecard, same as SDR | everything | public |

Kill switch: the same outbound toggle as email. Add an auto-trip on hidden
or reported replies, or negative reactions.

---

## 4. Things a spike must check

The docs don't answer these. Check them with Graph API Explorer on the
sandbox Page before writing the provider:

1. **Development mode, real Page:** can the app read comments from strangers
   (non-role users)? Does the `from` (name/id) field come back, or is it
   stripped?
2. **Live mode, Standard Access:** do `feed` webhooks arrive for a
   stranger's comment? Some third-party guides say comment webhooks need
   Advanced Access. If they do, polling is the only option without App
   Review.
3. **System user setup:** can we get a system-user Page token with
   `pages_manage_posts` and `pages_manage_engagement` without Business
   Verification?
4. **Unpublished post preview:** can an admin open an unpublished post by
   permalink, and does it render link previews and images the way a
   published post does?
5. **Sandbox Page visibility:** the New Pages Experience may no longer have
   "unpublish Page". Check what visibility settings a new Page has today.

---

## Sources

- Pages API overview: https://developers.facebook.com/documentation/pages-api
- Create an app ("Manage everything on your Page"): https://developers.facebook.com/documentation/pages-api/create-an-app
- Page feed (publishing, scheduling, unpublished): https://developers.facebook.com/docs/graph-api/reference/page/feed/
- Access levels (standard vs advanced): https://developers.facebook.com/docs/graph-api/overview/access-levels
- Webhooks (dev-mode notifications): https://developers.facebook.com/docs/graph-api/webhooks
- Webhooks for Pages: https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-pages
- Test pages: https://developers.facebook.com/documentation/development/build-and-test/test-pages
- Test users (creation paused): https://developers.facebook.com/docs/development/build-and-test/test-users
