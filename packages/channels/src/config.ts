// The config shape the daemon persists/loads, and the factory that turns it
// into a live EmailProvider. Kept separate from ImapSmtpProvider/MaildirProvider
// themselves so those classes stay directly constructible (with injectable
// IMAP client / SMTP transport factories) for tests.

import type { EmailProvider } from "@agyhq/core";

import { ImapSmtpProvider } from "./providers/imap-smtp.ts";
import { MaildirProvider } from "./providers/maildir.ts";

export type EmailProviderConfig =
  | {
      kind: "imap-smtp";
      address: string;
      displayName?: string;
      imap: { host: string; port: number; secure: boolean; user: string; pass: string };
      smtp: { host: string; port: number; secure: boolean; user: string; pass: string };
      /** @default "INBOX" */
      mailbox?: string;
      /** Append a copy of every sent message here; null = don't (Gmail saves SMTP sends itself). */
      sentFolder?: string | null;
      /** Opt-in: also read the Sent folder (what the human sent from their own mail client). @default false */
      syncSent?: boolean;
      /** First-sync window in days; 0 = only mail arriving after the first connection. @default 0 */
      initialSyncDays?: number;
      /** Cap on existing mail a first sync / UIDVALIDITY resync may pull in. @default 200 */
      initialSyncMaxMessages?: number;
    }
  | { kind: "maildir"; root: string; address: string; displayName?: string }
  | { kind: "none" };

export function createEmailProvider(cfg: EmailProviderConfig): EmailProvider | null {
  switch (cfg.kind) {
    case "imap-smtp":
      return new ImapSmtpProvider({
        address: cfg.address,
        displayName: cfg.displayName,
        imap: cfg.imap,
        smtp: cfg.smtp,
        mailbox: cfg.mailbox,
        sentFolder: cfg.sentFolder,
        syncSent: cfg.syncSent,
        initialSyncDays: cfg.initialSyncDays,
        initialSyncMaxMessages: cfg.initialSyncMaxMessages,
      });
    case "maildir":
      return new MaildirProvider({ root: cfg.root, address: cfg.address, displayName: cfg.displayName });
    case "none":
      return null;
    default: {
      const exhaustive: never = cfg;
      throw new Error(`channels: unknown email provider kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
