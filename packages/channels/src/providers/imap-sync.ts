// Pure-ish helpers shared by ImapSmtpProvider and the `email doctor` preflight, so both always agree on
//   - how a poll cursor is written/read,
//   - where a sync starts (first sync policy, UIDVALIDITY resync, normal resume),
//   - which folder is "Sent".
//
// Cursor format: "<uidValidity>:<lastUid>[:<epochSec>]".
//   lastUid  every message with UID <= lastUid has been handed to the caller.
//   epochSec (optional) the wall-clock moment up to which the mailbox was fully caught up. After a UIDVALIDITY change
//            (server renumbered everything) it lets us re-scan exactly the mail that arrived since then instead of
//            silently skipping it. Older cursors without it are still accepted.

export interface ImapCursor {
  uidValidity: string;
  lastUid: number;
  /** Epoch seconds the mailbox was last fully caught up, or null (legacy cursor). */
  caughtUpAt: number | null;
}

export function parseImapCursor(cursor: string | null): ImapCursor | null {
  if (!cursor) return null;
  const parts = cursor.split(":");
  const uidValidity = parts[0];
  const lastUid = Number(parts[1]);
  if (!uidValidity || !Number.isFinite(lastUid) || lastUid < 0) return null;
  const ts = parts[2] !== undefined ? Number(parts[2]) : NaN;
  return { uidValidity, lastUid, caughtUpAt: Number.isFinite(ts) && ts > 0 ? ts : null };
}

export function formatImapCursor(c: ImapCursor): string {
  return `${c.uidValidity}:${c.lastUid}${c.caughtUpAt ? `:${c.caughtUpAt}` : ""}`;
}

/** What to do about mail that is already in the mailbox the first time we connect. */
export interface SyncPolicy {
  /** 0 (default) = only mail that arrives after we first connect. N > 0 = also the mail from the last N days. */
  initialSyncDays: number;
  /** Hard cap on how much existing mail a first sync / resync may pull in (newest wins). */
  initialSyncMaxMessages: number;
}

export const DEFAULT_SYNC_POLICY: SyncPolicy = { initialSyncDays: 0, initialSyncMaxMessages: 200 };

/** Slice of the IMAP client the start-UID logic needs. */
export interface SearchableClient {
  search?(query: { since: Date }, options: { uid: true }): Promise<number[] | false>;
}

export type StartReason = "resume" | "first-sync" | "uidvalidity-changed";

export interface StartPlan {
  /** First UID to fetch; >= uidNext means "nothing to do". */
  startUid: number;
  reason: StartReason;
  /** When set, messages whose INTERNALDATE is before this must be skipped (date-granular SEARCH SINCE is imprecise). */
  notBefore: Date | null;
  /** UIDs found by the SINCE search (before the cap), for reporting. */
  candidates: number;
  warning?: string;
}

const RESYNC_GRACE_MS = 60 * 60 * 1000;

async function startFromDate(
  client: SearchableClient,
  since: Date,
  uidNext: number,
  policy: SyncPolicy,
): Promise<{ startUid: number; candidates: number }> {
  if (!client.search) return { startUid: uidNext, candidates: 0 };
  const found = await client.search({ since }, { uid: true });
  const uids = (found || []).filter((u) => u < uidNext).sort((a, b) => a - b);
  if (uids.length === 0) return { startUid: uidNext, candidates: 0 };
  const capped = uids.slice(-Math.max(1, policy.initialSyncMaxMessages));
  return { startUid: capped[0]!, candidates: uids.length };
}

