# Installation guide

From an empty machine to a running company with two AI employees:

1. [Install the service](#1-install-the-service)
2. [Set up the company](#2-set-up-the-company)
3. [Set up the SDR with an SMTP/IMAP mailbox](#3-set-up-the-sdr-with-an-smtpimap-mailbox)
4. [Set up a Facebook Page with the Fanpage agent](#4-set-up-a-facebook-page-with-the-fanpage-agent)

Every agent starts in the **`shadow`** tier and outbound is **off** by default, so nothing is sent to a customer or posted
on Facebook until you turn it on. Deeper references: [TECHNICAL.md](TECHNICAL.md) (all config, CLI, API),
[EMAIL-SETUP.md](EMAIL-SETUP.md) (mailbox details per provider), [FANPAGE.md](FANPAGE.md) (Fanpage Manager contract),
[FANPAGE-RESEARCH.md](FANPAGE-RESEARCH.md) (Meta app background), [SHADOW-RUN.md](SHADOW-RUN.md) (the first two weeks).

---

## 1. Install the service

### Prerequisites

- **Node 20+** (`node --version`)
- **Antigravity CLI (`agy`)**, installed and **logged in** with your Google account. Check: `agy --version`.
  The daemon runs every agent task through this CLI, using your own quota. No API key is needed.
- Git

### Install and build

```bash
git clone https://github.com/tabenguyen/antigravity-one-person-company.git && cd antigravity-one-person-company
```

```bash
npm install && npm run build
```

`npm run build` builds the hooks and the MCP server into `dist/`; the daemon refuses to start without them.

### Configure

```bash
cp agyhq.config.example.json agyhq.config.json
```

```bash
cp .env.example .env && chmod 600 .env
```

- `agyhq.config.json` holds non-secret settings. Every field is optional; set at least `companyName`.
- `.env` holds secrets (mailbox passwords, Facebook token). `hq` loads it at start; a variable already set in the shell
  wins. Never commit it, and never put passwords or tokens in `agyhq.config.json`.

### Run

```bash
npm run hq -- serve
```

Open <http://127.0.0.1:7317> and paste the admin token from `data/admin-token` (created on first run, mode `600`).
Keep the daemon running; run the other `hq` commands below in a second terminal.

Check it is healthy:

```bash
npm run hq -- status
```

> Back up `data/` regularly: it holds the database (`agyhq.db`), `secret.key` and `admin-token`.

---

## 2. Set up the company

Agents only say what the company profile and knowledge base say. Do this before creating any agent.

### Option A: Setup wizard (recommended)

In the web UI, open **Setup** → step **Công ty**:

1. Enter your company domain. A research agent reads ~15 pages of your website and drafts the company profile, ICP,
   sales playbook and objection handling. It also lists **contradictions** (e.g. two different price lists) and
   **open questions**.
2. Read and fix the draft, answer the open questions, then click **Save company profile**. Nothing is stored before that.
3. Step **Kiến thức bán hàng**: remove any remaining placeholders in the knowledge base until the step shows *xong*.

### Option B: CLI

Interactive (prompts for each field):

```bash
npm run hq -- setup company
```

Or from a JSON file. Start from the real example [`examples/nk-invoice/profile.json`](../examples/nk-invoice/profile.json):

```bash
npm run hq -- setup company --file my-company.json
```

Fields: `companyName`, `website?`, `oneLiner`, `productDescription`, `targetCustomers`, `painPoints`,
`differentiators?`, `pricingPolicy`, `proofPoints?`, `forbiddenClaims?`, `meetingLink?`, `languages?`.

Two fields matter most for safety:

- **`pricingPolicy`**: the only prices an agent may quote, and what it must not offer (discounts, custom prices...).
- **`forbiddenClaims`**: things never to say. Every draft is linted against this list before it reaches you.

The profile is rendered into `kb/company/*.md` and the KB is re-synced. After editing files under `kb/` by hand:

```bash
npm run hq -- kb sync
```

---

## 3. Set up the SDR with an SMTP/IMAP mailbox

The SDR ("Mai") reads a mailbox over **IMAP** (read-only: messages are not marked as read, moved or deleted) and sends
approved emails over **SMTP**. Use a dedicated sales address, not a shared inbox full of newsletters: every unknown
sender becomes a lead and a research task.

### 3.1 Prepare the mailbox

Create an **app password** (not your normal login password) and make sure IMAP is enabled.

| | Gmail / Google Workspace | Microsoft 365 / Outlook | Zoho Mail |
|---|---|---|---|
| IMAP | `imap.gmail.com:993`, `secure: true` | `outlook.office365.com:993`, `secure: true` | `imap.zoho.com:993` (or `.eu` / `.in` by region) |
| SMTP | `smtp.gmail.com:465`, `secure: true` | `smtp.office365.com:587`, `secure: false` (STARTTLS) | `smtp.zoho.com:465`, `secure: true` |
| Password | App password (2-step verification on) | Admin must enable **Authenticated SMTP** and IMAP | App-specific password |
| `sentFolder` | `null` | `null` | `"Sent"` if sent mail does not show up |

More providers and limits: [EMAIL-SETUP.md §3](EMAIL-SETUP.md#3-ghi-chú-theo-nhà-cung-cấp).

### 3.2 Configure the mailbox

**Option A: Setup wizard.** Step **Email**: fill in IMAP/SMTP host, port, user and password, then click **Test**. The
password is stored encrypted in `data/`.

**Option B: config file + env.** In `agyhq.config.json`:

```jsonc
"email": {
  "kind": "imap-smtp",
  "address": "sales@yourcompany.com",
  "displayName": "Mai",
  "imap": { "host": "imap.gmail.com", "port": 993, "secure": true, "user": "sales@yourcompany.com" },
  "smtp": { "host": "smtp.gmail.com", "port": 465, "secure": true, "user": "sales@yourcompany.com" },
  "mailbox": "INBOX",
  "sentFolder": null,
  "syncSent": true,          // see replies you send yourself from Gmail/Outlook
  "initialSyncDays": 0,      // 0 = only mail that arrives from now on
  "pollIntervalMs": 60000
},
"sender": {
  "name": "Mai - Your Company",
  "address": "sales@yourcompany.com",
  "companyAddressLine": "Your Company, 123 Main St, City, Country"
},
"unsubscribeMailto": "unsubscribe@yourcompany.com"
```

And in `.env`:

```sh
AGYHQ_IMAP_PASS=your-app-password
AGYHQ_SMTP_PASS=your-app-password
```

Restart `hq serve` after changing the config file.

The `sender` block and `unsubscribeMailto` are required for go-live: they become the email footer and the
`List-Unsubscribe` header (wizard step **Người gửi**).

### 3.3 Check the mailbox

```bash
npm run hq -- email doctor --sample 20
```

Every line should be ✓; read the `!` lines. It logs in to IMAP and SMTP, finds the Sent folder, and shows how the 20
newest messages would be classified and routed, without creating or sending anything. Then send exactly one test email
to yourself:

```bash
npm run hq -- email doctor --send-test you@example.com
```

### 3.4 Create the SDR agent

Wizard step **Agent SDR**, or:

```bash
npm run hq -- agent create sdr-01 --role sales-sdr --display-name Mai
```

The agent starts in the `shadow` tier. Make it the default SDR so new leads and replies go to it:

```bash
npm run hq -- settings set defaultSdrAgentId '"sdr-01"'
```

Optional: a routine that researches new leads every weekday morning:

```bash
npm run hq -- routine create --agent sdr-01 --kind prospecting --name "Morning prospecting" --schedule '0 9 * * 1-5' --config '{"batchSize":5,"stages":["new"]}'
```

### 3.5 Shadow run, then go live

```bash
npm run hq -- readiness
```

```bash
npm run hq -- shadow start
```

For about two weeks Mai only drafts. You approve, edit or reject drafts in **Inbox** (a rejection reason becomes a
memory the agent learns from), and approved drafts are `held`, never sent. Follow [SHADOW-RUN.md](SHADOW-RUN.md) for the
daily routine.

When **Scorecards** says the agent is eligible and `hq readiness` has no ✗:

```bash
npm run hq -- promote sdr-01
```

```bash
npm run hq -- killswitch on --reason "SDR go-live"
```

`assisted` = drafts are sent after you approve them. A later `promote` to `autonomous` lets the SDR send replies on its
own, within the rate limit and quiet hours. `npm run hq -- killswitch off` stops all sending immediately.

---

## 4. Set up a Facebook Page with the Fanpage agent

The Fanpage Manager drafts Page posts (news, features, releases, tips) and answers comments. Approved posts are always
**scheduled** at least `scheduleLeadHours` (default 24h) ahead, so you can still cancel them. Spam is proposed for
hiding; complaints, refunds and price disputes are escalated to you; sales leads are handed to the SDR.

> Status: the Graph API provider has been tested only against a fake provider and mocked requests. Try it on a sandbox
> Page first (§4.6), and see the open questions in [FANPAGE.md](FANPAGE.md#pending-spike-open-questions-that-would-change-the-design).

### 4.1 Optional: try it offline first

Set `"facebook": { "kind": "fake" }` in `agyhq.config.json`, restart, and follow §4.4 onwards. Nothing talks to Facebook.

### 4.2 Create the Meta app

In the [Meta App Dashboard](https://developers.facebook.com/apps):

1. **Create app** → use case **"Manage everything on your Page"** (Pages API). Link it to your company's
   **Business portfolio**. (Legacy flow: app type **Business**.)
2. Add these permissions:

   | Permission | Used for |
   |---|---|
   | `pages_manage_posts` | create and schedule posts |
   | `pages_read_engagement` | read posts and comments |
   | `pages_manage_engagement` | reply to and hide comments |
   | `pages_read_user_content` | read visitors' comments |
   | `pages_manage_metadata` | webhooks (later) |

   **Standard Access** (no App Review) is enough when you are an admin of both the app and the Page.
3. Note the **App ID** and the **App Secret** (Settings → Basic).
4. App mode: **development** while testing. In development mode only people with a role on the app (Admin / Developer /
   Tester) can trigger comments the app sees. Switch to **live** for the real Page.

### 4.3 Get a long-lived token

The daemon runs unattended, so it needs a token that does not expire:

- **Preferred: System User token.** Business Settings → Users → System users → add one, assign it the **Page** and the
  **app**, then *Generate token* with the permissions above plus `business_management`. It never expires.
- **Fallback:** a Page token derived from a long-lived user token. It stops working if the admin changes their password
  or loses their Page role.

Find the **Page ID** on the Page → About → Page transparency (or in Business Suite settings).

### 4.4 Configure

`.env`:

```sh
AGYHQ_FB_PAGE_TOKEN=EAAG...
AGYHQ_FB_APP_SECRET=your-app-secret   # optional; enables appsecret_proof
```

`agyhq.config.json`:

```json
"facebook": {
  "kind": "graph",
  "pageId": "<your Page id>",
  "appId": "<your app id>",
  "apiVersion": "v26.0",
  "pollIntervalMs": 120000,
  "scheduleLeadHours": 24,
  "lookbackDays": 14,
  "appMode": "development"
}
```

Do not put `accessToken` or `appSecret` in this block: the daemon refuses to load the file if you do. Only switch on
**Require App Secret** in the Meta dashboard when `AGYHQ_FB_APP_SECRET` is set, otherwise every call is rejected.

Restart `hq serve`, then check:

```bash
npm run hq -- facebook doctor
```

It verifies the token, that `/me` is the Page you configured, the five permissions, the app mode and `appsecret_proof`.
It never prints the token. Exit code 1 means a check failed.

### 4.5 Create the Fanpage agent

```bash
npm run hq -- agent create fanpage-01 --role fanpage-manager --display-name Lan
```

Make it receive new comments (or use **Settings → default Fanpage agent** in the UI):

```bash
npm run hq -- settings set defaultFanpageAgentId '"fanpage-01"'
```

The daemon polls the Page every `pollIntervalMs`. The first poll only sets a cursor, so the Page's comment history is
never replayed. Add the routines:

```bash
npm run hq -- routine create --agent fanpage-01 --kind content_calendar --name "Weekly content plan" --schedule '0 8 * * 1' --config '{"postsPerWeek":3,"postTypes":["feature","tip","release"],"daysAhead":7}'
```

```bash
npm run hq -- routine create --agent fanpage-01 --kind comment_poll --name "Comment sweep" --schedule '*/30 * * * *' --config '{"maxPerRun":20}'
```

`content_calendar` never plans `news` posts, because a news post needs a source URL from you. Create one by hand:

```bash
npm run hq -- task create --agent fanpage-01 --kind fanpage.draft_post --title "News: ..." --input '{"postType":"news","topic":"...","sourceUrl":"https://...","sourceTitle":"..."}'
```

Feature, release and tip posts take every fact and number from the knowledge base; if the KB has nothing, the agent
asks you instead of inventing.

### 4.6 Review, test and go live

- **Inbox** shows each draft post (type, text, link, source, planned time) or the comment with the proposed reply.
  You can edit the text and move the planned time before approving.
- **Facebook → Scheduled posts** lists what is scheduled and lets you cancel it (you can also cancel in Meta Business
  Suite).

Suggested ladder (from [FANPAGE-RESEARCH.md §3](FANPAGE-RESEARCH.md)):

1. **Fake provider** (§4.1): evals and lint only (`npm run hq -- eval run --suite fanpage-manager --wait`).
2. **Sandbox Page** you own, app in development mode, 1–2 friends added as app *Testers* to leave comments.
3. **Shadow run on the real Page**: `npm run hq -- shadow start`; approvals are `held`, nothing is posted.
4. **Go live**: `npm run hq -- promote fanpage-01`, then the kill switch (shared with email):

```bash
npm run hq -- killswitch on --reason "Fanpage go-live"
```

Posts and hides always need your approval, at every tier. Only comment replies of an `autonomous` agent can go out
without it.

> Known gap: the go-live readiness checks are email-centric. A Facebook-only company still has to pass the mailbox and
> sender checks, or use `hq killswitch on --force` (recorded in the audit log).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `hq serve` says hooks / MCP dist missing | `npm run build` |
| Tasks fail immediately | `agy --version`; log in to Antigravity again; `npm run hq -- quota` |
| `TLS handshake failed` | Port/secure mismatch: 993+`true` (IMAP), 465+`true` or 587+`false` (SMTP) |
| IMAP auth error | Use an app password; enable IMAP; Microsoft 365 needs admin to allow it. agy-hq does not retry bad passwords |
| `killswitch on` refused | `npm run hq -- readiness` and fix every ✗ |
| Facebook doctor: permission `warn` | The token type may not expose `/me/permissions`; check scopes in the token debugger |
| No Facebook comments arrive | App in development mode only sees comments from app-role users; the first poll ignores old comments |
| Config load error on `facebook` | Remove any `accessToken` / `appSecret` / `token` field; put them in `.env` |
