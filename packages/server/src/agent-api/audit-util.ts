// Shared helpers for keeping audit `data` payloads small.

const DEFAULT_TRUNCATE_CHARS = 8_000;

/** JSON-stringify a value, truncating the result to at most `max` characters. */
export function truncatedJson(value: unknown, max = DEFAULT_TRUNCATE_CHARS): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "null";
  } catch {
    text = String(value);
  }
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...<truncated ${text.length - max} chars>`;
}

/** Truncate a plain string to at most `max` characters, with a short marker when cut. */
export function truncatedString(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...<truncated ${value.length - max} chars>`;
}
