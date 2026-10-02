// Mailbox preflight ("email doctor"): everything a human wants to know about a real mailbox BEFORE pointing the
// harness at it, without changing anything.
//
//   - IMAP login (a fresh connection), the mailbox opened READ-ONLY (EXAMINE), UIDVALIDITY / message count;
//   - folder discovery: which folder is Sent (and how it was found);
//   - first-sync forecast: how many messages the configured first-sync policy WOULD ingest, plus the counts for a few
//     alternative windows so the owner can pick `initialSyncDays` with eyes open;
//   - the latest N messages fetched with BODY.PEEK[] and parsed (so a broken encoding shows up here, not in production);
//   - SMTP: connect + authenticate, WITHOUT sending;
//   - optionally (only when `sendTest` is given) exactly ONE test email.
//
// It never marks mail as seen, never moves/deletes/appends, never stores anything, and never returns a password
// (errors are scrubbed). Classification / routing of the samples is layered on top by the daemon (it needs the DB).

import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import type { ParsedEmail } from "@agyhq/core";

import { describeMailError } from "./errors.ts";
import { newMessageId } from "./message-id.ts";
import { parseRawEmail } from "./parse.ts";
import { DEFAULT_SYNC_POLICY, pickSentFolder, resolveStartUid, type FolderInfo, type SentFolderResult } from "./providers/imap-sync.ts";
import type { ImapClient, ImapConnectionConfig, SmtpTransport } from "./providers/imap-smtp.ts";

export const DOCTOR_TIMEOUT_MS = 20_000;
export const DOCTOR_WINDOWS_DAYS = [1, 3, 7, 14, 30] as const;

export interface MailboxDoctorOptions {
  address: string;
  displayName?: string;
  imap: ImapConnectionConfig;
  smtp: ImapConnectionConfig;
  mailbox?: string;
  sentFolder?: string | null;
  syncSent?: boolean;
  initialSyncDays?: number;
  initialSyncMaxMessages?: number;
  /** How many of the newest messages to fetch and parse. Default 10, max 50. */
  sample?: number;
  timeoutMs?: number;
  /** When set, send exactly one test email to this address. Nothing is sent otherwise. */
  sendTest?: { to: string } | null;
  now?: () => Date;
  /** Test seams. */
  createImapClient?: (cfg: ImapConnectionConfig, timeoutMs: number) => DoctorImapClient;
  createSmtpTransport?: (cfg: ImapConnectionConfig, timeoutMs: number) => SmtpTransport;
}

export type DoctorImapClient = ImapClient & { capabilities?: Map<string, unknown> };

export interface DoctorStep {
  ok: boolean;
  error: string | null;
  tookMs: number;
}

export interface DoctorSample {
  providerId: string;
  /** INTERNALDATE (arrival time), when the server reported it. */
  arrivedAt: string | null;
  parsed: ParsedEmail | null;
  parseError: string | null;
}

export interface MailboxDoctorReport {
  address: string;
  imap: DoctorStep & { host: string; port: number; secure: boolean; user: string; capabilities: string[] };
  mailbox: { name: string; readOnly: true; exists: number | null; uidValidity: string | null; uidNext: number | null; error: string | null };
  folders: { listed: boolean; error: string | null; all: { path: string; specialUse: string | null }[]; sent: SentFolderResult | null };
  firstSync: {
    policy: { initialSyncDays: number; initialSyncMaxMessages: number };
    /** Approximate (date-granular SEARCH SINCE, capped by initialSyncMaxMessages). 0 = only mail arriving from now on. */
    wouldIngest: number;
    totalInMailbox: number | null;
    /** Messages that arrived in the last N days, for choosing initialSyncDays. */
    windows: { days: number; count: number }[];
    error: string | null;
  };
  samples: DoctorSample[];
  smtp: DoctorStep & { host: string; port: number; secure: boolean; user: string };
  sendTest: { attempted: boolean; to: string | null; messageId: string | null; response: string | null; accepted: string[]; rejected: string[]; error: string | null };
}

function defaultImapFactory(cfg: ImapConnectionConfig, timeoutMs: number): DoctorImapClient {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
  return client as unknown as DoctorImapClient;
}

