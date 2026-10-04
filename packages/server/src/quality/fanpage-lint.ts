// Fanpage-Manager-only lint rules for Facebook drafts (Vietnamese + English), on top of the shared rules in lint.ts
// (placeholders, prices not in the knowledge base, forbidden claims, AI self-reference, guarantee language).
//
//   news_missing_source   error  a `news` post must quote the source URL it was given
//   unsourced_stat        error  a percentage or a customer/user count that the knowledge base does not contain
//                                ("numbers come from tools, never from the model's head", docs/PLAN.md section 5)
//   fb_reply_too_long     warn   a public reply should be a couple of sentences
//   fb_too_many_hashtags  warn   more than 5 hashtags
//
// Replies additionally get the Account Manager promise rules (no refund / discount / SLA / delivery-date promises in public).
// Pure: the db-backed context (KB text, forbidden claims) is built by lint-context.ts.

import type { LintFinding } from "@agyhq/core";
import { lintAccountManagerPromises } from "./am-lint.ts";

export interface FanpageDraftSpec {
  kind: "post" | "reply";
  postType?: string | null;
  /** The URL the task gave for a news post. */
  sourceUrl?: string | null;
  link?: string | null;
}

export const FANPAGE_LINT_LIMITS = { replyMaxWords: 90, maxHashtags: 5 } as const;

/** Compare URLs without scheme, "www.", query/fragment and trailing slash, so "https://www.vnexpress.net/a-1.html?x=1" matches "vnexpress.net/a-1.html". */
export function normalizeUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

export function mentionsUrl(text: string, url: string): boolean {
  const wanted = normalizeUrl(url);
  if (!wanted) return false;
  return text.toLowerCase().replace(/https?:\/\/(www\.)?/g, "").includes(wanted);
}

const COUNT_NOUNS =
  String.raw`(?:khách hàng|người dùng|doanh nghiệp|công ty|cửa hàng|hóa đơn|hoá đơn|tổ chức|customers?|users?|businesses|companies|stores|invoices|clients)`;
const RE_PCT = /(?<![\p{L}\p{N}.,])(\d{1,3}(?:[.,]\d+)?)\s?%/gu;
const RE_COUNT = new RegExp(`(?<![\\p{L}\\p{N}.,])(\\d{1,3}(?:[.,]\\d{3})+|\\d{2,})\\s*\\+?\\s*${COUNT_NOUNS}`, "giu");

const digits = (s: string): string => s.replace(/[^\d]/g, "");

/** Does `kb` contain this number (as a percentage when `pct`, else as a plain/grouped number)? */
function kbHasNumber(kb: string, raw: string, pct: boolean): boolean {
  if (pct) {
    const n = raw.replace(",", ".").replace(/\.0+$/, "").replace(".", "[.,]");
    return new RegExp(`(?<![\\p{L}\\p{N}.,])${n}(?:[.,]0+)?\\s?%`, "u").test(kb);
  }
  const want = digits(raw);
  for (const m of kb.matchAll(/\d[\d.,]*/g)) if (digits(m[0]) === want) return true;
  return false;
}

/** Statistics in `text` that `kb` does not contain: "tăng 80% hiệu suất", "hơn 10.000 khách hàng". */
export function findUnsourcedStats(text: string, kb: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(RE_PCT)) if (!kbHasNumber(kb, m[1]!, true)) out.push(m[0].trim());
  for (const m of text.matchAll(RE_COUNT)) if (!kbHasNumber(kb, m[1]!, false)) out.push(m[0].trim());
  return [...new Set(out)];
}

const quote = (items: string[], max = 4): string => items.slice(0, max).map((i) => `"${i}"`).join(", ") + (items.length > max ? `, +${items.length - max} more` : "");

const words = (s: string): number => s.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;

export function lintFanpageDraft(spec: FanpageDraftSpec, body: string, kbText: string | (() => string)): LintFinding[] {
  const findings: LintFinding[] = [];
  const add = (code: string, severity: LintFinding["severity"], message: string) => findings.push({ code, severity, message });

  if (spec.kind === "post" && spec.postType === "news") {
    if (!spec.sourceUrl) {
      add("news_missing_source", "error", "A news post needs the source URL it was given. Without one, do not draft it: finish the task with status needs_human.");
    } else if (!mentionsUrl(`${body}\n${spec.link ?? ""}`, spec.sourceUrl)) {
      add("news_missing_source", "error", `The post does not quote its source (${spec.sourceUrl}). Put the exact source URL in the message (or as the link).`);
    }
  }

  if (/\d/.test(body)) {
    const kb = typeof kbText === "function" ? kbText() : kbText;
    const stats = findUnsourcedStats(body, kb);
    if (stats.length > 0) {
      add("unsourced_stat", "error", `Statistic not found in the knowledge base: ${quote(stats)}. Use only figures kb_search returns, or leave the number out.`);
    }
  }

  if (spec.kind === "reply") {
    const n = words(body);
    if (n > FANPAGE_LINT_LIMITS.replyMaxWords) add("fb_reply_too_long", "warn", `Reply is ${n} words; a public comment reply should be a couple of sentences (under ${FANPAGE_LINT_LIMITS.replyMaxWords}).`);
    findings.push(...lintAccountManagerPromises(body));
  }

  const hashtags = body.match(/(?<![\p{L}\p{N}])#[\p{L}\p{N}_]+/gu) ?? [];
  if (hashtags.length > FANPAGE_LINT_LIMITS.maxHashtags) add("fb_too_many_hashtags", "warn", `${hashtags.length} hashtags (aim for at most ${FANPAGE_LINT_LIMITS.maxHashtags}).`);

  return findings;
}