/** Decide where a fetch begins. Never "backfills history" unless the policy (or a UIDVALIDITY resync) says so. */
export async function resolveStartUid(
  client: SearchableClient,
  mailbox: { uidValidity: bigint | string; uidNext: number },
  cursor: ImapCursor | null,
  policy: SyncPolicy,
  now: Date,
  mailboxName = "INBOX",
): Promise<StartPlan> {
  const validity = mailbox.uidValidity.toString();

  if (!cursor) {
    if (policy.initialSyncDays <= 0) return { startUid: mailbox.uidNext, reason: "first-sync", notBefore: null, candidates: 0 };
    const notBefore = new Date(now.getTime() - policy.initialSyncDays * 86_400_000);
    const { startUid, candidates } = await startFromDate(client, notBefore, mailbox.uidNext, policy);
    return { startUid, reason: "first-sync", notBefore, candidates };
  }

  if (cursor.uidValidity !== validity) {
    if (cursor.caughtUpAt) {
      const notBefore = new Date(cursor.caughtUpAt * 1000 - RESYNC_GRACE_MS);
      const { startUid, candidates } = await startFromDate(client, notBefore, mailbox.uidNext, policy);
      return {
        startUid,
        reason: "uidvalidity-changed",
        notBefore,
        candidates,
        warning: `UIDVALIDITY of ${mailboxName} changed (was ${cursor.uidValidity}, now ${validity}); re-scanning mail since ${notBefore.toISOString()} (duplicates are dropped by Message-ID)`,
      };
    }
    return {
      startUid: mailbox.uidNext,
      reason: "uidvalidity-changed",
      notBefore: null,
      candidates: 0,
      warning: `UIDVALIDITY of ${mailboxName} changed (was ${cursor.uidValidity}, now ${validity}) and the stored cursor has no timestamp; restarting from the current UIDNEXT ${mailbox.uidNext}`,
    };
  }

  return { startUid: cursor.lastUid + 1, reason: "resume", notBefore: null, candidates: 0 };
}

// ---------------------------------------------------------------------------
// Sent-folder discovery

export interface FolderInfo {
  path: string;
  specialUse?: string | null;
  /** "extension" = the server said so (RFC 6154 / XLIST); "name" = imapflow matched a localized name. */
  specialUseSource?: string | null;
  flags?: Iterable<string>;
}

const SENT_NAME_CANDIDATES = [
  "[Gmail]/Sent Mail",
  "[Google Mail]/Sent Mail",
  "[Gmail]/Sent",
  "Sent",
  "Sent Items",
  "Sent Messages",
  "Sent Mail",
  "INBOX.Sent",
  "INBOX/Sent",
  "INBOX.Sent Items",
  "Đã gửi",
  "Thư đã gửi",
  "Thu da gui",
];

export type SentFolderResult =
  | { ok: true; path: string; via: "configured" | "special-use" | "name" }
  | { ok: false; error: string; available: string[] };

function selectable(f: FolderInfo): boolean {
  if (!f.flags) return true;
  for (const flag of f.flags) if (flag.toLowerCase() === "\\noselect" || flag.toLowerCase() === "\\nonexistent") return false;
  return true;
}

/** configured > RFC 6154 \Sent > well-known names (Gmail "[Gmail]/Sent Mail", "Sent Items", ...). */
export function pickSentFolder(folders: readonly FolderInfo[], configured?: string | null): SentFolderResult {
  const usable = folders.filter(selectable);
  const available = usable.map((f) => f.path);
  const wanted = configured?.trim();
  if (wanted) {
    const hit = usable.find((f) => f.path === wanted) ?? usable.find((f) => f.path.toLowerCase() === wanted.toLowerCase());
    if (hit) return { ok: true, path: hit.path, via: "configured" };
    return { ok: false, error: `configured Sent folder "${wanted}" does not exist on the server`, available };
  }
  const special = usable.filter((f) => f.specialUse === "\\Sent");
  const bySpecial = special.find((f) => f.specialUseSource !== "name") ?? special[0];
  if (bySpecial) return { ok: true, path: bySpecial.path, via: "special-use" };
  for (const name of SENT_NAME_CANDIDATES) {
    const hit = usable.find((f) => f.path.toLowerCase() === name.toLowerCase());
    if (hit) return { ok: true, path: hit.path, via: "name" };
  }
  return {
    ok: false,
    error: "could not find the Sent folder automatically (no \\Sent special-use flag and no well-known name); set sentFolder explicitly",
    available,
  };
}
