// Real-mailbox EmailProvider: IMAP for fetching, SMTP for sending.
//
// Cursor format: "<uidValidity>:<lastUid>".
//   - A null cursor means "start from the mailbox's current UIDNEXT" — i.e.
//     only mail that arrives from now on. We never backfill a mailbox's full
//     history on first run.
//   - If uidValidity has changed since the stored cursor (the server
//     renumbered UIDs — rare, but happens on mailbox rebuilds), we log a
//     warning and restart from the mailbox's current UIDNEXT rather than
//     risk reusing now-meaningless UIDs.
//
// Fetching uses BODY.PEEK[] (imapflow always builds `source: true` fetches
// with BODY.PEEK, never bare BODY[]), so \Seen is never set as a side effect
// of reading mail.
//
// The IMAP client and SMTP transport are both injectable via factory
// functions so tests can supply a hand-written fake IMAP client and a real
// nodemailer transport configured with `jsonTransport`/`streamTransport`
// instead of talking to a real server.

import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import type { SendMailOptions } from "nodemailer";

import type { EmailAddress, EmailProvider, FetchResult, OutgoingEmail, ParsedEmail, SendResult } from "@agyhq/core";

import { parseRawEmail } from "../parse.ts";
import { normalizeMessageId } from "../message-id.ts";
import { addressToPlainString, buildMimeBuffer, mailOptionsFor } from "../mime.ts";

export interface ImapClientMailbox {
  uidValidity: bigint;
  uidNext: number;
}

export interface ImapClientFetchMessage {
  uid: number;
  source?: Buffer;
}

/**
 * The slice of ImapFlow's API this provider actually uses. A real ImapFlow
 * instance satisfies this structurally; tests can pass a plain object
 * implementing just this interface instead.
 */
export interface ImapClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  mailboxOpen(path: string): Promise<ImapClientMailbox>;
  fetch(
    range: string,
    query: { uid: boolean; source: boolean },
    options?: { uid?: boolean },
  ): AsyncIterable<ImapClientFetchMessage>;
  append?(path: string, content: string | Buffer, flags?: string[]): Promise<unknown>;
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
  /** Append a copy of every sent message here. null = don't (e.g. Gmail saves SMTP sends itself). */
  sentFolder?: string | null;
  /** Test seam: defaults to a real `new ImapFlow(...)`. */
  createImapClient?: ImapClientFactory;
  /** Test seam: defaults to `nodemailer.createTransport(...)`. */
  createSmtpTransport?: SmtpTransportFactory;
}

function defaultImapClientFactory(cfg: ImapConnectionConfig): ImapClient {
  return new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });
}

function defaultSmtpTransportFactory(cfg: ImapConnectionConfig): SmtpTransport {
  return createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
}

export class ImapSmtpProvider implements EmailProvider {
  readonly kind = "imap-smtp";

  #from: EmailAddress;
  #mailbox: string;
  #sentFolder: string | null;
  #imapCfg: ImapConnectionConfig;
  #createImapClient: ImapClientFactory;
  #transport: SmtpTransport;

  #client: ImapClient | null = null;
  #connecting: Promise<ImapClient> | null = null;

  constructor(opts: ImapSmtpProviderOptions) {
    this.#from = { address: opts.address.toLowerCase(), name: opts.displayName ?? null };
    this.#mailbox = opts.mailbox ?? "INBOX";
    this.#sentFolder = opts.sentFolder === undefined ? null : opts.sentFolder;
    this.#imapCfg = opts.imap;
    this.#createImapClient = opts.createImapClient ?? defaultImapClientFactory;
    this.#transport = (opts.createSmtpTransport ?? defaultSmtpTransportFactory)(opts.smtp);
  }

  async #getClient(): Promise<ImapClient> {
    if (this.#client) return this.#client;
    if (!this.#connecting) {
      this.#connecting = (async () => {
        const client = this.#createImapClient(this.#imapCfg);
        await client.connect();
        this.#client = client;
        this.#connecting = null;
        return client;
      })();
    }
    return this.#connecting;
  }

  /** Run `fn` against the shared connection; on failure, reconnect once and retry. */
  async #withClient<T>(fn: (client: ImapClient) => Promise<T>): Promise<T> {
    const client = await this.#getClient();
    try {
      return await fn(client);
    } catch (err) {
      this.#client = null;
      try {
        await client.logout();
      } catch {
        // already broken; nothing to clean up
      }
      const retried = await this.#getClient();
      return fn(retried);
    }
  }

  async fetchNew(cursor: string | null, opts: { limit?: number } = {}): Promise<FetchResult> {
    const limit = opts.limit ?? 50;

    return this.#withClient(async (client) => {
      const mailbox = await client.mailboxOpen(this.#mailbox);
      const uidValidity = mailbox.uidValidity;

      let startUid: number;
      if (cursor === null) {
        // Only new mail from now on — never backfill history on first run.
        startUid = mailbox.uidNext;
      } else {
        const [cursorValidity, cursorUid] = cursor.split(":");
        if (cursorValidity !== uidValidity.toString()) {
          console.warn(
            `[channels] imap-smtp: UIDVALIDITY changed for ${this.#mailbox} (was ${cursorValidity}, now ${uidValidity}); restarting from current UIDNEXT ${mailbox.uidNext}`,
          );
          startUid = mailbox.uidNext;
        } else {
          startUid = Number(cursorUid) + 1;
        }
      }

      if (startUid >= mailbox.uidNext) {
        return { messages: [], cursor: `${uidValidity}:${Math.max(startUid - 1, 0)}` };
      }

      const endUid = Math.min(startUid + limit - 1, mailbox.uidNext - 1);
      const range = `${startUid}:${endUid}`;

      const messages: ParsedEmail[] = [];
      let lastUid = startUid - 1;
      for await (const msg of client.fetch(range, { uid: true, source: true }, { uid: true })) {
        if (msg.uid > lastUid) lastUid = msg.uid;
        if (!msg.source) continue;
        messages.push(await parseRawEmail(msg.source, String(msg.uid)));
      }

      return { messages, cursor: `${uidValidity}:${lastUid}` };
    });
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
        console.warn(`[channels] imap-smtp: failed to append sent copy to ${this.#sentFolder}:`, err);
      }
    }

    return result;
  }

  async verify(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.#getClient();
    } catch (err) {
      return { ok: false, error: `imap: ${err instanceof Error ? err.message : String(err)}` };
    }
    try {
      await this.#transport.verify();
    } catch (err) {
      return { ok: false, error: `smtp: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true };
  }

  async close(): Promise<void> {
    if (this.#client) {
      try {
        await this.#client.logout();
      } catch {
        // ignore — closing anyway
      }
      this.#client = null;
    }
    this.#transport.close();
  }
}
