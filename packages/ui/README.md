# @agyhq/ui

The web console for agy-hq: approve/edit/reject outbound drafts, watch tasks
live, manage agents/contacts/knowledge, and flip the outbound kill switch.
React 19 + react-router-dom 7 + Vite, plain CSS (no component library).

## Develop

```sh
npm run dev -w @agyhq/ui
```

This proxies `/v1` to the daemon (`http://127.0.0.1:7317` by default — override
with `AGYHQ_API_URL` or `VITE_AGYHQ_API_URL`). Start the daemon separately
(`npm run hq -- serve` from the repo root) and open the printed Vite URL.

On first load you'll be asked for the admin token from
`<dataDir>/admin-token`; it's kept in `localStorage` and sent as
`Authorization: Bearer <token>` on every request. A 401 from any request
drops you back to the token form.

## Build

```sh
npm run build -w @agyhq/ui     # -> packages/ui/dist, served by the daemon at "/"
npm run typecheck -w @agyhq/ui # tsc -p packages/ui/tsconfig.json
```

## Test

```sh
npx vitest run packages/ui
```

Tests live in `packages/ui/test/**/*.test.{ts,tsx}`; component tests start
with `// @vitest-environment jsdom` since the shared `vitest.config.ts`
defaults to the `node` environment. They mock `fetch` and `EventSource`
directly — no real daemon needed.

## Structure

- `src/api/` — typed fetch client (`client.ts`), the SSE event hub
  (`sse.ts`), and the type re-exports from `@agyhq/core`/`@agyhq/server`
  the UI consumes (`types.ts`, all type-only imports).
- `src/auth/` — token storage, the auth context/gate, the token form.
- `src/components/` — shell/nav, status pill, connection indicator, confirm
  dialog, toasts, the markdown renderer.
- `src/pages/<Area>/` — one folder per nav item (Inbox, Dashboard, Tasks,
  Agents, Contacts, Inbound, Knowledge, Memory, Settings).
- `src/lib/` — pure helpers (relative time, CSV parsing, the markdown
  renderer's HTML-escaping logic) kept framework-free so they're easy to
  unit test.
- `src/styles/` — `tokens.css` (CSS variables, light/dark via
  `prefers-color-scheme`), `base.css`, `layout.css` (shell/nav, responsive
  down to ~380px), `components.css`, `pages.css`.

## Design notes

- **Inbox is keyboard-first**: `J`/`K` move between drafts, `A` approves,
  `R` opens the required-reason reject form, `Cmd/Ctrl+S` saves an edit.
  Plain letter shortcuts are disabled while focus is in a text field (see
  `hooks/useHotkeys.ts`) so typing "a" into a subject line never fires
  Approve.
- **Edited-but-unsaved drafts can't be approved.** The Approve button is
  disabled whenever the subject/body differs from the last saved version;
  saving is the only way to clear that state — there's no separate "confirm
  you meant to send your edit" dialog, since saving already is that
  confirmation.
- **Shadow tier is loud, not subtle.** A pending draft from a `shadow`-tier
  agent shows a banner before anything else in the detail pane: approving it
  records a verdict but the daemon will never actually send it.
- **The knowledge-base markdown preview never renders raw HTML.** Every line
  of source is HTML-escaped before any markup is layered on top (see
  `lib/markdown.ts`); the only tags it ever emits are ones it constructs
  itself, and links are restricted to `http(s):`/`mailto:` schemes.
- **The kill switch always confirms**, independent of direction (enabling
  outbound gets a confirm dialog just like disabling it), since flipping it
  on is the one action that turns on real sends.

## Contract gaps found while building this

- **SSE auth**: the brief specifies `EventSource('/v1/admin/events?access_token=…')`,
  but `admin-api.ts` mounts `/v1/admin/*` behind `hono/bearer-auth`, which by
  default only reads the `Authorization` header — and `EventSource` cannot
  set custom headers from the browser. The UI is built against the
  query-param contract (`src/api/sse.ts`), but the daemon will need to
  special-case `/v1/admin/events` to also accept `?access_token=` (or front
  it with something else that can carry a header) for this to actually work
  once Phase 2 wires up the admin API.
- **Everything under "Phase 2 additions" in `admin-types.ts`** (settings,
  killswitch, status, stats, contact detail/timeline, task transcript, KB
  docs CRUD, inbound list/detail) has no route in the current
  `admin-api.ts` yet — expected, since the backend is being built
  concurrently, but noting it so it's not mistaken for an oversight. The UI
  is implemented strictly against the documented request/response shapes in
  `admin-types.ts`.
- `ApproveOutboxRequest`/`RejectOutboxRequest`/edit/retry for outbox items
  are likewise Phase 2 shapes the current `admin-api.ts` outbox routes
  (plain approve/reject, no body) don't yet implement.
