// Real-mailbox EmailProvider: IMAP for fetching, SMTP for sending.
//
// Shadow-safety (the human's mailbox must not change because we read it):
//   - Mailboxes are opened READ-ONLY (IMAP EXAMINE, not SELECT): the server itself refuses any flag change, so
//     \Seen can never be set, nothing can be moved, deleted or expunged — even by a bug in this file.
//   - Messages are fetched with BODY.PEEK[] (imapflow builds `source: true` fetches that way), never bare BODY[].
//   - The only IMAP write this class can issue is APPEND of OUR OWN sent copy to `sentFolder`, and only when the
//     operator configured one (null by default; Gmail/M365 save SMTP sends themselves).
//   - IDLE is disabled: we poll, we never hold a mailbox selected in the background.
//
// First sync: a null cursor means "only mail that arrives after we first connect" (initialSyncDays = 0, the default).
// Set initialSyncDays = N to also pull the last N days (capped by initialSyncMaxMessages, newest first). History is
// never ingested otherwise. See imap-sync.ts for the cursor format and the UIDVALIDITY-change resync.
//
// Sent folder (opt-in, `syncSent: true`): fetchSent() reads the mailbox's Sent folder with the same rules, so the
// daemon can learn what a human answered from their own mail client. The folder is `sentFolder` if given, else the
// RFC 6154 \Sent folder, else a well-known name ("[Gmail]/Sent Mail", "Sent Items", "Sent", ...).
//
// The IMAP client and SMTP transport are both injectable via factory functions so tests can supply a hand-written
// fake IMAP client and a real nodemailer transport; integration tests run the real ImapFlow/nodemailer against
// in-process IMAP/SMTP servers (test/support/mail-servers.ts).

import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import type { SendMailOptions } from "nodemailer";

import type { EmailAddress, EmailProvider, FetchResult, OutgoingEmail, ParsedEmail, SendResult } from "@agyhq/core";

import { parseRawEmail } from "../parse.ts";
import { normalizeMessageId } from "../message-id.ts";
import { addressToPlainString, buildMimeBuffer, mailOptionsFor } from "../mime.ts";
import { describeMailError, isDefinitiveServerError } from "../errors.ts";
import {
  DEFAULT_SYNC_POLICY,
  formatImapCursor,
  parseImapCursor,
  pickSentFolder,
  resolveStartUid,
  type FolderInfo,
  type SyncPolicy,
} from "./imap-sync.ts";

export interface ImapClientMailbox {
  uidValidity: bigint;
  uidNext: number;
  /** Message count (EXISTS); used by the doctor. */
  exists?: number;
}

export interface ImapClientFetchMessage {
  uid: number;
  source?: Buffer;
  internalDate?: Date | string;
}

/**
 * The slice of ImapFlow's API this provider actually uses. A real ImapFlow
 * instance satisfies this structurally; tests can pass a plain object
 * implementing just this interface instead.
 */
export interface ImapClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  mailboxOpen(path: string, options?: { readOnly?: boolean }): Promise<ImapClientMailbox>;
  fetch(
    range: string,
    query: { uid: boolean; source: boolean; internalDate?: boolean },
    options?: { uid?: boolean },
  ): AsyncIterable<ImapClientFetchMessage>;
  append?(path: string, content: string | Buffer, flags?: string[]): Promise<unknown>;
  /** LIST: used to find the Sent folder. */
  list?(): Promise<FolderInfo[]>;
  /** UID SEARCH SINCE: used by the first-sync window and the UIDVALIDITY resync. */
  search?(query: { since: Date }, options: { uid: true }): Promise<number[] | false>;
  /** ImapFlow is an EventEmitter and throws on an unhandled 'error'; we always attach listeners. */
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  /** Closes the socket without a goodbye (used to discard a half-open connection). */
  close?(): void;
}

export interface ImapConnectionConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export type ImapClientFactory = (cfg: ImapConnectionConfig) => ImapClient;

export interface SmtpSendInfo {
  messageId?: string;
  response?: string;
  accepted?: Array<string | { address: string }>;
  rejected?: Array<string | { address: string }>;
}

/**
 * The slice of a nodemailer Transporter this provider actually uses. A real
 * `nodemailer.createTransport(...)` satisfies this structurally; tests can
 * inject one configured with `streamTransport`/`jsonTransport` (for realistic
 * headers) or a hand-written fake implementing just this interface.
 */
export interface SmtpTransport {
  sendMail(options: SendMailOptions): Promise<SmtpSendInfo>;
  verify(): Promise<unknown>;
  close(): void;
}

export type SmtpTransportFactory = (cfg: ImapConnectionConfig) => SmtpTransport;

