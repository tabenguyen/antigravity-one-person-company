// Deterministic, bilingual (vi/en) lint for outbound email drafts. Pure: no
// db access (see lint-context.ts for the db-backed context builder). Every
// rule returns at most one LintFinding so the list stays readable in the
// Inbox and in the tool error shown to the agent.
//
// Severity policy: `error` blocks the draft at draft time (the agent must fix
// and draft again); `warn`/`info` are shown to the human reviewer only.

import type { LintFinding } from "@agyhq/core";

export interface LintDraft {
  subject: string | null | undefined;
  body: string;
  to?: string | null;
}

export interface LintContact {
  name?: string | null;
  language?: string | null;
  company?: string | null;
}

export interface LintProfile {
  meetingLink?: string | null;
  /** One forbidden phrase per line / bullet (markdown). */
  forbiddenClaims?: string | null;
}

export interface LintContext {
  contact?: LintContact | null;
  /** KB text used to ground prices; a function so it is only built when a money amount is present. */
  kbText?: string | (() => string);
  profile?: LintProfile | null;
  /** Agent role, e.g. "sales-sdr". */
  role?: string | null;
  /** True when this recipient already has a real thread (inbound mail from them, or a sent/approved email to them). */
  hasPriorThread?: boolean;
  /** Defaults to `!hasPriorThread`. */
  firstTouch?: boolean;
}

export const LINT_LIMITS = {
  firstTouchMaxWords: 180,
  anyMaxWords: 250,
  subjectMaxChars: 70,
  maxLinks: 2,
} as const;

// ---------------------------------------------------------------------------
// Text helpers

/** Lowercase, strip diacritics (incl. Vietnamese đ), collapse whitespace. For tolerant phrase matching. */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSpaces(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

function wordCount(text: string): number {
  const stripped = text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(">"))
    .join(" ");
  const m = stripped.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
  return m ? m.length : 0;
}

function quoteList(items: string[], max = 5): string {
  const shown = items.slice(0, max).map((i) => `"${i}"`);
  return shown.join(", ") + (items.length > max ? `, +${items.length - max} more` : "");
}

// ---------------------------------------------------------------------------
// Money / discount extraction (exported for tests)

export interface MoneyMention {
  raw: string;
  /** Canonical comparison key, e.g. "1500000:vnd", "10:usd", "pct:20". */
  key: string;
  /** Amount in base units (đồng / dollars); null for percentages. */
  value: number | null;
}

const NUM = String.raw`\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
const NOT_WORD_AFTER = String.raw`(?![\p{L}\p{N}])`;
const NOT_NUM_BEFORE = String.raw`(?<![\p{L}\p{N}.,])`;

const SUFFIX_UNITS = String.raw`triệu\s?đồng|triệu|nghìn\s?đồng|nghìn|ngàn|đồng|₫|đ|vnd|vnđ|usd|dollars?|k\s?(?:đ|vnd|vnđ)|k\s?\/\s?(?:tháng|thang|month|mo|năm|nam|year|yr|user|người|nguoi)`;
const RE_SUFFIX = new RegExp(`${NOT_NUM_BEFORE}(${NUM})\\s?(${SUFFIX_UNITS})${NOT_WORD_AFTER}`, "giu");
// "2tr" / "2tr5" style abbreviations only when attached to the number (a bare "5 tr" is too ambiguous).
const RE_TR = new RegExp(`${NOT_NUM_BEFORE}(${NUM})(tr)${NOT_WORD_AFTER}`, "giu");
const RE_PREFIX = new RegExp(
  `(?<![\\p{L}\\p{N}])(\\$|₫|vnd|vnđ|usd)\\s?(${NUM})(?:\\s?(k|m|mm|tr|triệu|million|thousand))?${NOT_WORD_AFTER}`,
  "giu",
);
const RE_PCT_AFTER = new RegExp(
  `${NOT_NUM_BEFORE}(${NUM})\\s?%\\s?(?:off|discount|giảm|chiết khấu|ưu đãi|khuyến mãi|sale)${NOT_WORD_AFTER}`,
  "giu",
);
const RE_PCT_BEFORE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:giảm(?:\\s+giá)?|discount(?:\\s+of)?|save|tiết kiệm|chiết khấu|ưu đãi|off)\\s+(?:up\\s+to\\s+|to\\s+|tới\\s+|đến\\s+|lên\\s+đến\\s+|lên\\s+tới\\s+)?(${NUM})\\s?%`,
  "giu",
);

