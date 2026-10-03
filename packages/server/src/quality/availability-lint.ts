// Invented availability: the agents have no calendar tool, so "I'm free Tuesday" or "Does Thursday at 3pm work?" is a
// made-up commitment the human reviewer then has to undo. Pure, bilingual (vi/en), returns the matched phrases.
// Used as a warning (reviewer-facing) for the SDR role; see lint.ts.

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const WEEKDAY = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
// A concrete moment: a weekday, tomorrow/tonight, a part of today, or a clock time.
const SLOT = `(?:${WEEKDAY}|tomorrow|tonight|this (?:morning|afternoon|evening)|\\d{1,2}:\\d{2}|\\d{1,2}\\s?(?:am|pm))`;
const FIRST_PERSON = "(?:i|we)(?:'m| am|'re| are|'ll be| will be)";

const EN_PATTERNS: RegExp[] = [
  // "I'm free Tuesday", "we are available tomorrow afternoon", "I'll be around Friday"
  new RegExp(`(?<![a-z])${FIRST_PERSON}\\s+(?:also\\s+|generally\\s+|usually\\s+)?(?:free|available|around|online|on call)(?![a-z])[^.?!\\n]{0,40}?(?<![a-z0-9])${SLOT}(?![a-z0-9])`),
  // "Does Tuesday at 3pm work?", "How about tomorrow morning?", "Are you free Thursday?"
  new RegExp(`(?<![a-z])(?:does|do|would|is|how about|what about)\\b[^.?!\\n]{0,30}?(?<![a-z0-9])${SLOT}(?![a-z0-9])[^.?!\\n]{0,30}?(?<![a-z])(?:work|works|suit|suits|fine|good|ok|okay)(?![a-z])`),
  new RegExp(`(?<![a-z])(?:how about|what about)\\s+(?:${WEEKDAY}|tomorrow)(?![a-z])`),
  new RegExp(`(?<![a-z])are you (?:free|available)\\s+(?:on\\s+)?${SLOT}(?![a-z0-9])`),
];

// Folded (diacritics stripped) Vietnamese: "thứ Ba mình rảnh", "em rảnh chiều mai", "mình rảnh lúc 3h".
const VI_SLOT = "(?:thu (?:hai|ba|tu|nam|sau|bay)|chu nhat|ngay mai|sang mai|chieu mai|toi mai|\\d{1,2}\\s?(?:h|gio|:\\d{2}))";
const VI_PATTERNS: RegExp[] = [
  new RegExp(`(?<![a-z])(?:em|minh|toi|ben em|ben minh)\\s+(?:co the\\s+)?(?:dang\\s+)?(?:ranh|sang)\\s+(?:vao\\s+|luc\\s+)?${VI_SLOT}(?![a-z0-9])`),
  new RegExp(`(?<![a-z0-9])${VI_SLOT}(?![a-z0-9])[^.?!\\n]{0,25}?(?<![a-z])(?:em|minh|toi)\\s+(?:deu\\s+|dang\\s+)?ranh(?![a-z])`),
];

/** Phrases in `text` where the writer offers a specific availability or meeting time (empty when none). */
export function findInventedAvailability(text: string): string[] {
  const hits: string[] = [];
  const en = text.normalize("NFC").toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ");
  const vi = fold(text);
  for (const [hay, patterns] of [[en, EN_PATTERNS], [vi, VI_PATTERNS]] as const) {
    for (const re of patterns) {
      const m = hay.match(re);
      if (m && !hits.includes(m[0].trim())) hits.push(m[0].trim());
    }
  }
  return hits;
}
