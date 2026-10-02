// In-memory EmailProvider for daemon tests: `deliver()` queues an inbound
// message, `fetchNew` drains it like a real provider would, `send` records
// outgoing mail instead of transmitting it.

import { nowIso } from "@agyhq/core";
import type { EmailAddress, EmailProvider, FetchResult, OutgoingEmail, ParsedEmail, SendResult } from "@agyhq/core";

import { extractReplyText } from "../reply-text.ts";
import { newMessageId, normalizeMessageId } from "../message-id.ts";

export class FakeEmailProvider implements EmailProvider {
  readonly kind = "fake";
  readonly sent: OutgoingEmail[] = [];

  #inbox: ParsedEmail[] = [];
  #seq = 0;
  #nextSendError: Error | null = null;
  #verifyResult: { ok: true } | { ok: false; error: string } = { ok: true };

  /** Queue an inbound message. Fills in realistic defaults for anything not provided. */
  deliver(msg: Partial<ParsedEmail> & { from: EmailAddress }): ParsedEmail {
    const text = msg.text ?? "";
    const email: ParsedEmail = {
      providerId: msg.providerId ?? String(this.#seq),
      messageId: normalizeMessageId(msg.messageId) ?? newMessageId("fake.test"),
      inReplyTo: normalizeMessageId(msg.inReplyTo ?? null),
      references: msg.references ?? [],
      from: msg.from,
      to: msg.to ?? [],
      cc: msg.cc ?? [],
      replyTo: msg.replyTo ?? null,
      subject: msg.subject ?? null,
      date: msg.date ?? nowIso(),
      text,
      replyText: msg.replyText ?? extractReplyText(text),
      headers: msg.headers ?? {},
      attachments: msg.attachments ?? [],
    };
    this.#inbox.push(email);
    this.#seq += 1;
    return email;
  }

  async fetchNew(cursor: string | null, opts: { limit?: number } = {}): Promise<FetchResult> {
    const limit = opts.limit ?? 50;
    const start = cursor === null ? 0 : Number(cursor) + 1;
    const slice = this.#inbox.slice(start, start + limit);
    const cursorOut = slice.length > 0 ? String(start + slice.length - 1) : cursor;
    return { messages: slice, cursor: cursorOut };
  }

  async send(email: OutgoingEmail): Promise<SendResult> {
    if (this.#nextSendError) {
      const err = this.#nextSendError;
      this.#nextSendError = null;
      throw err;
    }
    this.sent.push(email);
    return {
      messageId: email.messageId,
      response: "250 OK (fake)",
      accepted: [email.to.address],
      rejected: [],
    };
  }

  async verify(): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.#verifyResult;
  }

  async close(): Promise<void> {
    // nothing to release
  }

  /** The next call to `send()` throws this error instead of succeeding (one-shot). */
  failNextSend(err: Error): void {
    this.#nextSendError = err;
  }

  /** Controls what `verify()` returns from now on. */
  setVerify(result: { ok: true } | { ok: false; error: string }): void {
    this.#verifyResult = result;
  }
}
