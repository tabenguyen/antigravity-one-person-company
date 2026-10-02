// Placeholder detection for knowledge-base text. Role templates ship with seed
// KB files full of "EXAMPLE — ..." / "TODO" markers; agents that read those
// files quote the placeholder "product claims" verbatim, so go-live readiness
// refuses to pass while any remain.
//
// Boundaries use Unicode-aware lookarounds (\p{L}) rather than \b, because \b
// is ASCII-only in JavaScript and would match inside Vietnamese words.

export interface PlaceholderHit {
  /** 1-based line number of the first offending line. */
  line: number;
  /** The offending line, trimmed and shortened for display. */
  text: string;
  /** Which marker matched, e.g. "TODO". */
  marker: string;
}

const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}_])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}_])";

const MARKERS: { marker: string; re: RegExp }[] = [
  { marker: "EXAMPLE —", re: new RegExp(`${NOT_WORD_BEFORE}EXAMPLE\\s*[—–-]`, "u") },
  { marker: "TODO", re: new RegExp(`${NOT_WORD_BEFORE}TODO${NOT_WORD_AFTER}`, "u") },
  { marker: "TBD", re: new RegExp(`${NOT_WORD_BEFORE}TBD${NOT_WORD_AFTER}`, "u") },
  { marker: "lorem ipsum", re: new RegExp(`${NOT_WORD_BEFORE}lorem${NOT_WORD_AFTER}`, "iu") },
  { marker: "{{placeholder}}", re: /\{\{[^{}\n]*\}\}/ },
  // Case-sensitive on purpose: "improve your company's sales" is ordinary prose.
  { marker: "Your Company", re: /Your Company/ },
  { marker: "yourcompany.com", re: /yourcompany\.com/i },
];

const MAX_SNIPPET = 120;

function snippet(line: string): string {
  const t = line.trim();
  return t.length > MAX_SNIPPET ? `${t.slice(0, MAX_SNIPPET - 1)}…` : t;
}

/** First placeholder in `text`, or null when the text is clean. */
export function findPlaceholder(text: string): PlaceholderHit | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const { marker, re } of MARKERS) {
      if (re.test(line)) return { line: i + 1, text: snippet(line), marker };
    }
  }
  return null;
}

/** Placeholder markers present in a single value (used to validate profile input). */
export function placeholderMarkers(text: string): string[] {
  return MARKERS.filter(({ re }) => re.test(text)).map(({ marker }) => marker);
}
