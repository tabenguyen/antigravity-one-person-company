// Pure, provider-independent heuristics over an already-parsed email.
// Routing/policy decisions based on these signals live in the daemon.

import type { EmailSignals, ParsedEmail } from "@agyhq/core";

const OOO_SUBJECT_PATTERNS = [
  /out of office/i,
  /automatic reply/i,
  /^auto:/i,
  /trả lời tự động/i,
  /vắng mặt/i,
];

// Phrases, not bare words: a bare "stop" would false-positive on messages like
// "please don't stop emailing me" or "stop by our booth", so every pattern
// below requires the word alongside enough context to mean "take me off this
// list" (en + vi). Checked against `replyText` (quoted history stripped) and
// only when that text is short — a long email that happens to mention one of
// these phrases in passing (e.g. explaining a product feature) is not an
// unsubscribe request.
const UNSUBSCRIBE_PATTERNS = [
  /unsubscribe/i,
  /remove me/i,
  /stop emailing/i,
  /opt out/i,
  /opt-out/i,
  /hủy đăng ký/i,
  /huỷ đăng ký/i,
  /ngừng gửi/i,
  /không muốn nhận/i,
];
const UNSUBSCRIBE_MAX_LENGTH = 400;

export interface ClassifyOptions {
  /** Our own mailbox addresses (lowercased or not). Mail from one of these is never unsubscribe/bounce signal. */
  ourAddresses: string[];
}

export function classifyEmail(email: ParsedEmail, opts: ClassifyOptions): EmailSignals {
  const ourAddresses = new Set((opts.ourAddresses ?? []).map((a) => a.toLowerCase()));
  const fromIsOurs = email.from ? ourAddresses.has(email.from.address.toLowerCase()) : false;

  const isAutoReply = computeIsAutoReply(email);

  const contentType = (email.headers["content-type"] ?? "").toLowerCase();
  const fromLocalPart = email.from?.address.split("@")[0]?.toLowerCase() ?? "";
  const isFromMailerDaemon = fromLocalPart === "mailer-daemon" || fromLocalPart === "postmaster";
  const isMultipartReport = contentType.startsWith("multipart/report");
  const isBounce = !fromIsOurs && (isFromMailerDaemon || isMultipartReport);
  const bouncedRecipient = isBounce ? extractBouncedRecipient(email) : null;

  const replyText = email.replyText.trim();
  const isUnsubscribe =
    !fromIsOurs &&
    replyText.length > 0 &&
    replyText.length < UNSUBSCRIBE_MAX_LENGTH &&
    UNSUBSCRIBE_PATTERNS.some((re) => re.test(replyText));

  const isLikelySpam = /^yes$/i.test((email.headers["x-spam-flag"] ?? "").trim());

  return { isAutoReply, isBounce, bouncedRecipient, isUnsubscribe, isLikelySpam };
}

function computeIsAutoReply(email: ParsedEmail): boolean {
  const autoSubmitted = email.headers["auto-submitted"]?.trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;

  if (email.headers["x-autoreply"] !== undefined) return true;
  if (email.headers["x-autorespond"] !== undefined) return true;

  const precedence = email.headers["precedence"]?.trim().toLowerCase();
  if (precedence === "auto_reply" || precedence === "bulk" || precedence === "junk") return true;

  const subject = email.subject ?? "";
  if (OOO_SUBJECT_PATTERNS.some((re) => re.test(subject))) return true;

  return false;
}

/**
 * Pull the bounced recipient out of a DSN (delivery status notification).
 * Prefers the X-Failed-Recipients header; falls back to scanning the body for
 * a "Final-Recipient:"/"Original-Recipient:" line from the embedded
 * message/delivery-status part (mailparser folds that part into `text`).
 */
function extractBouncedRecipient(email: ParsedEmail): string | null {
  const headerValue = email.headers["x-failed-recipients"];
  if (headerValue) {
    const first = headerValue.split(",")[0]?.trim();
    if (first) return first.toLowerCase();
  }

  const match =
    email.text.match(/Final-Recipient:\s*(?:rfc822|RFC822);\s*([^\s,]+)/i) ??
    email.text.match(/Original-Recipient:\s*(?:rfc822|RFC822);\s*([^\s,]+)/i);
  if (match?.[1]) return match[1].toLowerCase();

  return null;
}
