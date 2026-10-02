// Dev/test EmailProvider backed by a plain directory tree:
//   root/inbox/*.eml  — inbound messages, processed in filename order
//   root/sent/<messageId>.eml — written on send()
//
// There's no mailbox-level cursor concept here (no UIDVALIDITY/UIDNEXT), so
// the cursor is simply the last processed filename; fetchNew resumes right
// after it in sorted order. If that file is no longer present (deleted
// between runs) we restart from the beginning of the directory rather than
// erroring — duplicates are preferable to silently dropping mail.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { EmailAddress, EmailProvider, FetchResult, OutgoingEmail, SendResult } from "@agyhq/core";

import { parseRawEmail } from "../parse.ts";
import { addressToPlainString, buildMimeBuffer } from "../mime.ts";

export interface MaildirProviderOptions {
  root: string;
  address: string;
  displayName?: string;
}

export class MaildirProvider implements EmailProvider {
  readonly kind = "maildir";

  #root: string;
  #from: EmailAddress;

  constructor(opts: MaildirProviderOptions) {
    this.#root = opts.root;
    this.#from = { address: opts.address.toLowerCase(), name: opts.displayName ?? null };
  }

  #inboxDir(): string {
    return path.join(this.#root, "inbox");
  }

  #sentDir(): string {
    return path.join(this.#root, "sent");
  }

  async fetchNew(cursor: string | null, opts: { limit?: number } = {}): Promise<FetchResult> {
    const limit = opts.limit ?? 50;
    await mkdir(this.#inboxDir(), { recursive: true });
    const entries = (await readdir(this.#inboxDir())).filter((f) => f.endsWith(".eml")).sort();

    let startIdx = 0;
    if (cursor !== null) {
      const idx = entries.indexOf(cursor);
      // idx === -1 (cursor file gone) restarts from the top, by design.
      startIdx = idx === -1 ? 0 : idx + 1;
    }

    const slice = entries.slice(startIdx, startIdx + limit);
    const messages = await Promise.all(
      slice.map(async (filename) => {
        const raw = await readFile(path.join(this.#inboxDir(), filename));
        return parseRawEmail(raw, filename);
      }),
    );

    const cursorOut = slice.length > 0 ? slice[slice.length - 1]! : cursor;
    return { messages, cursor: cursorOut };
  }

  async send(email: OutgoingEmail): Promise<SendResult> {
    await mkdir(this.#sentDir(), { recursive: true });
    const mime = await buildMimeBuffer(email, this.#from);
    await writeFile(path.join(this.#sentDir(), `${email.messageId}.eml`), mime);
    return {
      messageId: email.messageId,
      response: "250 OK (maildir)",
      accepted: [addressToPlainString(email.to.address)],
      rejected: [],
    };
  }

  async verify(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await mkdir(this.#inboxDir(), { recursive: true });
      await mkdir(this.#sentDir(), { recursive: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async close(): Promise<void> {
    // nothing to release
  }
}
