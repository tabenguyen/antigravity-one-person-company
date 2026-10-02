# @agyhq/db

SQLite persistence for the agy-hq daemon: agent registry, task queue/state
machine, conversation map, audit log, knowledge base (FTS5), agent memory,
CRM, outbox (full Phase 2 approval/send lifecycle), inbound events, daemon
settings, channel poll cursors, and quota snapshots. Synchronous
(`better-sqlite3`); the daemon is the only writer. No ORM — plain SQL,
hand-mapped snake_case rows ↔ camelCase `@agyhq/core` domain types.

## Usage

```ts
import { openDb } from "@agyhq/db";

const db = openDb("/var/lib/agyhq/state.db"); // or ":memory:" for tests

db.agents.create({
  id: "sdr-01",
  role: "sales-sdr",
  displayName: "SDR One",
  model: "gemini-3-flash",
  workspacePath: "/var/lib/agyhq/workspaces/sdr-01",
  policy: { builtins: ["view_file"], mcp: [{ server: "company", tool: "*" }] },
});

const task = db.tasks.create({ agentId: "sdr-01", kind: "sdr.research_lead", title: "Research Acme" });
const claimed = db.tasks.claimNext(new Date().toISOString()); // atomic; null if nothing claimable

db.close();
```

`openDb(path)` sets `journal_mode = WAL`, `foreign_keys = ON`,
`busy_timeout = 5000`, and runs all pending migrations (tracked in
`schema_migrations`, each applied inside its own transaction — safe to call
repeatedly / on every daemon start).

## Public API

```ts
function openDb(path: string | ":memory:"): Db;

interface Db {
  sqlite: Database.Database; // the raw better-sqlite3 handle, for advanced/debug use
  agents: AgentsRepo;
  agentTokens: AgentTokensRepo;
  tasks: TasksRepo;
  conversations: ConversationsRepo;
  audit: AuditRepo;
  kb: KbRepo;
  memory: MemoryRepo;
  crm: CrmRepo;
  outbox: OutboxRepo;
  quota: QuotaRepo;
  inbound: InboundRepo;
  settings: SettingsRepo;
  channelCursors: ChannelCursorsRepo;
  transaction<T>(fn: () => T): T; // run fn in one SQLite transaction
  close(): void;
}
```

### agents
`create(input)` / `get(id)` / `list({status?, role?})` / `update(id, patch)` /
`setStatus(id, status)`. `policy` (`ToolPolicy`) is stored as JSON.

### agentTokens
`issue(agentId) → plaintext` — generates a random token, stores only its
sha256 hash, and **reissuing replaces (revokes) any previous token** for that
agent (one active token per agent). `verify(agentId, token) → boolean` does a
timing-safe comparison. `revoke(agentId)` also provided for explicit revocation.

### tasks
`create(input)`, `get(id)`, `list({agentId?, status?[], limit?})`.

`transition(id, to, patch?)` validates the move against core's
`canTransition`/`TASK_TRANSITIONS`, throws `TaskTransitionError` if invalid,
updates `updatedAt`, applies `patch` (`result`/`error`/`conversationId`/
`wakeAt`), and appends a `task.transition` audit event.

`claimNext(now)` is the scheduler's only entry point into the queue. In a
single `IMMEDIATE` transaction it picks the **queued** task with the highest
`priority`, then oldest `createdAt`, where: `wakeAt` is null or `<= now`, its
agent is `active`, the agent's current running-task count is below
`maxConcurrency`, and no other **running** task shares its non-null
`threadKey` — marks it `running` (`attempts += 1`) and returns it, or `null`.
Calling it repeatedly (e.g. an idle poll loop) is safe.

`requeue(id, wakeAt)` (backoff helper, `transition(id, "queued", {wakeAt})`),
`listDue(now)` (queued tasks whose `wakeAt` has arrived), `recoverStale()`
(daemon restart: every `running` task — its process is presumed dead — goes
back to `queued`; returns the recovered ids).

### conversations
`get(agentId, threadKey) → conversationId | null`, `set(agentId, threadKey, conversationId)`.

### audit
`append(event)` (id/at auto-filled), `list({agentId?, taskId?, kind?[], since?, limit?})`
newest-first.

### kb
`upsertDocument({scope, title, sourcePath, body})` — identified by
`(scope, sourcePath)`; no-ops (`changed: false`) if the body's sha256 hash and
title are unchanged, otherwise re-chunks and re-indexes. `deleteDocument(id)`,
`listDocuments(scope?)`.

`search(query, scopes, limit) → KbHit[]` uses a standalone FTS5 table
(`kb_fts`, tokenizer `unicode61 remove_diacritics 2`, so `"khach hang"`
matches `"khách hàng"`), filtered to the given scopes, ranked by `bm25()`
(returned as `score = -bm25`, so **higher is more relevant**), with
`snippet()` for the highlighted excerpt.

Chunking (`chunkMarkdown`, exported) is heading-aware: it splits on `#`
headings first, then packs paragraphs up to ~800 chars, carrying a small
(~100 char) tail of the previous chunk forward so a hit near a boundary still
has context.

**Query sanitization**: `sanitizeFtsQuery` (exported) splits the query into
whitespace-separated terms, wraps each in double quotes (escaping embedded
quotes by doubling), and **OR-joins** them. Quoting neutralizes every FTS5
operator/special character (`OR`, `NOT`, `*`, `(`, `^`, `:`, a stray `"`, ...)
so a malformed or adversarial query can't throw or change the query's
meaning. OR (not AND) was chosen for recall: this is a small, short-query KB
(product docs, playbooks) where an AND of every term returns nothing the
moment one word isn't in the matching chunk verbatim — easy to hit with
Vietnamese compounds/synonyms. `bm25` still ranks chunks matching more terms
above single-term matches, so precision comes from ranking, not from
excluding candidates up front.