function defaultSmtpFactory(cfg: ImapConnectionConfig, timeoutMs: number): SmtpTransport {
  return createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
}

async function timed<T>(fn: () => Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // best effort
      }
      reject(Object.assign(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`), { code: "ETIMEOUT" }));
    }, ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export async function runMailboxDoctor(opts: MailboxDoctorOptions): Promise<MailboxDoctorReport> {
  const timeoutMs = opts.timeoutMs ?? DOCTOR_TIMEOUT_MS;
  const now = opts.now ? opts.now() : new Date();
  const secrets = [opts.imap.pass, opts.smtp.pass].filter(Boolean);
  const mailboxName = opts.mailbox ?? "INBOX";
  const sampleN = Math.min(Math.max(Math.floor(opts.sample ?? 10), 0), 50);
  const policy = {
    initialSyncDays: Math.max(0, Math.floor(opts.initialSyncDays ?? DEFAULT_SYNC_POLICY.initialSyncDays)),
    initialSyncMaxMessages: Math.max(1, Math.floor(opts.initialSyncMaxMessages ?? DEFAULT_SYNC_POLICY.initialSyncMaxMessages)),
  };

  const report: MailboxDoctorReport = {
    address: opts.address,
    imap: { ok: false, error: null, tookMs: 0, host: opts.imap.host, port: opts.imap.port, secure: opts.imap.secure, user: opts.imap.user, capabilities: [] },
    mailbox: { name: mailboxName, readOnly: true, exists: null, uidValidity: null, uidNext: null, error: null },
    folders: { listed: false, error: null, all: [], sent: null },
    firstSync: { policy, wouldIngest: 0, totalInMailbox: null, windows: [], error: null },
    samples: [],
    smtp: { ok: false, error: null, tookMs: 0, host: opts.smtp.host, port: opts.smtp.port, secure: opts.smtp.secure, user: opts.smtp.user },
    sendTest: { attempted: false, to: null, messageId: null, response: null, accepted: [], rejected: [], error: null },
  };

  // ---- IMAP -------------------------------------------------------------
  const t0 = Date.now();
  const client = (opts.createImapClient ?? defaultImapFactory)(opts.imap, timeoutMs);
  client.on?.("error", () => {});
  try {
    try {
      await timed(() => client.connect(), timeoutMs, "IMAP connect/login", () => client.close?.());
      report.imap.ok = true;
      report.imap.capabilities = client.capabilities ? [...client.capabilities.keys()].map(String).slice(0, 60) : [];
    } catch (err) {
      report.imap.error = describeMailError(err, "imap", secrets);
    }
    report.imap.tookMs = Date.now() - t0;

    if (report.imap.ok) {
      // folders (independent of the mailbox open below)
      try {
        const folders: FolderInfo[] = client.list ? await timed(() => client.list!(), timeoutMs, "IMAP LIST") : [];
        report.folders.listed = true;
        report.folders.all = folders.slice(0, 80).map((f) => ({ path: f.path, specialUse: f.specialUse ?? null }));
        report.folders.sent = pickSentFolder(folders, opts.sentFolder);
      } catch (err) {
        report.folders.error = describeMailError(err, "imap", secrets);
      }

      // the mailbox, read-only
      let mailbox: { uidValidity: bigint; uidNext: number; exists?: number } | null = null;
      try {
        mailbox = await timed(() => client.mailboxOpen(mailboxName, { readOnly: true }), timeoutMs, "IMAP EXAMINE");
        report.mailbox.exists = mailbox.exists ?? null;
        report.mailbox.uidValidity = mailbox.uidValidity.toString();
        report.mailbox.uidNext = mailbox.uidNext;
      } catch (err) {
        report.mailbox.error = describeMailError(err, "imap", secrets);
      }

      if (mailbox) {
        // first-sync forecast
        try {
          report.firstSync.totalInMailbox = mailbox.exists ?? null;
          const plan = await timed(() => resolveStartUid(client, mailbox!, null, policy, now, mailboxName), timeoutMs, "IMAP SEARCH");
          report.firstSync.wouldIngest = plan.startUid >= mailbox.uidNext ? 0 : Math.min(plan.candidates, policy.initialSyncMaxMessages);
          if (client.search) {
            for (const days of DOCTOR_WINDOWS_DAYS) {
              const since = new Date(now.getTime() - days * 86_400_000);
              const found = await timed(() => client.search!({ since }, { uid: true }), timeoutMs, "IMAP SEARCH");
              report.firstSync.windows.push({ days, count: (found || []).filter((u) => u < mailbox!.uidNext).length });
            }
          }
        } catch (err) {
          report.firstSync.error = describeMailError(err, "imap", secrets);
        }

        // newest N messages, fetched with BODY.PEEK[] (by sequence number so a huge mailbox is not enumerated)
        const exists = mailbox.exists ?? 0;
        if (sampleN > 0 && exists > 0) {
          try {
            const first = Math.max(1, exists - sampleN + 1);
            const collected: { uid: number; source?: Buffer; internalDate?: Date | string }[] = [];
            await timed(
              async () => {
                for await (const msg of client.fetch(`${first}:*`, { uid: true, source: true, internalDate: true }, {})) collected.push(msg);
              },
              timeoutMs * 2,
              "IMAP FETCH",
            );
            for (const msg of collected.slice(-sampleN)) {
              const arrivedAt = msg.internalDate ? new Date(msg.internalDate).toISOString() : null;
              if (!msg.source) {
                report.samples.push({ providerId: String(msg.uid), arrivedAt, parsed: null, parseError: "server returned no message body" });
                continue;
              }
              try {
                report.samples.push({ providerId: String(msg.uid), arrivedAt, parsed: await parseRawEmail(msg.source, String(msg.uid)), parseError: null });
              } catch (err) {
                report.samples.push({ providerId: String(msg.uid), arrivedAt, parsed: null, parseError: (err as Error).message });
              }
            }
          } catch (err) {
            report.firstSync.error = report.firstSync.error ?? describeMailError(err, "imap", secrets);
          }
        }
      }
    }
  } finally {
    try {
      await client.logout();
    } catch {
      try {
        client.close?.();
      } catch {
        // gone
      }
    }
  }

  // ---- SMTP -------------------------------------------------------------
  const t1 = Date.now();
  const transport = (opts.createSmtpTransport ?? defaultSmtpFactory)(opts.smtp, timeoutMs);
  try {
    try {
      await timed(() => transport.verify(), timeoutMs, "SMTP check", () => transport.close());
      report.smtp.ok = true;
    } catch (err) {
      report.smtp.error = describeMailError(err, "smtp", secrets);
    }
    report.smtp.tookMs = Date.now() - t1;

    // ---- the one optional send --------------------------------------------
    if (opts.sendTest) {
      const to = opts.sendTest.to.trim();
      report.sendTest.to = to;
      if (!EMAIL_RE.test(to)) {
        report.sendTest.error = `"${to}" is not a valid email address; nothing was sent`;
      } else if (!report.smtp.ok) {
        report.sendTest.error = "SMTP authentication failed above; nothing was sent";
      } else {
        report.sendTest.attempted = true;
        const domain = opts.address.split("@")[1] || "localhost";
        const messageId = newMessageId(domain);
        report.sendTest.messageId = messageId;
        try {
          const info = await timed(
            () =>
              transport.sendMail({
                from: opts.displayName ? { name: opts.displayName, address: opts.address } : opts.address,
                to,
                subject: `agy-hq email doctor test ${now.toISOString()}`,
                text: "This is a single test message from `hq email doctor --send-test`. It was sent to check that this mailbox can send. No action is needed.",
                messageId,
                headers: { "X-Agyhq-Doctor": "test", "Auto-Submitted": "auto-generated" },
              }),
            timeoutMs,
            "SMTP send",
            () => transport.close(),
          );
          report.sendTest.response = typeof info.response === "string" ? info.response : null;
          report.sendTest.accepted = (info.accepted ?? []).map((a) => (typeof a === "string" ? a : a.address));
          report.sendTest.rejected = (info.rejected ?? []).map((a) => (typeof a === "string" ? a : a.address));
        } catch (err) {
          report.sendTest.error = describeMailError(err, "smtp", secrets);
        }
      }
    }
  } finally {
    transport.close();
  }

  return report;
}
