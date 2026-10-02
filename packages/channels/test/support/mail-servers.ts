// A realistic local mail test bed: a real IMAP4rev1 protocol server (hoodiecrow-imap, in-process, in-memory) and a
// real SMTP server (smtp-server), both on 127.0.0.1 with random ports. No TLS (the provider is told secure:false and
// neither server advertises STARTTLS), no credentials beyond the throw-away ones below.
//
// Why these two: both are tiny, pure-JS, and speak the actual wire protocol, so ImapFlow and nodemailer run exactly
// the code paths they run against Gmail/M365 — login, EXAMINE, UID FETCH BODY.PEEK[], LIST with SPECIAL-USE, APPEND.
// What they do NOT reproduce: Gmail's label semantics/X-GM-*, provider rate limits, TLS/certificate behaviour, OAuth,
// server-side IDLE push. See docs/EMAIL-SETUP.md ("Test bed") for the trade-offs.

import net from "node:net";
import { createTransport } from "nodemailer";
import type { SendMailOptions } from "nodemailer";
import hoodiecrow from "hoodiecrow-imap";
import type { HoodiecrowConnection, HoodiecrowMailbox, HoodiecrowServer } from "hoodiecrow-imap";
import { SMTPServer } from "smtp-server";

export const TEST_USER = "mai@agyhq.test";
export const TEST_PASS = "correct-horse-battery";

/** Build a real RFC 822 message (RFC 2047 subjects, QP/base64 bodies, HTML-only, attachments, threading headers). */
export async function buildEml(options: SendMailOptions): Promise<Buffer> {
  const transport = createTransport({ streamTransport: true, buffer: true });
  const info = await transport.sendMail({
    from: "Jane Doe <jane@acme.com>",
    to: TEST_USER,
    ...options,
  });
  return info.message as Buffer;
}

export interface ImapMessageInit {
  /** Raw message: a Buffer (preferred), or a string already in "binary" (latin1) form. */
  raw: Buffer | string;
  flags?: string[];
  /** INTERNALDATE; default now. */
  date?: Date;
}

export interface TestImapServer {
  port: number;
  /** Every raw IMAP command line received, e.g. `A4 UID FETCH 1:2 (UID BODY.PEEK[])`, across all connections. */
  commands: string[];
  /** Append a message to a mailbox (default INBOX) as if it was just delivered; returns its UID. */
  deliver(init: ImapMessageInit, mailbox?: string): number;
  mailbox(path: string): HoodiecrowMailbox;
  /** Change a mailbox's UIDVALIDITY and renumber its messages from 1 (a server-side rebuild). */
  rebuildMailbox(path: string, uidValidity: number): void;
  /** Delete messages by UID from the store (simulates the human deleting mail / UID gaps). */
  expunge(path: string, uids: number[]): void;
  /** Kill every open client connection without a goodbye (network drop / server restart). */
  dropConnections(): void;
  /** Number of client sockets currently open. */
  openConnections(): number;
  close(): Promise<void>;
}

export interface TestImapOptions {
  user?: string;
  pass?: string;
  /** Extra storage folders under the personal namespace (default: a Gmail-like [Gmail]/Sent Mail with \Sent + "Sent"-style variants are opt-in). */
  folders?: Record<string, { "special-use"?: string; flags?: string[] }>;
  /** Layout of the personal namespace separator. Default "/". */
  separator?: string;
  /** Advertise SPECIAL-USE (RFC 6154). Default true. */
  specialUse?: boolean;
}

function toBinary(raw: Buffer | string): string {
  return Buffer.isBuffer(raw) ? raw.toString("binary") : raw;
}

export async function startImapServer(opts: TestImapOptions = {}): Promise<TestImapServer> {
  const user = opts.user ?? TEST_USER;
  const pass = opts.pass ?? TEST_PASS;
  const folders: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(opts.folders ?? {})) folders[name] = { ...def };

  const plugins = ["ENABLE", "ID", "NAMESPACE", "UNSELECT", "LITERALPLUS", ...(opts.specialUse === false ? [] : ["SPECIAL-USE", "CREATE-SPECIAL-USE"])];
  const server: HoodiecrowServer = hoodiecrow({
    plugins,
    users: { [user]: { password: pass } },
    storage: {
      INBOX: { messages: [] },
      "": { separator: opts.separator ?? "/", folders },
    },
  });

  const commands: string[] = [];
  const connections = new Set<HoodiecrowConnection>();
  server.connectionHandlers.push((conn) => {
    connections.add(conn);
    conn.socket?.destroyed; // keep reference; membership is pruned lazily via openConnections()
  });

  // Log every raw command. IMAPConnection.processQueue calls getCommandHandler(cmd)(conn, parsed, rawLine, done).
  const originalGet = server.getCommandHandler.bind(server);
  server.getCommandHandler = ((command: string) => {
    const handler = originalGet(command);
    if (!handler) return handler;
    return (conn: unknown, parsed: unknown, data: unknown, cb: unknown) => {
      commands.push(String(data).replace(/\r?\n$/, ""));
      return (handler as (...a: unknown[]) => unknown)(conn, parsed, data, cb);
    };
  }) as HoodiecrowServer["getCommandHandler"];

  const port = await new Promise<number>((resolve, reject) => {
    server.server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.server.address() as net.AddressInfo).port));
  });

  const requireMailbox = (path: string): HoodiecrowMailbox => {
    const mb = path.toUpperCase() === "INBOX" ? server.folderCache["INBOX"] : server.folderCache[path];
    if (!mb) throw new Error(`test imap: no such mailbox ${path} (have: ${Object.keys(server.folderCache).join(", ")})`);
    return mb;
  };

  return {
    port,
    commands,
    deliver(init, mailbox = "INBOX") {
      const { message } = server.appendMessage(
        requireMailbox(mailbox),
        init.flags ?? [],
        init.date,
        toBinary(init.raw),
      );
      return message.uid;
    },
    mailbox: requireMailbox,
    rebuildMailbox(path, uidValidity) {
      const mb = requireMailbox(path);
      mb.uidvalidity = uidValidity;
      mb.messages.forEach((m, i) => {
        m.uid = i + 1;
      });
      mb.uidnext = mb.messages.length + 1;
    },
    expunge(path, uids) {
      const mb = requireMailbox(path);
      mb.messages = mb.messages.filter((m) => !uids.includes(m.uid));
    },
    dropConnections() {
      for (const conn of connections) conn.socket?.destroy();
      connections.clear();
    },
    openConnections() {
      let n = 0;
      for (const conn of connections) if (conn.socket && !conn.socket.destroyed) n++;
      return n;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const conn of connections) conn.socket?.destroy();
        server.close(() => resolve());
      }),
  };
}

