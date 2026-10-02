// Shared helpers for turning an @agyhq/core OutgoingEmail into nodemailer mail
// options / a rendered RFC 822 buffer. Used by both ImapSmtpProvider (real
// SMTP send + optional sent-folder append) and MaildirProvider (writes a
// realistic .eml to root/sent/).

import { createTransport } from "nodemailer";
import type { SendMailOptions } from "nodemailer";
import type { EmailAddress, OutgoingEmail } from "@agyhq/core";

export function formatAddress(addr: EmailAddress): string {
  if (!addr.name) return addr.address;
  return `"${addr.name.replace(/"/g, '\\"')}" <${addr.address}>`;
}

export function addressToPlainString(a: string | { address: string }): string {
  return typeof a === "string" ? a : a.address;
}

/**
 * Build the nodemailer SendMailOptions for an OutgoingEmail. messageId/
 * inReplyTo/references are passed WITHOUT angle brackets — nodemailer's
 * mime-node wraps Message-ID/In-Reply-To/References values in `<>` itself if
 * they aren't already, so this reproduces exactly the id the caller asked for.
 */
export function mailOptionsFor(email: OutgoingEmail, from: EmailAddress): SendMailOptions {
  return {
    from: formatAddress(from),
    to: formatAddress(email.to),
    subject: email.subject,
    text: email.text,
    messageId: email.messageId,
    inReplyTo: email.inReplyTo ?? undefined,
    references: email.references && email.references.length > 0 ? email.references : undefined,
    headers: {
      ...(email.listUnsubscribe ? { "List-Unsubscribe": email.listUnsubscribe } : {}),
      ...(email.headers ?? {}),
    },
  };
}

/** Render an OutgoingEmail as a real RFC 822 MIME buffer (for maildir / sent-folder append). */
export async function buildMimeBuffer(email: OutgoingEmail, from: EmailAddress): Promise<Buffer> {
  const transport = createTransport({ streamTransport: true, buffer: true });
  const info = await transport.sendMail(mailOptionsFor(email, from));
  return info.message as Buffer;
}
