# @agyhq/channels

Email I/O for agy-hq Phase 2: parsing inbound mail into the normalized
`ParsedEmail` shape, heuristically classifying it (auto-reply / bounce /
unsubscribe / spam), stripping quoted history so an agent only sees the new
reply, and sending human-approved drafts. The contract (`EmailProvider`,
`ParsedEmail`, `OutgoingEmail`, `EmailSignals`, ...) lives in
`@agyhq/core`'s `channels.ts` — this package only implements it.

## Public API

```ts
import {
  createEmailProvider,  // (EmailProviderConfig) => EmailProvider | null
  parseRawEmail,         // (raw: Buffer | string, providerId: string) => Promise<ParsedEmail>
  extractReplyText,      // (text: string) => string
  classifyEmail,         // (email, { ourAddresses }) => EmailSignals
  newMessageId,          // (domain: string) => string  — "<ulid>@<domain>", no angle brackets
  normalizeMessageId,    // (id) => string | null — strips "<" ">" and whitespace
  FakeEmailProvider,      // in-memory EmailProvider for daemon tests
  MaildirProvider,        // dev/test EmailProvider backed by a directory tree
  ImapSmtpProvider,       // real-mailbox EmailProvider (IMAP fetch + SMTP send)
} from "@agyhq/channels";
```

### `createEmailProvider(cfg: EmailProviderConfig)`

The daemon's single entry point. `cfg.kind` is `"imap-smtp"`, `"maildir"`, or
`"none"` (returns `null` — no provider configured). See the `EmailProviderConfig`
type for the exact shape of each variant.

### `parseRawEmail(raw, providerId)`

Parses an RFC 822 message (via `mailparser`) into `ParsedEmail`: addresses
lowercased, Message-ID/In-Reply-To/References without angle brackets, `text`
(falls back to HTML→text when there's no plain-text part — mailparser does
this for us), `replyText` (quoted history stripped, see below), a narrow
`headers` subset needed for classification, and attachments (metadata plus
decoded `content`, which the daemon saves to disk rather than the DB). `providerId` is whatever cursor-addressable id the caller has for
this message (an IMAP UID, a maildir filename, ...) — it's opaque to this
function.

### `extractReplyText(text)`

Best-effort removal of quoted history and signatures so an agent only sees
the sender's new words. Recognizes, and cuts at the first of:

- a line starting with `>`
- `On ... wrote:` (English), including the two-line Gmail wrap (`On ...`
  / `wrote:`)
- `Vào ... đã viết:` (Vietnamese), same multi-line handling
- an Outlook `-----Original Message-----` separator, or a plain
  `From:` / `Sent:`(or `Date:`) header block
