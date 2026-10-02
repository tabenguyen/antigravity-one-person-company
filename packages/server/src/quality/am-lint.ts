// Account-Manager-only lint rules (Vietnamese + English). An Account Manager
// answers customers from the knowledge base; it must never make a commitment
// that belongs to a human: refunds, discounts, credits, SLA/uptime figures,
// delivery dates for features or bug fixes, contract changes. Each rule is an
// error (the draft is blocked at draft time and the agent must rewrite it as a
// holding reply that promises nothing).
//
// Matching is per sentence on diacritic-folded text, and a sentence that
// declines ("we can't offer a refund", "chưa thể hoàn tiền") is not a promise.
// Like the rest of lint.ts it is deliberately conservative: phrases, not
// keywords, so "I've passed your refund request to the team" stays clean.

import type { LintFinding } from "@agyhq/core";

/** Lowercase, strip diacritics (incl. Vietnamese đ), unify apostrophes, collapse whitespace. */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/đ/gi, "d")
    .replace(/[’‘`]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** A sentence that refuses or hedges instead of promising. */
const NEGATED =
  /(?<![a-z])(?:cannot|can't|cant|can not|unable|not able|won't|wont|will not|do not|don't|dont|does not|doesn't|isn't|not eligible|not possible|unfortunately|without|never|khong|chua|rat tiec|tiec la)(?![a-z])/;

// "we will / we'll / we can / I'd be happy to ..." — a first-person commitment, optionally with up to two filler words.
const WE_COMMIT = String.raw`(?<![a-z])(?:we|i)(?:'ll|\s+will|\s+can|\s+shall|\s+are going to|\s+are happy to|\s+would be happy to|\s+will gladly|\s+gladly)\s+(?:\w+\s+){0,2}?`;
const OFFER_VERB = String.raw`(?<![a-z])(?:issue|process|give|grant|approve|provide|send|arrange|offer|apply|extend|add)`;
const DET = String.raw`(?:you\s+|your\s+)?(?:a\s+|an\s+|the\s+|your\s+|some\s+)?`;

interface Rule {
  code: string;
  /** What the draft promises, for the message. */
  what: string;
  /** What to do instead. */
  instead: string;
  test: (folded: string) => boolean;
}

const anyOf = (patterns: RegExp[]) => (f: string) => patterns.some((p) => p.test(f));

const REFUND = anyOf([
  new RegExp(`${WE_COMMIT}(?:refund|reimburse)`),
  new RegExp(`${OFFER_VERB}\\s+${DET}(?:full\\s+|partial\\s+|complete\\s+)?(?:refund|reimbursement)`),
  /(?<![a-z])refund\s+(?:is|has been|will be|was)\s+(?:approved|processed|issued|granted|confirmed|on (?:its|the) way)/,
  /(?<![a-z])you(?:'ll|\s+will)\s+(?:get|receive|have|be refunded)\b.{0,30}?(?:refund|money back|refunded)?/,
  /(?<![a-z])se\s+(?:duoc\s+)?hoan\s+(?:lai\s+)?(?:tien|phi|toan bo|\d)/,
  /(?<![a-z])(?:dong y|chap thuan|duyet|xac nhan|da)\s+hoan\s+(?:lai\s+)?(?:tien|phi)/,
  /(?<![a-z])(?:chung toi|em|minh|ben em|cong ty)\s+(?:se\s+)?hoan\s+(?:lai\s+)?(?:tien|phi)/,
  /(?<![a-z])(?:quy khach|anh|chi|ban)\s+se\s+(?:duoc\s+)?nhan\s+lai\s+(?:tien|phi)/,
]);

// "you'll get ..." only counts when it is about money coming back; keep that pattern from firing on everything.
const REFUND_YOULL = /(?<![a-z])you(?:'ll|\s+will)\s+(?:get|receive|have)\s+(?:a\s+|your\s+)?(?:full\s+)?(?:refund|money back|your money back)|you(?:'ll|\s+will)\s+be\s+refunded/;

const DISCOUNT = anyOf([
  new RegExp(`${WE_COMMIT}(?:discount|waive)`),
  new RegExp(
    `${OFFER_VERB}\\s+${DET}(?:special\\s+|exclusive\\s+|loyalty\\s+|\\d+\\s?%\\s+)?(?:discount|promo(?:tion(?:al)?)?(?:\\s+code)?|coupon|voucher|price (?:cut|reduction|break))`,
  ),
  /\d+(?:[.,]\d+)?\s?%\s*(?:off|discount)(?![a-z])/,
  /(?<![a-z])se\s+(?:ap dung\s+|tang\s+|cap\s+|co\s+)?(?:giam(?:\s+gia)?|chiet khau|uu dai|khuyen mai|ma giam gia|voucher)/,
  /(?<![a-z])(?:giam|chiet khau)\s+(?:gia\s+)?(?:den|toi|len den|len toi)?\s*\d+(?:[.,]\d+)?\s?%/,
  /\d+(?:[.,]\d+)?\s?%\s*(?:giam gia|chiet khau|uu dai)/,
  /(?<![a-z])(?:tang|gui|cap)\s+(?:ban\s+|anh\s+|chi\s+|quy khach\s+)?(?:ma|voucher|coupon)\s+(?:giam|uu dai|khuyen mai)/,
]);

const CREDIT = anyOf([
  new RegExp(`${WE_COMMIT}(?:credit|compensate)`),
  new RegExp(`${OFFER_VERB}\\s+${DET}(?:account\\s+|service\\s+|store\\s+|free\\s+)?credits?(?!\\s+card)(?![a-z])`),
  /(?<![a-z])(?:free|complimentary|bonus)\s+(?:\d+\s+|one\s+|an?\s+)?(?:extra\s+)?(?:month|week|day|year)s?(?![a-z])/,
  /(?<![a-z])(?:\d+|one|two|three)\s+(?:extra\s+)?(?:month|week)s?\s+(?:free|for free|on us)(?![a-z])/,
  /(?<![a-z])(?:extend|extension)\s+(?:of\s+)?(?:your\s+)?(?:trial|subscription|plan)\s+(?:for|by)\s+(?:free|\d)/,
  /(?<![a-z])se\s+(?:cong|bu|boi hoan|den bu|tang)\s+(?:them\s+|lai\s+)?(?:\d+\s+)?(?:thang|ngay|tuan|tin dung|credit|diem)/,
  /(?<![a-z])(?:tang|cong|bu)\s+(?:them\s+)?\d+\s+(?:thang|ngay|tuan)/,
  /(?<![a-z])(?:mien phi|free)\s+(?:them\s+)?(?:\d+\s+)?(?:thang|ngay|tuan)(?![a-z])/,
  /(?<![a-z])\d+\s+(?:thang|ngay|tuan)\s+(?:su dung\s+)?mien phi/,
]);

const SLA_NOUN =
  /(?<![a-z])(?:sla|uptime|up-time|availability|service level|thoi gian hoat dong|do san sang|do on dinh|thoi gian phan hoi|thoi gian xu ly|response time|resolution time)(?![a-z])/;
const SLA_BACKING =
  /\d+(?:[.,]\d+)?\s?%|(?<![a-z])(?:guarantee[sd]?|commit(?:s|ted|ment)?|promise[sd]?|ensure[sd]?|cam ket|dam bao|bao dam)(?![a-z])|within\s+\d|trong\s+(?:vong\s+)?\d+\s*(?:gio|phut|ngay)/;
const SLA = (f: string) => (SLA_NOUN.test(f) && SLA_BACKING.test(f)) || /(?<![a-z\d])99(?:[.,]\d+)?\s?%/.test(f);

const DELIVERY_CONTEXT =
  /(?<![a-z])(?:bug|fix(?:ed|es)?|patch|hotfix|feature|release|ship(?:ped|ping)?|roll(?:ed)?\s?out|rollout|implement(?:ed|ation)?|defect|tinh nang|sua loi|khac phuc|phat hanh|trien khai|ra mat|ban va|loi (?:nay|do|he thong|phan mem))(?![a-z])/;
const DELIVERY_COMMIT =
  /'ll|(?<![a-z])(?:will|going to|promise|guarantee|commit|expect(?:ed)?|plan(?:ned)? to|aim|target|se|cam ket|dam bao|du kien|du dinh|ke hoach)(?![a-z])/;
const WEEKDAY = String.raw`monday|tuesday|wednesday|thursday|friday|saturday|sunday|thu (?:hai|ba|tu|nam|sau|bay)|chu nhat`;
const DELIVERY_TIME = new RegExp(
  [
    String.raw`(?<![a-z])(?:by|before|within|no later than|until|on|in)\s+(?:the\s+)?(?:next\s+|end of\s+|this\s+)?(?:\d+\s*(?:hours?|days?|weeks?|months?|business days?)|(?:${WEEKDAY}|tomorrow|tonight|week|month|quarter|year|q[1-4]|january|february|march|april|june|july|august|september|october|november|december)(?![a-z])|\d{1,2}[/.-]\d{1,2})`,
    String.raw`(?<![a-z])next\s+(?:week|month|quarter|release|sprint)(?![a-z])`,
    String.raw`(?<![a-z])q[1-4](?![a-z\d])`,
    String.raw`(?<![a-z])end of (?:the\s+)?(?:week|month|quarter|year)(?![a-z])`,
    String.raw`(?<![a-z])(?:eta|tomorrow)(?![a-z])`,
    String.raw`(?<![a-z])(?:trong vong|trong|truoc|vao|den)\s+(?:ngay\s+)?(?:\d+\s*(?:gio|phut|ngay|tuan|thang)|ngay mai|tuan (?:nay|sau)|thang (?:nay|sau)|quy [1-4]|cuoi (?:tuan|thang|quy|nam)|${WEEKDAY}|\d{1,2}[/.-]\d{1,2})`,
    String.raw`(?<![a-z])(?:ngay mai|tuan sau|thang sau|quy sau|cuoi (?:tuan|thang|quy|nam)|quy [1-4])(?![a-z])`,
  ].join("|"),
);
const DELIVERY = (f: string) => DELIVERY_CONTEXT.test(f) && DELIVERY_COMMIT.test(f) && DELIVERY_TIME.test(f);

const CONTRACT = anyOf([
  new RegExp(
    `${WE_COMMIT}(?:amend|modify|change|waive|extend|renew|terminate|cancel|lock|freeze|downgrade|upgrade|switch|adjust|reduce|lower|cut)\\s+(?:\\w+\\s+){0,3}?(?:contract|agreement|terms?|pricing|price|plan|subscription|renewal|commitment|fees?)(?![a-z])`,
  ),
  /(?<![a-z])(?:price|pricing|rate)\s+(?:lock|freeze)(?![a-z])/,
  /(?<![a-z])(?:lock|freeze|hold)\s+(?:in\s+)?(?:your\s+|the\s+)?(?:current\s+)?(?:price|pricing|rate)(?![a-z])/,
  /(?<![a-z])waive[d]?\s+(?:the\s+|any\s+|your\s+)?(?:early termination\s+|termination\s+|cancellation\s+|late\s+)?(?:fee|penalty|charge)s?(?![a-z])/,
  /(?<![a-z])se\s+(?:sua|dieu chinh|thay doi|gia han|huy|cham dut|giu nguyen|dong bang|ha|giam)\s+(?:\w+\s+){0,3}?(?:hop dong|dieu khoan|gia|goi|phi|cam ket|dang ky|thoi han)(?![a-z])/,
  /(?<![a-z])(?:mien|bo qua)\s+(?:phi\s+|khoan\s+)?(?:phat|phi huy|phi cham dut|phi gia han muon)/,
]);

const RULES: Rule[] = [
  {
    code: "am_refund_promise",
    what: "a refund",
    instead: "Say you have passed the request to the team and what happens next; do not say it will or can be refunded.",
    test: (f) => REFUND(f) || REFUND_YOULL.test(f),
  },
  {
    code: "am_discount_promise",
    what: "a discount or promotion",
    instead: "Do not offer or hint at discounts; say the team will come back on pricing questions.",
    test: DISCOUNT,
  },
  {
    code: "am_credit_promise",
    what: "credit, compensation or free time",
    instead: "Do not offer credits, free months or compensation; apologise for the problem and say the team will follow up.",
    test: CREDIT,
  },
  {
    code: "am_sla_promise",
    what: "an SLA, uptime or response/resolution-time commitment",
    instead: "Do not quote uptime or SLA figures or guarantee response times; point to the published terms only if the knowledge base states them, and leave commitments to a human.",
    test: SLA,
  },
  {
    code: "am_delivery_promise",
    what: "a delivery date for a feature or bug fix",
    instead: "Say the team has the report and will update them; do not give a date or timeframe for a fix or a feature.",
    test: DELIVERY,
  },
  {
    code: "am_contract_promise",
    what: "a change to their contract, plan, price or fees",
    instead: "Contract, plan, pricing and cancellation changes are a human's decision; say you have passed it on.",
    test: CONTRACT,
  },
];

function excerpt(sentence: string): string {
  const s = sentence.replace(/\s+/g, " ").trim();
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

/** Split into sentences / clauses; quoted lines (">") are the customer's own words and are skipped. */
function sentencesOf(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .split(/(?<=[.!?…。])\s+|\n+|;\s*|\s+(?:but|however|although|though|nhưng|tuy nhiên)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** One `error` finding per promise category found in `text` (subject + body of an Account Manager draft). */
export function lintAccountManagerPromises(text: string): LintFinding[] {
  const sentences = sentencesOf(text).map((raw) => ({ raw, folded: fold(raw) }));
  const findings: LintFinding[] = [];
  for (const rule of RULES) {
    const hit = sentences.find((s) => !NEGATED.test(s.folded) && rule.test(s.folded));
    if (hit) {
      findings.push({
        code: rule.code,
        severity: "error",
        message: `Promises ${rule.what}: "${excerpt(hit.raw)}". An account manager cannot commit to this. ${rule.instead}`,
      });
    }
  }
  return findings;
}