### memory
`propose(agentId, content, subject?)` (status `pending`),
`list(agentId, {subject?, status?})`, `setStatus(id, status)`.

### crm
- `upsertCompany({name, domain?, ...})` — matches by case-insensitive
  `domain` if given, else case-insensitive `name`; merges attributes.
- `upsertContact({email, ...})` — matches by lowercased `email`; resolves/
  creates the company via `companyName`/`companyDomain` if given. Returns
  `{contact: ContactView, created}`.
- `getContact(id)`, `getCompany(id)`.
- `findContacts({email?, id?, query?})` — exact id/email, or a `LIKE` scan
  over contact name/email and company name for free-text `query`.
- `setStage(contactId, stage, reason, authorAgentId?)` — updates the stage
  and logs a note recording the reason.
- `addNote(subjectType, subjectId, body, authorAgentId?)`,
  `listRecentNotes(subjectType, subjectId, n?)`.
- `contactView(contactId) → ContactView | null` — contact + its company +
  its 5 most recent notes (the shape `McpToolOutputs` expects).

### outbox
`createDraft(input)` (status `pending_approval`, snapshots `originalSubject`/
`originalBody`), `get(id)`, `list({agentId?, status?[], limit?})`,
`listByThreadKey(threadKey, limit?)`, `findByMessageId(messageId)`.

`edit(id, {subject?, body?})` — only while `pending_approval` (throws
`ConflictError` otherwise); sets `editedByHuman`.

`decide(id, to, patch?)` — the one validated status-transition entry point
(checked against core's `OUTBOX_TRANSITIONS`, throws `OutboxTransitionError`
if invalid); `patch` can set `decidedBy`/`decidedAt`/`decisionNote`/
`statusReason`/`messageId`/`inReplyTo`/`sentAt` alongside the move.
`setStatus(id, status)` is a thin back-compat wrapper over `decide`.

`claimNextToSend()` — atomic `approved` → `sending` (oldest `createdAt`
first), or `null`. `recoverSending()` — daemon restart: every item left
`sending` goes back to `approved`; returns the recovered ids.

`markTransientFailure(id, reason)` / `markTerminalFailure(id, reason)` —
`sending` → `approved`/`failed` respectively, bumping `attempts`.
`annotateBounce(id, reason)` — records a bounce DSN against an already-`sent`
item (`statusReason = "bounced: ..."`) without changing its terminal status.

`rejectAllTo(address, decidedBy, reason)` — rejects every
`pending_approval`/`approved` item to `address` (the opt-out path).
`hasHumanApprovedSentTo(address)` — true once a `sent` item to that address
was `decide()`'d with a `decidedBy` starting `"human:"` (the autonomous-tier
auto-approve gate). `countSentSince(since)` / `lastSent(n)` — rate-limit and
bounce-rate-window queries.

### inbound
`insertIfNew(input)` — dedupes on `(source, externalId)`; returns the
existing row (`created: false`) on a repeat. `get(id)`,
`list({status?, classification?, limit?})`, `findByMessageId(messageId)`,
`listByThreadKey(threadKey, limit?)` (newest first — thread-summary
building), `setStatus(id, status, patch?)`.

### settings
Single JSON row (id `1`). `get()` merges the stored partial over core's
`DEFAULT_SETTINGS` (so a missing/older row never breaks a reader);
`patch(partial)` shallow-merges over the current value (a given nested object
like `quietHours` replaces wholesale, not deep-merged), persists, and returns
the full `HqSettings`.

### channelCursors
`get(key) → cursor | null`, `set(key, cursor)` — the email poller's
persisted fetch cursor (survives daemon restarts).

### quota
`record(buckets: QuotaBucket[])` (timestamps itself), `latest()`.

## Ids / timestamps
All generated ids use core's `newId(prefix)` (`tsk`, `ctc`, `cmp`, `note`,
`mem`, `obx`, `ibe`, `aud`, `doc`, `chk`, `quo`); all timestamps are `nowIso()`.

## Schema notes
- JSON columns (`policy`, `input`, `result`, `attributes`, `data`) are plain
  `TEXT`, encoded/decoded in the repo layer.
- `kb_fts` is a **standalone** FTS5 table (not `content=`-linked to
  `kb_chunks`): chunk ids are ULIDs, not rowids, so inserts/deletes into
  `kb_fts` are done explicitly alongside `kb_chunks` rather than via FTS5
  external-content triggers. Simpler, and fine at this scale.
- `companies.domain` and `contacts.email` are `UNIQUE ... WHERE ... IS NOT
  NULL` (partial indexes), so multiple rows with no domain/email are allowed.
- Listing queries that order by `created_at DESC` break ties with `rowid
  DESC` so results are deterministic even when multiple rows share a
  millisecond-resolution timestamp (common in tests and burst writes).

## Testing
`npx vitest run packages/db` — migrations idempotency, task transition
validity + `claimNext` (priority, `wakeAt`, paused agent, `maxConcurrency`,
`threadKey` exclusivity, repeated-call safety), `recoverStale`, token issue/
verify/revoke, KB search (Vietnamese diacritics, FTS special-character
injection, scoping, hash-skip, delete), CRM upsert dedupe (email, company by
domain/name), audit append/list, memory, quota, and (Phase 2) the full
outbox lifecycle (`decide` transition validation, edit-while-pending,
claim/recover, transient vs. terminal failure, bounce annotation, rate-limit/
bounce-rate queries, human-vs-policy approval tracking), inbound dedupe/
filtering/threading, and settings get/patch merge semantics.