- a long row of underscores (Outlook Web Access's separator)
- the signature delimiter `-- ` (or bare `--`)

Conservative by design: if cutting would leave nothing, the original text is
returned rather than an empty string.

### `classifyEmail(email, { ourAddresses })`

Pure heuristics over an already-parsed email:

- **`isAutoReply`** — `Auto-Submitted` other than `no`, `X-Autoreply`/
  `X-Autorespond` present (any value), `Precedence: bulk|junk|auto_reply`, or
  an OOO-shaped subject (`Out of Office`, `Automatic reply`, `Auto:`,
  `Trả lời tự động`, `Vắng mặt`).
- **`isBounce`** / **`bouncedRecipient`** — from `mailer-daemon@`/`postmaster@`,
  or `Content-Type: multipart/report`. The bounced address comes from
  `X-Failed-Recipients` first, else a `Final-Recipient:`/`Original-Recipient:`
  line in the DSN body (mailparser folds the `message/delivery-status` MIME
  part into `text`).
- **`isUnsubscribe`** — `replyText` is short (< 400 chars) **and** contains an
  unsubscribe phrase: `unsubscribe`, `remove me`, `stop emailing`, `opt out`/
  `opt-out`, or the Vietnamese `hủy đăng ký`/`huỷ đăng ký`/`ngừng gửi`/
  `không muốn nhận`. Phrases, not the bare word "stop" — a message asking us
  *not* to stop emailing doesn't match.
- **`isLikelySpam`** — `X-Spam-Flag: YES`.

Mail from one of `ourAddresses` is never flagged as bounce or unsubscribe
(e.g. a sent-folder copy we're re-ingesting).

### `newMessageId(domain)` / `normalizeMessageId(id)`

Every Message-ID/In-Reply-To/References value in this package's types is
stored **without** angle brackets; providers add/strip `<>` only at the wire
boundary (nodemailer does this automatically for outgoing mail).

## Providers

### `FakeEmailProvider`

In-memory, for daemon tests. `deliver(msg)` queues an inbound message
(filling in realistic defaults — `providerId`, `messageId`, `date`, and a
`replyText` derived from `text` if you don't pass one) and returns the
`ParsedEmail`. `fetchNew` drains the queue with an index-based cursor.
`send()` records to `.sent` instead of transmitting. `failNextSend(err)`
makes the next `send()` reject once; `setVerify(result)` controls `verify()`.

### `MaildirProvider`

Dev/test provider backed by a plain directory:

- `root/inbox/*.eml` — inbound messages, processed in filename order. Cursor
  is the last processed filename; if that file is gone on the next run
  (deleted externally), it restarts from the top rather than erroring.
- `root/sent/<messageId>.eml` — written by `send()` as a real RFC 822
  message (via nodemailer's `streamTransport`), so Message-ID, In-Reply-To,
  References, and List-Unsubscribe headers are all realistic and parse back
  correctly.

### `ImapSmtpProvider`

IMAP (via `imapflow`) for fetching, SMTP (via `nodemailer`) for sending.

- **Cursor**: `"<uidValidity>:<lastUid>[:<epochSec>]"` (the timestamp = when the mailbox was last fully caught up).
  A `null` cursor starts at the mailbox's **current `UIDNEXT`** (only mail arriving from now on) unless
  `initialSyncDays = N > 0`, which also pulls the last N days (capped by `initialSyncMaxMessages`, default 200).
  If `UIDVALIDITY` changes, mail since the cursor's timestamp is re-scanned (duplicates are dropped by Message-ID at the
  daemon); a legacy cursor without a timestamp restarts from the current `UIDNEXT`. The cursor also advances over runs
  of deleted UIDs, so gaps cannot wedge the poller.
- **Read-only**: mailboxes are opened with `EXAMINE` and messages fetched with `BODY.PEEK[]`; `\Seen` is never set,
  nothing is moved or deleted. IDLE is disabled. `limit` defaults to 50.
- **Sent folder** (`syncSent: true`): `fetchSent()` reads the Sent folder (`sentFolder`, else the `\Sent` special-use
  folder, else `[Gmail]/Sent Mail` / `Sent Items` / `Sent` ...) with the same rules and its own cursor.
- **Errors**: login/connection failures are described with hints (`describeMailError`), never contain passwords, and a
  rejected login is not retried. A failed connect is not cached.
- **Sending** uses nodemailer with the exact Message-ID you pass (wrapped in
  `<>` automatically), `In-Reply-To`, `References`, a `List-Unsubscribe`
  header when `listUnsubscribe` is set, and any extra `headers`. If
  `sentFolder` is set, a copy is appended there over IMAP after a successful
  send (failure to append is logged, not thrown — the send already
  succeeded).
- **`verify()`** checks both IMAP login and SMTP `verify()` and reports which
  one failed.
- The connection is reused across calls, with one reconnect-and-retry on
  failure.
- **Testability**: the constructor takes `createImapClient` and
  `createSmtpTransport` factory functions (both optional, defaulting to real
  `ImapFlow`/`nodemailer`). Tests can inject a hand-written object
  implementing the narrow `ImapClient`/`SmtpTransport` interfaces this
  provider actually uses, or a real nodemailer transport configured with
  `streamTransport`/`jsonTransport` to get realistic, parseable headers
  without a network connection.

### Configuring Gmail

```json
{
  "kind": "imap-smtp",
  "address": "you@yourdomain.com",
  "displayName": "Mai",
  "imap": { "host": "imap.gmail.com", "port": 993, "secure": true, "user": "you@gmail.com", "pass": "<app password>" },
  "smtp": { "host": "smtp.gmail.com", "port": 465, "secure": true, "user": "you@gmail.com", "pass": "<app password>" },
  "sentFolder": null
}
```

Use a Google Account [App Password](https://myaccount.google.com/apppasswords)
(requires 2-Step Verification), not your normal password. `sentFolder` is
`null` because Gmail's SMTP already saves a copy of everything you send to
`[Gmail]/Sent Mail` — appending our own copy would duplicate it. For a
provider where SMTP doesn't do this for you, set `sentFolder` to that
mailbox's name (e.g. `"Sent"`) to keep the mailbox's sent history complete.

## Testing

```sh
npx vitest run packages/channels
```

Fixtures in `test/fixtures/*.eml` cover: a plain English reply with quoted
Gmail history, a Vietnamese reply with `Vào ... đã viết:`, an Outlook-style
reply (`-----Original Message-----` + `From:`/`Sent:` block), English and
Vietnamese out-of-office auto-replies, a DSN bounce with `Final-Recipient`,
English and Vietnamese unsubscribe replies, a long reply that mentions "stop"
but isn't an unsubscribe, an HTML-only message, and a spam-flagged message.

`MaildirProvider` and `ImapSmtpProvider` have round-trip tests: deliver →
fetch → cursor → no duplicates; send → the resulting message parses back with
the right Message-ID/In-Reply-To/References/List-Unsubscribe.
`ImapSmtpProvider`'s IMAP side is tested against a hand-written fake client
(cursor math, the `UIDVALIDITY`-change restart, reconnect-on-failure); its
SMTP side is tested against real `nodemailer` transports
(`streamTransport`/a hand-written object) rather than a real server.

`test/imap-smtp.integration.test.ts` and `test/doctor.test.ts` run the real ImapFlow/nodemailer against in-process IMAP
(`hoodiecrow-imap`) and SMTP (`smtp-server`) protocol servers (`test/support/mail-servers.ts`): login failures, cursor
persistence, UIDVALIDITY change, dropped connections, first-sync policy on a 2,000-message mailbox, Vietnamese
encodings, HTML-only mail, attachments, outbound threading headers, Sent-folder discovery, read-only guarantees.

An opt-in end-to-end test against a **real** mailbox is gated behind
`AGYHQ_EMAIL_TEST=1` plus `AGYHQ_TEST_IMAP_*`/`AGYHQ_TEST_SMTP_*`/
`AGYHQ_TEST_ADDRESS` env vars (see `test/real-email.test.ts` for the full
list) — it's skipped by default and in CI.