export interface ImapSmtpProviderOptions {
  address: string;
  displayName?: string;
  imap: ImapConnectionConfig;
  smtp: ImapConnectionConfig;
  /** @default "INBOX" */
  mailbox?: string;
  /**
   * Folder that receives a copy of every message WE send (IMAP APPEND). null/omitted = don't (Gmail and Microsoft 365
   * already save SMTP sends themselves). Also the explicit Sent folder for `syncSent`.
   */
  sentFolder?: string | null;
  /** Opt-in: also read the mailbox's Sent folder (what the human sent from their own mail client). @default false */
  syncSent?: boolean;
  /** First-sync window in days; 0 = only mail arriving from now on. @default 0 */
  initialSyncDays?: number;
  /** Cap on existing mail pulled in by a first sync / resync. @default 200 */
  initialSyncMaxMessages?: number;
  /** Test seam: defaults to a real `new ImapFlow(...)`. */
  createImapClient?: ImapClientFactory;
  /** Test seam: defaults to `nodemailer.createTransport(...)`. */
  createSmtpTransport?: SmtpTransportFactory;
  /** Test seam. */
  now?: () => Date;
  /** Where warnings go (default console.warn). */
  warn?: (message: string) => void;
}

function defaultImapClientFactory(cfg: ImapConnectionConfig): ImapClient {
  return new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    // We poll; never park a selected mailbox in IDLE in the background.
    disableAutoIdle: true,
    connectionTimeout: 30_000,
    greetingTimeout: 16_000,
    socketTimeout: 120_000,
  }) as unknown as ImapClient;
}

function defaultSmtpTransportFactory(cfg: ImapConnectionConfig): SmtpTransport {
  return createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
  });
}

export class ImapSmtpProvider implements EmailProvider {
  readonly kind = "imap-smtp";
  readonly syncsSent: boolean;

  #from: EmailAddress;
  #mailbox: string;
  #sentFolder: string | null;
  #policy: SyncPolicy;
  #imapCfg: ImapConnectionConfig;
  #secrets: string[];
  #createImapClient: ImapClientFactory;
  #transport: SmtpTransport;
  #now: () => Date;
  #warn: (message: string) => void;

  #client: ImapClient | null = null;
  #connecting: Promise<ImapClient> | null = null;
  #resolvedSent: string | null = null;

