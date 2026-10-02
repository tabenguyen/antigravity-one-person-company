// "Test connection" for the setup wizard: checks IMAP and SMTP separately against settings that are not saved yet.
// channels' ImapSmtpProvider.verify() is a combined, first-failure-wins check that doesn't open the mailbox, so the
// wizard uses its own small checkers (imapflow / nodemailer directly): IMAP = connect + log in + open the configured
// mailbox read-only; SMTP = connect + (STARTTLS) + log in. Each is capped at ~20s and error text never contains the
// password.

import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import type { EmailConfig } from "../config.ts";

export const EMAIL_TEST_TIMEOUT_MS = 20_000;

export interface MailServerCfg {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/** Each returns normally on success and throws on failure. Injectable for tests. */
export interface EmailCheckers {
  imap(cfg: MailServerCfg, mailbox: string, timeoutMs: number): Promise<void>;
  smtp(cfg: MailServerCfg, timeoutMs: number): Promise<void>;
}

export interface EmailTestOutcome {
  imap: { ok: boolean; error: string | null };
  smtp: { ok: boolean; error: string | null };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // best-effort teardown
      }
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export const defaultCheckers: EmailCheckers = {
  async imap(cfg, mailbox, timeoutMs) {
    const client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false,
      socketTimeout: timeoutMs,
      connectionTimeout: timeoutMs,
    });
    // ImapFlow emits 'error' on socket problems; without a listener that would crash the process.
    client.on("error", () => {});
    try {
      await withTimeout(
        (async () => {
          await client.connect();
          const lock = await client.getMailboxLock(mailbox, { readOnly: true });
          lock.release();
        })(),
        timeoutMs,
        "IMAP check",
        () => client.close(),
      );
    } finally {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
  },
  async smtp(cfg, timeoutMs) {
    const transport = createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
    });
    try {
      await withTimeout(transport.verify(), timeoutMs, "SMTP check", () => transport.close());
    } finally {
      transport.close();
    }
  },
};

/** Strip anything that looks like the password from an error message before it leaves the process. */
function scrub(message: string, secrets: string[]): string {
  let out = message;
  for (const s of secrets) if (s.length >= 3) out = out.split(s).join("***");
  return out.length > 500 ? `${out.slice(0, 497)}...` : out;
}

async function run(fn: () => Promise<void>, secrets: string[]): Promise<{ ok: boolean; error: string | null }> {
  try {
    await fn();
    return { ok: true, error: null };
  } catch (err) {
    const e = err as Error & { responseText?: string; response?: string };
    const detail = e.responseText || e.response;
    const msg = e.message && detail && !e.message.includes(detail) ? `${e.message} (${detail})` : (e.message ?? String(err));
    return { ok: false, error: scrub(msg, secrets) };
  }
}

export async function testEmailConfig(
  cfg: EmailConfig,
  checkers: EmailCheckers = defaultCheckers,
  timeoutMs = EMAIL_TEST_TIMEOUT_MS,
): Promise<EmailTestOutcome> {
  if (cfg.kind === "none") {
    const error = "Email is switched off (kind \"none\"); choose imap-smtp to test a mailbox.";
    return { imap: { ok: false, error }, smtp: { ok: false, error } };
  }
  if (cfg.kind === "maildir") {
    // Local dev provider: "inbox" = readable/creatable directory, "send" = writable sent/ directory.
    const check = (sub: string) => async () => {
      const dir = path.join(cfg.root, sub);
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    };
    return { imap: await run(check("inbox"), []), smtp: await run(check("sent"), []) };
  }
  const secrets = [cfg.imap.pass, cfg.smtp.pass];
  const [imap, smtp] = await Promise.all([
    cfg.imap.pass
      ? run(() => checkers.imap(cfg.imap, cfg.mailbox ?? "INBOX", timeoutMs), secrets)
      : Promise.resolve({ ok: false, error: "No IMAP password given and none stored." }),
    cfg.smtp.pass
      ? run(() => checkers.smtp(cfg.smtp, timeoutMs), secrets)
      : Promise.resolve({ ok: false, error: "No SMTP password given and none stored." }),
  ]);
  return { imap, smtp };
}
