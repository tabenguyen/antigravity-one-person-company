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
  /** Opt in with `enableSentSync()`; then `deliverSent()` + `fetchSent()` behave like a Sent folder. */
  syncsSent = false;

  #inbox: ParsedEmail[] = [];
  #sentFolder: ParsedEmail[] = [];
  #sentError: Error | null = null;
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

  /** Turn on Sent-folder sync for this fake. */
  enableSentSync(): void {
    this.syncsSent = true;
  }

  /** Put a message in the (fake) Sent folder, as if the human sent it from their own mail client. */
  deliverSent(msg: Partial<ParsedEmail> & { to: EmailAddress[] }): ParsedEmail {
    const text = msg.text ?? "";
    const email: ParsedEmail = {
      providerId: msg.providerId ?? `sent-${this.#sentFolder.length}`,
      messageId: normalizeMessageId(msg.messageId) ?? newMessageId("human.test"),
      inReplyTo: normalizeMessageId(msg.inReplyTo ?? null),
      references: msg.references ?? [],
      from: msg.from ?? { address: "owner@ourco.example", name: null },
      to: msg.to,
      cc: msg.cc ?? [],
      replyTo: null,
      subject: msg.subject ?? null,
      date: msg.date ?? nowIso(),
      text,
      replyText: msg.replyText ?? extractReplyText(text),
      headers: msg.headers ?? {},
      attachments: msg.attachments ?? [],
    };
    this.#sentFolder.push(email);
    return email;
  }

  /** The next `fetchSent()` rejects with this error (one-shot), e.g. "could not find the Sent folder". */
  failNextFetchSent(err: Error): void {
    this.#sentError = err;
  }

  async fetchSent(cursor: string | null, opts: { limit?: number } = {}): Promise<FetchResult & { folder: string }> {
    if (!this.syncsSent) throw new Error("Sent-folder sync is not enabled");
    if (this.#sentError) {
      const err = this.#sentError;
      this.#sentError = null;
      throw err;
    }
    const limit = opts.limit ?? 50;
    // null cursor = "from now": nothing that is already in the folder.
    const start = cursor === null ? this.#sentFolder.length : Number(cursor) + 1;
    const slice = this.#sentFolder.slice(start, start + limit);
    const cursorOut = slice.length > 0 ? String(start + slice.length - 1) : cursor === null ? String(this.#sentFolder.length - 1) : cursor;
    return { messages: slice, cursor: cursorOut, folder: "Sent" };
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