function parseNumber(s: string): number {
  const hasDot = s.includes(".");
  const hasComma = s.includes(",");
  if (hasDot && hasComma) {
    const last = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
    return Number(`${s.slice(0, last).replace(/[.,]/g, "")}.${s.slice(last + 1)}`);
  }
  if (hasDot || hasComma) {
    const sep = hasDot ? "." : ",";
    const parts = s.split(sep);
    if (parts.length > 2 || parts[1]!.length === 3) return Number(parts.join(""));
    return Number(`${parts[0]}.${parts[1]}`);
  }
  return Number(s);
}

function multiplierFor(unit: string): { mult: number; cur: "vnd" | "usd" } {
  const u = fold(unit).replace(/\s+/g, "");
  if (u.startsWith("trieu") || u === "tr" || u === "m" || u === "mm" || u === "million") {
    return { mult: 1e6, cur: u === "m" || u === "mm" || u === "million" ? "usd" : "vnd" };
  }
  if (u.startsWith("nghin") || u.startsWith("ngan")) return { mult: 1e3, cur: "vnd" };
  if (u.startsWith("k")) return { mult: 1e3, cur: "vnd" };
  if (u === "usd" || u.startsWith("dollar")) return { mult: 1, cur: "usd" };
  return { mult: 1, cur: "vnd" }; // đ, ₫, đồng, vnd, vnđ
}

function mention(raw: string, value: number, cur: "vnd" | "usd"): MoneyMention {
  const v = Math.round(value * 100) / 100;
  return { raw: raw.trim(), key: `${v}:${cur}`, value: v };
}