export interface ReceivedSmtpMessage {
  from: string;
  to: string[];
  raw: Buffer;
  user: string | null;
}

export interface TestSmtpServer {
  port: number;
  received: ReceivedSmtpMessage[];
  /** Number of AUTH attempts that were rejected. */
  authFailures: number;
  /** Reject the next DATA with this SMTP code/message (e.g. 451 transient, 550 permanent). */
  failNextData(code: number, message: string): void;
  /** Reject RCPT TO for these addresses with 550. */
  rejectRecipients(addresses: string[]): void;
  close(): Promise<void>;
}

export async function startSmtpServer(opts: { user?: string; pass?: string } = {}): Promise<TestSmtpServer> {
  const user = opts.user ?? TEST_USER;
  const pass = opts.pass ?? TEST_PASS;
  const received: ReceivedSmtpMessage[] = [];
  let failNext: { code: number; message: string } | null = null;
  let rejected = new Set<string>();
  const state = { authFailures: 0 };

  const server = new SMTPServer({
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ["STARTTLS"],
    logger: false,
    banner: "agyhq test smtp",
    onAuth(auth, _session, callback) {
      if (auth.username === user && auth.password === pass) return callback(null, { user: auth.username });
      state.authFailures++;
      return callback(new Error("Invalid username or password"));
    },
    onRcptTo(address, _session, callback) {
      if (rejected.has(address.address.toLowerCase())) {
        const err = new Error("550 5.1.1 No such user here") as Error & { responseCode: number };
        err.responseCode = 550;
        return callback(err);
      }
      return callback();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        if (failNext) {
          const { code, message } = failNext;
          failNext = null;
          const err = new Error(message) as Error & { responseCode: number };
          err.responseCode = code;
          return callback(err);
        }
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks),
          user: (session.user as string | undefined) ?? null,
        });
        callback(null);
      });
    },
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.server.address() as net.AddressInfo).port));
  });

  return {
    port,
    received,
    get authFailures() {
      return state.authFailures;
    },
    failNextData(code, message) {
      failNext = { code, message };
    },
    rejectRecipients(addresses) {
      rejected = new Set(addresses.map((a) => a.toLowerCase()));
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface TestMailServers {
  imap: TestImapServer;
  smtp: TestSmtpServer;
  /** Connection settings to hand to ImapSmtpProvider / config (plain TCP on loopback, throw-away credentials). */
  imapConfig: { host: string; port: number; secure: false; user: string; pass: string };
  smtpConfig: { host: string; port: number; secure: false; user: string; pass: string };
  close(): Promise<void>;
}

/** The standard Gmail-like layout: INBOX plus [Gmail]/Sent Mail (\Sent), Drafts, Trash. */
export const GMAIL_FOLDERS: NonNullable<TestImapOptions["folders"]> = {
  "[Gmail]": { flags: ["\\Noselect"] },
  "[Gmail]/Sent Mail": { "special-use": "\\Sent" },
  "[Gmail]/Drafts": { "special-use": "\\Drafts" },
  "[Gmail]/Trash": { "special-use": "\\Trash" },
};

export async function startMailServers(opts: TestImapOptions = {}): Promise<TestMailServers> {
  const imap = await startImapServer(opts);
  const smtp = await startSmtpServer({ user: opts.user, pass: opts.pass });
  const user = opts.user ?? TEST_USER;
  const pass = opts.pass ?? TEST_PASS;
  return {
    imap,
    smtp,
    imapConfig: { host: "127.0.0.1", port: imap.port, secure: false, user, pass },
    smtpConfig: { host: "127.0.0.1", port: smtp.port, secure: false, user, pass },
    close: async () => {
      await Promise.all([imap.close(), smtp.close()]);
    },
  };
}
