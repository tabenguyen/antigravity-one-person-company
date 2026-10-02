// Best-effort stripping of quoted history / signatures from a plain-text email
// body, so the agent only sees the sender's new reply.
//
// Rule: scan the body top to bottom, line by line, looking for the earliest
// line that starts a "quoted" region. Everything from that line onward is
// dropped. Recognized region starts:
//   - a line beginning with ">" (standard quote marker)
//   - "On <...> wrote:" (English), possibly split across up to 3 lines the
//     way Gmail wraps it ("On <date/sender>" / "wrote:")
//   - "Vào <...> đã viết:" (Vietnamese equivalent), same multi-line handling
//   - an Outlook "-----Original Message-----" separator
//   - an Outlook plain-text header block: a "From:" line followed within a
//     few lines by a "Sent:"/"Date:" line (the classic From/Sent/To/Subject
//     quote header)
//   - a long row of underscores ("________...") — the separator Outlook Web
//     Access inserts above quoted history
//   - the RFC 3676 signature delimiter "-- " (also accepts a bare "--")
//
// This is intentionally conservative: if stripping would leave nothing (e.g.
// the whole message looks quoted, which usually means a false positive), we
// fall back to the original text rather than ever returning an empty string
// for a non-empty input.
export function extractReplyText(text: string): string {
  const original = text ?? "";
  if (!original.trim()) return "";

  const lines = original.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  let cutIndex = lines.length;
  const cutAt = (idx: number): void => {
    if (idx < cutIndex) cutIndex = idx;
  };

  for (let i = 0; i < cutIndex; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith(">")) {
      cutAt(i);
      continue;
    }

    if (line.replace(/[ \t]+$/, "") === "--") {
      cutAt(i);
      continue;
    }

    if (/^_{8,}$/.test(trimmed)) {
      cutAt(i);
      continue;
    }

    if (/^-{2,}\s*original message\s*-{2,}$/i.test(trimmed)) {
      cutAt(i);
      continue;
    }

    if (/^from:\s*\S/i.test(trimmed)) {
      const lookahead = lines.slice(i + 1, i + 5).map((l) => (l ?? "").trim());
      if (lookahead.some((l) => /^(sent|date):\s*\S/i.test(l))) {
        cutAt(i);
        continue;
      }
    }

    let matchedQuoteIntro = false;
    for (let span = 1; span <= 3 && i + span - 1 < lines.length; span++) {
      const windowText = lines
        .slice(i, i + span)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (isOnWroteLine(windowText) || isVaoDaVietLine(windowText)) {
        cutAt(i);
        matchedQuoteIntro = true;
        break;
      }
    }
    if (matchedQuoteIntro) continue;
  }

  const kept = lines
    .slice(0, cutIndex)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (kept) return kept;

  // Conservative fallback: never return empty if the original had content.
  return original.trim();
}

function isOnWroteLine(windowText: string): boolean {
  const lower = windowText.toLowerCase();
  if (!lower.startsWith("on ") || !lower.endsWith("wrote:")) return false;
  return lower.length > "on ".length + "wrote:".length;
}

function isVaoDaVietLine(windowText: string): boolean {
  const lower = windowText.toLowerCase();
  if (!lower.startsWith("vào ") || !lower.endsWith("đã viết:")) return false;
  return lower.length > "vào ".length + "đã viết:".length;
}