  constructor(opts: ImapSmtpProviderOptions) {
    this.#from = { address: opts.address.toLowerCase(), name: opts.displayName ?? null };
    this.#mailbox = opts.mailbox ?? "INBOX";
    this.#sentFolder = opts.sentFolder === undefined ? null : opts.sentFolder;
    this.syncsSent = opts.syncSent === true;
    this.#policy = {
      initialSyncDays: Math.max(0, Math.floor(opts.initialSyncDays ?? DEFAULT_SYNC_POLICY.initialSyncDays)),
      initialSyncMaxMessages: Math.max(1, Math.floor(opts.initialSyncMaxMessages ?? DEFAULT_SYNC_POLICY.initialSyncMaxMessages)),
    };
    this.#imapCfg = opts.imap;
    this.#secrets = [opts.imap.pass, opts.smtp.pass].filter(Boolean);
    this.#createImapClient = opts.createImapClient ?? defaultImapClientFactory;
    this.#transport = (opts.createSmtpTransport ?? defaultSmtpTransportFactory)(opts.smtp);
    this.#now = opts.now ?? (() => new Date());
    this.#warn = opts.warn ?? ((m) => console.warn(m));
  }

  #dropClient(client: ImapClient): void {
    if (this.#client === client) this.#client = null;
  }

  async #getClient(): Promise<ImapClient> {
    if (this.#client) return this.#client;
    if (!this.#connecting) {
      this.#connecting = (async () => {
        const client = this.#createImapClient(this.#imapCfg);
        // An unhandled 'error' event on an EventEmitter throws and would take the whole daemon down when the server
        // drops the socket. Swallow it here (the failed command surfaces its own error) and forget the dead client.
        client.on?.("error", () => this.#dropClient(client));
        client.on?.("close", () => this.#dropClient(client));
        try {
          await client.connect();
        } catch (err) {
          try {
            client.close?.();
          } catch {
            // already dead
          }
          throw err;
        }
        this.#client = client;
        return client;
      })().finally(() => {
        // Always reset, success or failure: a failed connect must not be cached forever.
        this.#connecting = null;
      });
    }
    return this.#connecting;
  }

  /**
   * Run `fn` against the shared connection. A dropped/broken connection is replaced and `fn` retried once; a
   * definitive server answer (wrong password, no such mailbox) is not retried — repeating a failed login is how
   * accounts get locked.
   */
  async #withClient<T>(fn: (client: ImapClient) => Promise<T>): Promise<T> {
    const client = await this.#getClient();
    try {
      return await fn(client);
    } catch (err) {
      this.#dropClient(client);
      try {
        client.close?.();
      } catch {
        // already broken
      }
      if (isDefinitiveServerError(err)) throw err;
      try {
        await client.logout();
      } catch {
        // already broken; nothing to clean up
      }
      const retried = await this.#getClient();
      return fn(retried);
    }
  }

  /** The shared fetch loop for INBOX and the Sent folder. Read-only; returns a cursor only ever advanced past what was returned. */
  async #fetchFrom(mailboxPath: string, cursor: string | null, limit: number): Promise<FetchResult> {
    return this.#withClient(async (client) => {
      const mailbox = await client.mailboxOpen(mailboxPath, { readOnly: true });
      const uidValidity = mailbox.uidValidity.toString();
      const now = this.#now();
      const nowSec = Math.floor(now.getTime() / 1000);
      const parsedCursor = parseImapCursor(cursor);

      const plan = await resolveStartUid(client, mailbox, parsedCursor, this.#policy, now, mailboxPath);
      if (plan.warning) this.#warn(`[channels] imap-smtp: ${plan.warning}`);

      if (plan.startUid >= mailbox.uidNext) {
        // Caught up (or a brand-new cursor with nothing to read). Keep an existing cursor byte-for-byte when nothing
        // changed so callers can detect "no change" by string equality.
        if (parsedCursor && parsedCursor.uidValidity === uidValidity) return { messages: [], cursor };
        return {
          messages: [],
          cursor: formatImapCursor({ uidValidity, lastUid: Math.max(mailbox.uidNext - 1, 0), caughtUpAt: nowSec }),
        };
      }

      const endUid = Math.min(plan.startUid + limit - 1, mailbox.uidNext - 1);
      const range = `${plan.startUid}:${endUid}`;
      const filterByDate = plan.notBefore !== null;

      const messages: ParsedEmail[] = [];
      for await (const msg of client.fetch(range, { uid: true, source: true, internalDate: filterByDate }, { uid: true })) {
        if (msg.uid < plan.startUid || msg.uid > endUid) continue; // servers may echo the "last message" for ranges
        if (!msg.source) continue;
        if (plan.notBefore && msg.internalDate && new Date(msg.internalDate).getTime() < plan.notBefore.getTime()) continue;
        messages.push(await parseRawEmail(msg.source, String(msg.uid)));
      }

      // Everything <= endUid has now been handled (UID ranges are exhaustive, gaps are expunged mail), so the cursor
      // moves to endUid even if the window was empty — otherwise a run of deleted UIDs would wedge the poller.
      const caughtUp = endUid >= mailbox.uidNext - 1;
      const caughtUpAt = caughtUp ? nowSec : parsedCursor && parsedCursor.uidValidity === uidValidity ? parsedCursor.caughtUpAt : (plan.notBefore ? Math.floor(plan.notBefore.getTime() / 1000) : nowSec);
      return { messages, cursor: formatImapCursor({ uidValidity, lastUid: endUid, caughtUpAt }) };
    });
  }

  async fetchNew(cursor: string | null, opts: { limit?: number } = {}): Promise<FetchResult> {
    return this.#fetchFrom(this.#mailbox, cursor, opts.limit ?? 50);
  }

  /** Resolve (and cache) the Sent folder name: sentFolder > \Sent special-use > well-known names. */
  async #resolveSentFolder(): Promise<string> {
    if (this.#resolvedSent) return this.#resolvedSent;
    const folders = await this.#withClient(async (client) => {
      if (!client.list) throw new Error("imap client does not support LIST");
      return client.list();
    });
    const picked = pickSentFolder(folders, this.#sentFolder);
    if (!picked.ok) {
      const shown = picked.available.slice(0, 30).join(", ");
      throw new Error(`${picked.error}. Folders on the server: ${shown || "(none)"}`);
    }
    this.#resolvedSent = picked.path;
    return picked.path;
  }

  async fetchSent(cursor: string | null, opts: { limit?: number } = {}): Promise<FetchResult & { folder: string }> {
    if (!this.syncsSent) throw new Error("Sent-folder sync is not enabled (set syncSent: true)");
    const folder = await this.#resolveSentFolder();
    const result = await this.#fetchFrom(folder, cursor, opts.limit ?? 50);
    return { ...result, folder };
  }

  async send(email: OutgoingEmail): Promise<SendResult> {
    const info = await this.#transport.sendMail(mailOptionsFor(email, this.#from));

    const result: SendResult = {
      messageId: normalizeMessageId(info.messageId) ?? email.messageId,
      response: typeof info.response === "string" ? info.response : "",
      accepted: (info.accepted ?? []).map(addressToPlainString),
      rejected: (info.rejected ?? []).map(addressToPlainString),
    };

    if (this.#sentFolder) {
      try {
        const mime = await buildMimeBuffer(email, this.#from);
        await this.#withClient(async (client) => {
          if (!client.append) throw new Error("imap client does not support append");
          await client.append(this.#sentFolder!, mime, ["\\Seen"]);
        });
      } catch (err) {
        this.#warn(`[channels] imap-smtp: failed to append sent copy to ${this.#sentFolder}: ${describeMailError(err, "imap", this.#secrets)}`);
      }
    }

    return result;
  }

  async verify(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.#getClient();
    } catch (err) {
      return { ok: false, error: `imap: ${describeMailError(err, "imap", this.#secrets)}` };
    }
    try {
      await this.#transport.verify();
    } catch (err) {
      return { ok: false, error: `smtp: ${describeMailError(err, "smtp", this.#secrets)}` };
    }
    return { ok: true };
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    if (client) {
      try {
        await client.logout();
      } catch {
        try {
          client.close?.();
        } catch {
          // ignore — closing anyway
        }
      }
    }
    this.#transport.close();
  }
}
