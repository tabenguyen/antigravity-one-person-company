// "Echoed subject" helper for the lint engine. A reply's subject is "Re: <the customer's subject>", and the
// customer's words are not something the agent wrote: a customer who titles an email "Uptime guarantee for our
// board paper" or "[Action required] Quote 2 million" must not make the agent's polite "Re: ..." reply fail the
// promise / price / placeholder rules. Pure: the db-backed lint context supplies the thread's inbound subjects.

/** Reply / forward prefixes seen in en + vi mail clients: Re:, RE[2]:, Fwd:, Fw:, TL:, Trả lời:, Chuyển tiếp:, AW:, SV:, RV:. */
const REPLY_PREFIX = /^\s*(?:(?:re|fwd?|tl|aw|sv|rv)(?:\s*\[\d+\])?|trả lời|tra loi|chuyển tiếp|chuyen tiep)\s*[:：]\s*/iu;

/** Remove any chain of reply prefixes ("Re: RE: Fwd: x" -> "x"), NFC-normalised and trimmed. */
export function stripReplyPrefixes(subject: string): string {
  let out = subject.normalize("NFC");
  for (let i = 0; i < 20; i++) {
    const next = out.replace(REPLY_PREFIX, "");
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

export interface SubjectSplit {
  /** True when the subject is (reply prefixes +) a subject from the thread, optionally followed by agent-added text. */
  echoed: boolean;
  /** The part of the subject that repeats the thread's subject ("" when not echoed). */
  echo: string;
  /** Text the agent put in the subject beyond the echo (the whole subject when nothing is echoed). */
  added: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Split a draft subject into the echoed customer subject and what the agent added. The echo must come right after
 * the reply prefixes (if any) and end at a word boundary; matching ignores case, whitespace runs and prefix chains
 * on either side. Text before the echo, or a subject that merely contains a few of the customer's words, is not an
 * echo and is treated as fully agent-written.
 */
export function splitEchoedSubject(subject: string, threadSubjects: readonly string[] | undefined): SubjectSplit {
  const plain = (subject ?? "").trim();
  const none: SubjectSplit = { echoed: false, echo: "", added: plain };
  if (!plain || !threadSubjects || threadSubjects.length === 0) return none;
  const stripped = stripReplyPrefixes(plain);
  if (!stripped) return none;
  const candidates = threadSubjects
    .map(stripReplyPrefixes)
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const known of candidates) {
    const m = new RegExp(`^${escapeRe(known).replace(/\s+/g, "\\s+")}`, "iu").exec(stripped);
    if (!m) continue;
    const rest = stripped.slice(m[0].length);
    if (rest !== "" && !/^[^\p{L}\p{N}]/u.test(rest) && /[\p{L}\p{N}]$/u.test(m[0])) continue; // would end mid-word
    return { echoed: true, echo: m[0], added: rest.replace(/^[\s\-–—:|,;.·•]+/u, "").trim() };
  }
  return none;
}

/** The subject text the agent itself wrote: "" for a pure echo, the added text after an echo, else the whole subject. */
export function agentWrittenSubject(subject: string | null | undefined, threadSubjects: readonly string[] | undefined): string {
  return splitEchoedSubject(subject ?? "", threadSubjects).added;
}