/** All money amounts and percentage discounts in `text` (Vietnamese and English formats). */
export function extractMoney(text: string): MoneyMention[] {
  const out: MoneyMention[] = [];
  for (const m of text.matchAll(RE_SUFFIX)) {
    const { mult, cur } = multiplierFor(m[2]!);
    out.push(mention(m[0], parseNumber(m[1]!) * mult, cur));
  }
  for (const m of text.matchAll(RE_TR)) out.push(mention(m[0], parseNumber(m[1]!) * 1e6, "vnd"));
  for (const m of text.matchAll(RE_PREFIX)) {
    const sym = m[1]!.toLowerCase();
    const cur = sym === "$" || sym === "usd" ? "usd" : "vnd";
    let mult = 1;
    if (m[3]) {
      const s = m[3].toLowerCase();
      mult = s === "k" || s === "thousand" ? 1e3 : 1e6;
    }
    out.push(mention(m[0], parseNumber(m[2]!) * mult, cur));
  }
  for (const re of [RE_PCT_AFTER, RE_PCT_BEFORE]) {
    for (const m of text.matchAll(re)) {
      const v = parseNumber(m[1]!);
      out.push({ raw: m[0].trim(), key: `pct:${v}`, value: null });
    }
  }
  // Dedupe by raw text (a number can be matched by both the prefix and suffix regexes).
  const seen = new Set<string>();
  return out.filter((x) => {
    const k = `${x.raw.toLowerCase()}|${x.key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Bare numbers >= 1000 (a KB price table often omits the currency symbol). */
function bareLargeNumbers(text: string): Set<number> {
  const set = new Set<number>();
  for (const m of text.matchAll(new RegExp(`${NOT_NUM_BEFORE}(${NUM})`, "gu"))) {
    const v = parseNumber(m[1]!);
    if (Number.isFinite(v) && v >= 1000) set.add(v);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Rule helpers

const PLACEHOLDER_HTML_TAGS = new Set([
  "a", "b", "i", "u", "p", "br", "hr", "div", "span", "strong", "em", "ul", "ol", "li", "img", "table", "tr", "td",
  "th", "h1", "h2", "h3", "h4", "h5", "h6", "html", "body", "head", "blockquote", "pre", "code",
]);

function findPlaceholders(text: string): string[] {
  const found: string[] = [];
  const push = (s: string) => {
    if (!found.includes(s)) found.push(s);
  };
  for (const m of text.matchAll(/\{\{[^}\n]*\}\}/g)) push(m[0]);
  for (const m of text.matchAll(/\$?\{[A-Za-z_][\w .-]{0,30}\}/g)) push(m[0]);
  // [Name], [Your Company] — but not markdown links "[text](url)" or footnotes "[1]".
  for (const m of text.matchAll(/\[[^\]\n[]{1,40}\](?!\()/g)) {
    if (/[A-Za-z\p{L}]/u.test(m[0]) && !/^\[\d+\]$/.test(m[0])) push(m[0]);
  }
  // <company>, <first name> — but not <https://…>, <a@b.c>, or html tags.
  for (const m of text.matchAll(/<([A-Za-z\p{L}][\p{L} _-]{0,30})>/gu)) {
    if (!PLACEHOLDER_HTML_TAGS.has(m[1]!.toLowerCase())) push(m[0]);
  }
  for (const m of text.matchAll(/\b(?:TODO|TBD|FIXME)\b/g)) push(m[0]);
  for (const m of text.matchAll(/\bX{3,}\b/g)) push(m[0]);
  for (const m of text.matchAll(/\blorem(?:\s+ipsum)?\b/gi)) push(m[0]);
  return found;
}

function forbiddenPhrases(raw: string): string[] {
  const phrases: string[] = [];
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line
      .replace(/^[-*•+>\d.)\s]+/, "")
      .replace(/^(?:never|do not|don't|không bao giờ|không được|đừng)\s+(?:say|claim|promise|nói|hứa|cam kết)\s*:?\s*/i, "")
      .trim();
    // Quoted fragments inside a longer rule ("Never say "we are the cheapest"") are the literal phrases.
    const quoted = [...cleaned.matchAll(/["“”'‘’«»]([^"“”'‘’«»]{4,})["“”'‘’«»]/g)].map((m) => m[1]!.trim());
    if (quoted.length > 0) phrases.push(...quoted);
    else {
      const bare = cleaned.replace(/^["“”'‘’«»]+|["“”'‘’«».;]+$/g, "").trim();
      if (bare.length >= 4) phrases.push(bare);
    }
  }
  return [...new Set(phrases)];
}

const GUARANTEE_PATTERNS: RegExp[] = [
  /\bguarantee[sd]?\b/i,
  /\b100\s?%/,
  /cam kết 100\s?%/i,
  /đảm bảo 100\s?%/i,
  /\brisk[- ]free\b/i,
  /\bno[- ]risk\b/i,
  /không (?:có )?rủi ro/i,
];

// Self-reference as a machine, or talk about how the agent works. Matched against selfRefText(): folded, with an
// upper-case "AI" token turned into "zzai" so Vietnamese "ai" ("who") never matches. Patterns are first-person on
// purpose — product copy like "NK Risk AI đánh giá rủi ro" or "phần mềm được thiết kế để…" is fine.
const SELF_REF_PATTERNS: RegExp[] = [
  /(?<![a-z])(?:em|toi|minh)\s+(?:chi\s+)?la\s+(?:mot\s+)?(?:zzai|bot|chatbot|may|tro ly(?!\s+(?:giam doc|kinh doanh)))(?![a-z])/,
  /(?<![a-z])tro ly\s+(?:ao|zzai|tu dong)(?![a-z])/,
  /(?<![a-z])(?:em|toi|minh)\s+(?:chi\s+)?(?:da\s+)?duoc\s+(?:thiet ke|lap trinh|huan luyen|dao tao|cai dat)(?![a-z])/,
  /(?<![a-z])(?:mo hinh ngon ngu|language model|llm|system prompt|hard rule)(?![a-z])/,
  /(?<![a-z])(?:i am|i'm|im|we are|we're)\s+(?:just\s+|only\s+)?(?:an?\s+)?(?:zzai|ai|bot|chatbot|virtual assistant|automated|artificial intelligence)(?![a-z])/,
  /(?<![a-z])as\s+an?\s+(?:zzai|ai|language model|automated)(?![a-z])/,
  /(?<![a-z])(?:i was|i've been|i have been|i am|i'm)\s+(?:designed|programmed|trained|built)(?![a-z])/,
  /(?<![a-z])(?:email|message|thu|tin nhan)\s+(?:nay\s+|this\s+)?(?:duoc\s+|was\s+|is\s+)?(?:gui|tao|soan|sent|generated|written)\s+(?:tu dong|automatically)(?![a-z])/,
];

function selfRefText(s: string): string {
  return fold(s.replace(/(?<![\p{L}\p{N}])AI(?![\p{L}\p{N}])/gu, "zzai"));
}

const SPAM_SUBJECT_PATTERNS: [RegExp, string][] = [
  [/!{2,}/, '"!!!"'],
  [/\bFREE\b/, '"FREE"'],
  [/\b100\s?%\s*free\b/i, '"100% free"'],
  [/miễn phí 100\s?%/i, '"miễn phí 100%"'],
  [/\${2,}/, '"$$$"'],
  [/\bact now\b/i, '"act now"'],
  [/\bclick here\b/i, '"click here"'],
  [/\blimited time\b/i, '"limited time"'],
];

const CTA_PHRASES = new RegExp(
  "(?<![\\p{L}\\p{N}])(?:reply|respond|let me know|let us know|book|schedule|set up a|grab a|hop on|jump on|free for|are you available|available|open to|worth a|send me|get back|call me|talk soon|chat|demo|trao đổi|liên hệ|phản hồi|trả lời|đặt lịch|hẹn|cuộc gọi|gọi|gặp|cho (?:tôi|mình|em|anh|chị) biết|báo (?:lại|em|mình|tôi)|xác nhận|rảnh)(?![\\p{L}\\p{N}])",
  "iu",
);

const MEETING_LINK = /(?:calendly\.com|cal\.com|meet\.google\.com|zoom\.us|teams\.microsoft\.com|hubspot\.com\/meetings|savvycal\.com|tidycal\.com|\/meetings?\/)/i;

const VI_CHARS = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/giu;
const EN_STOPWORDS = new Set([
  "the", "and", "is", "are", "we", "you", "your", "to", "of", "for", "with", "this", "that", "our", "can", "will", "have", "it", "in", "on",
]);

function languageOf(contact: LintContact | null | undefined): "vi" | "en" | null {
  const l = contact?.language?.toLowerCase().trim();
  if (!l) return null;
  if (l.startsWith("vi")) return "vi";
  if (l.startsWith("en")) return "en";
  return null;
}

function nameTokens(name: string): string[] {
  const honorifics = new Set(["anh", "chi", "chị", "em", "mr", "ms", "mrs", "dr", "ông", "bà", "mr.", "ms.", "dr."]);
  return name
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}]/gu, ""))
    .filter((t) => t.length >= 2 && !honorifics.has(t.toLowerCase()));
}

// ---------------------------------------------------------------------------
// The engine

const SEVERITY_ORDER: Record<LintFinding["severity"], number> = { error: 0, warn: 1, info: 2 };

export function lintDraft(draft: LintDraft, ctx: LintContext = {}): LintFinding[] {
  const subject = (draft.subject ?? "").trim();
  const body = draft.body ?? "";
  const all = `${subject}\n${body}`;
  const findings: LintFinding[] = [];
  const add = (code: string, severity: LintFinding["severity"], message: string) => findings.push({ code, severity, message });

  // placeholder ---------------------------------------------------------
  const placeholders = findPlaceholders(all);
  if (placeholders.length > 0) {
    add("placeholder", "error", `Unfilled placeholder text: ${quoteList(placeholders)}. Replace it with real content or remove it.`);
  }

  // unknown_price ---------------------------------------------------------
  const money = extractMoney(all);
  if (money.length > 0) {
    const kb = typeof ctx.kbText === "function" ? ctx.kbText() : (ctx.kbText ?? "");
    const kbNorm = normalizeSpaces(kb);
    const kbKeys = new Set(extractMoney(kb).map((m) => m.key));
    const kbBare = bareLargeNumbers(kb);
    const ungrounded = money.filter((m) => {
      if (kbKeys.has(m.key)) return false;
      if (kbNorm.includes(normalizeSpaces(m.raw))) return false;
      if (m.value !== null && m.value >= 1000 && kbBare.has(m.value)) return false;
      return true;
    });
    if (ungrounded.length > 0) {
      add(
        "unknown_price",
        "error",
        `Price/discount not found in the knowledge base: ${quoteList(ungrounded.map((m) => m.raw))}. Quote only published prices, or leave pricing out and offer a call.`,
      );
    }
  }

  // forbidden_claim -------------------------------------------------------
  if (ctx.profile?.forbiddenClaims) {
    const hay = fold(all);
    const hits = forbiddenPhrases(ctx.profile.forbiddenClaims).filter((p) => hay.includes(fold(p)));
    if (hits.length > 0) add("forbidden_claim", "error", `Contains a claim the company forbids: ${quoteList(hits)}.`);
  }

  // ai_self_reference -----------------------------------------------------
  const selfRef = selfRefText(all);
  const selfRefHits = SELF_REF_PATTERNS.map((re) => selfRef.match(re)?.[0]).filter((m): m is string => !!m);
  if (selfRefHits.length > 0) {
    add(
      "ai_self_reference",
      "error",
      `Talks about itself as an AI/bot/automated system or about how it works: ${quoteList(selfRefHits)}. Write as a person on the team: say what you can or can't help with, sign with your name, and leave out AI, automation, prompts and rules.`,
    );
  }

  // deceptive_subject -----------------------------------------------------
  if (/^\s*(?:re|fwd?|fw)\s*:/i.test(subject) && !ctx.hasPriorThread) {
    add("deceptive_subject", "error", 'Subject starts with "Re:"/"Fwd:" but there is no prior thread with this contact — that is a deceptive subject line.');
  }

  // guarantee_language ----------------------------------------------------
  const guarantee: string[] = [];
  for (const re of GUARANTEE_PATTERNS) {
    const m = all.match(re);
    if (m && !guarantee.some((g) => g.toLowerCase() === m[0].toLowerCase())) guarantee.push(m[0]);
  }
  if (guarantee.length > 0) {
    add("guarantee_language", "warn", `Guarantee/absolute language: ${quoteList(guarantee)}. Avoid promises the company has not approved.`);
  }

  // length ----------------------------------------------------------------
  const words = wordCount(body);
  const firstTouch = ctx.firstTouch ?? !ctx.hasPriorThread;
  if (words > LINT_LIMITS.anyMaxWords) {
    add("too_long", "warn", `Body is ${words} words (limit ${LINT_LIMITS.anyMaxWords}). Shorten it.`);
  } else if (firstTouch && words > LINT_LIMITS.firstTouchMaxWords) {
    add("too_long", "warn", `First-touch body is ${words} words (aim for under ${LINT_LIMITS.firstTouchMaxWords}).`);
  }
  if (subject.length > LINT_LIMITS.subjectMaxChars) {
    add("subject_too_long", "warn", `Subject is ${subject.length} characters (limit ${LINT_LIMITS.subjectMaxChars}).`);
  }

  // subject_spammy --------------------------------------------------------
  const spam: string[] = [];
  // One shouted word of 4+ letters ("URGENT"), or 3-letter caps words back to back ("BUY NOW"). 3-letter acronyms
  // separated by ordinary words ("CRM", "tải XML từ PDF") are fine.
  const capsWords = [...subject.matchAll(/(?<![\p{L}\p{N}])\p{Lu}{3,}(?![\p{L}\p{N}])/gu)].map((m) => m[0]);
  const shouting =
    capsWords.some((w) => w.length >= 4) ||
    /(?<![\p{L}\p{N}])\p{Lu}{3,}[\s\p{P}]+\p{Lu}{3,}(?![\p{L}\p{N}])/u.test(subject);
  if (shouting) spam.push(`ALL CAPS (${quoteList(capsWords, 3)})`);
  for (const [re, label] of SPAM_SUBJECT_PATTERNS) {
    if (re.test(subject) && !(label === '"FREE"' && shouting && capsWords.includes("FREE"))) spam.push(label);
  }
  if (spam.length > 0) add("subject_spammy", "warn", `Subject looks spammy: ${spam.join(", ")}.`);

  // no_cta / multiple_links -------------------------------------------------
  const links = [...new Set((body.match(/https?:\/\/[^\s<>)\]]+|www\.[^\s<>)\]]+/gi) ?? []).map((l) => l.replace(/[.,;:!?]+$/, "")))];
  const meetingLink = ctx.profile?.meetingLink?.trim();
  const hasMeetingLink =
    (meetingLink ? body.toLowerCase().includes(meetingLink.toLowerCase().replace(/\/+$/, "")) : false) ||
    links.some((l) => MEETING_LINK.test(l));
  if (ctx.role !== "chief-of-staff" && !/[?？]/.test(body) && !hasMeetingLink && !CTA_PHRASES.test(body)) {
    add("no_cta", "warn", "No call to action: no question, meeting link or clear ask. Add one specific, low-friction next step.");
  }
  if (links.length > LINT_LIMITS.maxLinks) {
    add("multiple_links", "warn", `${links.length} links in one email (limit ${LINT_LIMITS.maxLinks}); extra links hurt deliverability.`);
  }

  // missing_greeting_name ---------------------------------------------------
  if (ctx.contact?.name) {
    const tokens = nameTokens(ctx.contact.name);
    const hay = fold(body);
    if (tokens.length > 0 && !tokens.some((t) => new RegExp(`(?<![a-z0-9])${fold(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`).test(hay))) {
      add("missing_greeting_name", "info", `The contact's name (${ctx.contact.name}) is known but not used in the email.`);
    }
  }

  // language_mismatch -------------------------------------------------------
  const lang = languageOf(ctx.contact);
  if (lang) {
    const letters = body.match(/\p{L}/gu)?.length ?? 0;
    if (letters >= 30) {
      const viChars = body.match(VI_CHARS)?.length ?? 0;
      const ratio = viChars / letters;
      if (lang === "vi" && ratio < 0.03) {
        const toks = body.toLowerCase().match(/[a-z']+/g) ?? [];
        const enHits = toks.filter((t) => EN_STOPWORDS.has(t)).length;
        if (enHits >= 3) add("language_mismatch", "warn", "Contact prefers Vietnamese but the email is written in English.");
      } else if (lang === "en" && ratio > 0.08) {
        add("language_mismatch", "warn", "Contact prefers English but the email appears to be written in Vietnamese.");
      }
    }
  }

  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export function hasLintErrors(findings: readonly LintFinding[]): boolean {
  return findings.some((f) => f.severity === "error");
}

/** Human/agent-readable block listing findings, used in the draft-blocked tool error. */
export function formatFindings(findings: readonly LintFinding[]): string {
  return findings.map((f) => `- [${f.severity}] ${f.code}: ${f.message}`).join("\n");
}
