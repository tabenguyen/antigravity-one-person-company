// Turns a raw RFC 822 message (whatever a provider handed us — an IMAP
// BODY.PEEK[] fetch, a maildir .eml file, a webhook payload's raw blob) into
// the normalized @agyhq/core ParsedEmail shape.

import { simpleParser } from "mailparser";
import type {
  AddressObject,
  EmailAddress as MailAddress,
  HeaderValue,
  ParsedMail,
  StructuredHeader,
} from "mailparser";
import type { EmailAddress, ParsedEmail } from "@agyhq/core";

import { extractReplyText } from "./reply-text.ts";
import { normalizeMessageId } from "./message-id.ts";

// Header names classification needs (see @agyhq/core's EmailSignals and
// classify.ts). Keeping this list narrow avoids leaking arbitrary mail
// headers into the agent-visible ParsedEmail payload.
const HEADER_SUBSET = [
  "auto-submitted",
  "x-autoreply",
  "x-autorespond",
  "precedence",
  "x-spam-flag",
  "x-spam-status",
  "content-type",
  "list-unsubscribe",
  "x-failed-recipients",
  "return-path",
] as const;

export async function parseRawEmail(raw: Buffer | string, providerId: string): Promise<ParsedEmail> {
  // skipHtmlToText defaults to false, i.e. mailparser already fills `text`
  // from the HTML part when there is no text/plain part — that covers the
  // "text from text part or html→text" requirement for us.
  const mail = await simpleParser(raw);

  const text = mail.text ?? "";

  return {
    providerId,
    messageId: normalizeMessageId(mail.messageId ?? null),
    inReplyTo: normalizeMessageId(mail.inReplyTo ?? null),
    references: normalizeReferences(mail.references),
    from: firstAddress(mail.from),
    to: flattenAddresses(mail.to),
    cc: flattenAddresses(mail.cc),
    replyTo: firstAddress(mail.replyTo),
    subject: mail.subject ?? null,
    date: mail.date ? mail.date.toISOString() : null,
    text,
    replyText: extractReplyText(text),
    headers: extractHeaders(mail),
    attachments: mail.attachments.map((a) => ({
      filename: a.filename ?? null,
      contentType: a.contentType,
      size: a.size,
      content: a.content,
    })),
  };
}

function normalizeReferences(refs: string[] | string | undefined): string[] {
  if (!refs) return [];
  const list = Array.isArray(refs) ? refs : [refs];
  const out: string[] = [];
  for (const r of list) {
    const normalized = normalizeMessageId(r);
    if (normalized) out.push(normalized);
  }
  return out;
}

function flattenAddresses(input: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (!input) return [];
  const objs = Array.isArray(input) ? input : [input];
  const out: EmailAddress[] = [];
  const visit = (entries: MailAddress[]): void => {
    for (const entry of entries) {
      if (entry.group && entry.group.length) {
        visit(entry.group);
        continue;
      }
      if (!entry.address) continue;
      out.push({ address: entry.address.toLowerCase().trim(), name: entry.name ? entry.name.trim() : null });
    }
  };
  for (const obj of objs) visit(obj.value);
  return out;
}

function firstAddress(input: AddressObject | undefined): EmailAddress | null {
  if (!input) return null;
  return flattenAddresses(input)[0] ?? null;
}

function extractHeaders(mail: ParsedMail): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of HEADER_SUBSET) {
    // mailparser folds every "List-*" header (List-Unsubscribe, List-Id, ...)
    // into a single structured "list" entry on the headers Map, which loses
    // the raw value we need to pass through as-is. Read it from the raw
    // header lines instead; everything else in our subset round-trips fine
    // through the parsed headers Map.
    const value =
      name === "list-unsubscribe" ? headerLineValue(mail.headerLines, name) : headerToString(mail.headers.get(name));
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function headerLineValue(headerLines: ParsedMail["headerLines"], key: string): string | undefined {
  const entry = headerLines.find((h) => h.key === key);
  if (!entry) return undefined;
  const colonIdx = entry.line.indexOf(":");
  const raw = colonIdx === -1 ? "" : entry.line.slice(colonIdx + 1);
  // Un-fold continuation lines (CRLF + leading whitespace) into a single line.
  return raw.replace(/\r?\n[ \t]+/g, " ").trim();
}

/** Render any mailparser header value (string, list, address, date, structured) as plain text. */
function headerToString(value: HeaderValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    if (typeof value[0] === "string") return (value as string[]).join(", ");
    return (value as StructuredHeader[]).map(structuredToString).join(", ");
  }
  if ("value" in value && "params" in value) return structuredToString(value);
  if ("text" in value) return value.text; // AddressObject
  return String(value);
}

function structuredToString(header: StructuredHeader): string {
  const params = Object.entries(header.params ?? {}).map(([k, v]) => `${k}=${v}`);
  return params.length ? `${header.value}; ${params.join("; ")}` : header.value;
}
