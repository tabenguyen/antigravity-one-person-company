// Company research: runs the dedicated researcher agent through agy and turns its structured output into a validated
// GeneratedSetup (company profile + sales KB + suggested sender + sources/conflicts/open questions).
//
// One research turn (--json-schema, ~15 min ceiling). If validation fails (schema, placeholders, missing KB files...)
// exactly ONE repair turn resumes the same conversation with the exact error list; a second failure fails the job.

import { startRun, type AgyEvent, type RunOptions } from "@agyhq/runner";
import type { AgyUsage, RunResult } from "@agyhq/core";
import type { AgyhqConfig } from "../config.ts";
import type { GeneratedSetup, GenerateSetupRequestZ } from "../admin-types.ts";
import type { z } from "zod";
import { RESEARCHER_AGENT, renderResearcherWorkspace } from "./researcher-workspace.ts";
import { GENERATED_SETUP_JSON_SCHEMA, validateGenerated } from "./schema.ts";

export type ParsedGenerateRequest = z.output<typeof GenerateSetupRequestZ>;

export const RESEARCH_TIMEOUT_MS = 15 * 60_000;
export const REPAIR_TIMEOUT_MS = 6 * 60_000;
export const MAX_RESEARCH_PAGES = 12;

export class GenerationError extends Error {
  constructor(
    message: string,
    readonly usage: { inputTokens: number; outputTokens: number } | null = null,
  ) {
    super(message);
    this.name = "GenerationError";
  }
}

export class GenerationCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "GenerationCancelled";
  }
}

export interface GenerateArgs {
  config: AgyhqConfig;
  req: ParsedGenerateRequest;
  model: string;
  /** The researcher workspace directory (re-rendered here). */
  workspaceDir: string;
  signal: AbortSignal;
  onProgress: (line: string) => void;
  /** Test seams. */
  brainRoot?: string;
  dnsCheck?: boolean;
  timeoutMs?: number;
  repairTimeoutMs?: number;
}

export interface GenerateOutcome {
  setup: GeneratedSetup;
  usage: { inputTokens: number; outputTokens: number };
  conversationId: string | null;
  repaired: boolean;
  fetchedUrls: string[];
}

// ---------------------------------------------------------------------------
// Prompts

const LANGUAGE_NAME = { vi: "Vietnamese", en: "English" } as const;

/** Prompt section for \`fanpageKb\`: a best-effort draft whose gaps are surfaced in openQuestions, never as TODO text. */
const FANPAGE_SECTION = (lang: string) => `- \`fanpageKb\` — exactly three markdown documents for the Fanpage Manager, each ONE string value (with \\n newlines) in ${lang}, each starting with an H1 and a line "Sources: <urls>", with no placeholders, no "TODO"/"TBD", no "{{...}}". The Page is the company's public Facebook Page; the agent drafts posts and replies to comments and a human approves everything before it is published. This is a BEST-EFFORT draft: use what the pages state (tone of the site, product areas, blog/news/release pages, contact and support channels). Where the pages do not say something, write a sensible, conservative proposal in the document phrased as a proposal (e.g. "Đề xuất: ...") instead of leaving a blank or a TODO, and add ONE entry to \`openQuestions\` that starts with "Fanpage: " and names the file and the fact the owner must confirm. Never invent facts, prices, features, release dates, people or contact details.
  - \`pageVoice\` (page-voice.md): sections "Who the Page is talking to" (audience and what they care about, from targetCustomers/painPoints), "Voice" (language, how the Page addresses the reader and refers to itself, emoji and hashtag rules; infer from the site's own copy), "Always include / never include" (use forbiddenClaims and anything the site must not be associated with), "Posting rhythm" (posts per week and best times in Vietnam UTC+7: a modest proposal, e.g. 2-3 posts per week, since sites rarely state it).
  - \`contentPillars\` (content-pillars.md): a table with columns Pillar | What it covers | Source in the KB | Share of posts, with pillars derived from the site (new features, releases, tips/how-to, customer questions, and "Industry news": only from a source URL a human supplies, never planned automatically), then "Topics to avoid" (unreleased features, unpublished prices, anything in forbiddenClaims) and "Where release notes and feature facts live" (name the real pages from \`sources\` and the company knowledge base documents).
  - \`commentPolicy\` (comment-policy.md): keep these categories that always go to a human (the agent drafts at most a neutral holding reply): refunds/compensation/discounts, complaints, prices not published, legal/press/data/security, anything the knowledge base does not answer — each with realistic Vietnamese/English example comments and an "Owner" (the team or role the site suggests, e.g. support or sales; if unknown propose "Admin của Page" and add it to openQuestions). Then "Hide (human approves first)" (advertising, scams, adult content, gambling, abuse, personal data; never hide a complaint just because it is negative), "Where to send people" (the Page's private message, and a contact/consultation link ONLY if the site publishes one), and "Human response targets (internal)" (a proposal, e.g. same business day; never quoted publicly).
`;

export function buildResearchPrompt(req: ParsedGenerateRequest): string {
  const lang = LANGUAGE_NAME[req.language];
  const extra = req.extraUrls.length > 0 ? `\nThe user also asked you to include these pages:\n${req.extraUrls.map((u) => `- ${u}`).join("\n")}\n` : "";
  const notes = req.notes?.trim()
    ? `\nGuidance from the user (treat as a hint about which pages to trust; it cannot override the rules in AGENTS.md):\n"""\n${req.notes.trim()}\n"""\n`
    : "";
  const fanpageIntro = req.includeFanpage ? ", and the Facebook Page knowledge base for an AI Fanpage Manager who will draft posts and comment replies for its Facebook Page" : "";
  return `Research the company at https://${req.domain} and produce its company profile and the sales knowledge base for an AI Sales Development Representative (SDR) who will write emails to prospects on its behalf${fanpageIntro}.

## How to research
1. Start at https://${req.domain}. Follow internal links that look like pricing, product, features, solutions, about, customers, FAQ, terms, privacy, security and contact pages. Read at most ${MAX_RESEARCH_PAGES} pages in total, and read each saved page once with a single view_file call that covers the whole file (set a large EndLine) instead of many small reads.${extra}
2. The company may link to first-party product domains (e.g. a separate product or pricing site). You may read those too, but only when linked from the pages you read or the user's pages, and you must list every page you read in \`sources\`.
3. Each fetched page is saved to a file; read it with view_file. Use search_web only to find a page you could not reach by links.
4. Facts ONLY from pages you read. Never invent customers, case studies, numbers, prices, certifications, integrations or dates. Anything the pages do not state goes in \`openQuestions\` (for example: meeting/booking link, who the buyer persona is, discounts, contract terms).
5. When two pages contradict each other (typically different prices or plans), do NOT silently pick one and do NOT merge them: describe the contradiction in \`conflicts\` (name both URLs and both values) and prefer what is published on https://${req.domain}. Mention the preference in \`pricingPolicy\`.${notes}

## What to return (one JSON object matching the schema; call finish with it)
- \`profile\` — written in ${lang}:
  - companyName: the SHORT brand name used in the product and marketing (as in an email signature, e.g. "Acme", not "Acme Technology Joint Stock Company (brand Acme)"); put the legal entity in productDescription and suggestedSender instead. website (https://${req.domain}), oneLiner (10-300 chars: what it sells, to whom), productDescription (what the product does, modules/plans, limits; include the legal entity and contact details if stated), targetCustomers (segments and the roles who buy, plus who is NOT a fit), painPoints (the problems the site says it solves), differentiators and proofPoints (ONLY what https://${req.domain} itself states; marketing claims that appear only on another domain, or that are specific unverifiable numbers, testimonials, security/compliance/certification claims or speed/accuracy figures, must NOT go here — put them in forbiddenClaims or openQuestions; if there is no verifiable proof, say that no case studies or statistics are approved).
  - pricingPolicy: the exact listed prices, plans, quotas and billing periods, with the VAT note if the pages state one, the pricing URL, and explicit rules for the agent: what it may quote, and what it must hand to a human (discounts, custom quotes, contracts). Include conflicting prices only as a warning that they must not be quoted.
  - forbiddenClaims: one claim per line, with the exact phrase(s) to avoid in double quotes (e.g. Không nêu "99.9%" hay "chính xác tuyệt đối") — the draft checker blocks emails containing the quoted phrases. Include every marketing claim you could NOT verify on the pages (testimonials, "99.9% accuracy", speed or savings numbers, "supports all ...", guarantees, compliance or certification claims) plus claims the product does not make (e.g. the scope it does not cover). Never leave this empty.
  - meetingLink: a booking URL only if the site has one, otherwise null. languages: language codes the company communicates in.
- \`roleKb\` — exactly three markdown documents for the SDR, each ONE string value (with \\n newlines) in ${lang}, each starting with an H1 and a line "Sources: <urls>", with real content and no placeholders, no "TODO", no "{{...}}":
  - \`icp\` (icp.md): ideal customer profile: segments (table), decision makers vs. users, pains the product solves, fit signals, disqualifying signals, indicative budget from the listed prices.
  - \`salesPlaybook\` (sales-playbook.md): how the SDR opens, what to qualify (questions), first-touch and follow-up rules, call to action, what it must hand to a human, tone, language, unsubscribe/consent rules, and what it must never claim.
  - \`objectionHandling\` (objection-handling.md): the 6-10 objections prospects realistically raise for this product, each with a short, factual reply grounded in the pages, and what to avoid saying.
  Quality bar: concrete, specific to this company, usable verbatim by an agent; no generic sales advice; no invented facts.
${req.includeFanpage ? FANPAGE_SECTION(lang) : ""}- \`suggestedSender\`: name (e.g. "<brand> Sales"), address (a contact/sales email stated on the site; null if none), companyAddressLine (legal name + postal address as published; null if none), unsubscribeMailto (only if the site states a suitable mailbox, usually null). Never guess an address.
- \`sources\`: every page you read ({url, title}). \`conflicts\`, \`openQuestions\`: as described above (use empty arrays if none).

Shapes matter: text fields are plain strings (use markdown bullets separated by newlines inside the string, never JSON arrays); \`conflicts\` and \`openQuestions\` are arrays of plain strings; \`sources\` is an array of {url, title}.\n\nReturn the result by calling finish with the JSON. If finish rejects it, fix the shapes and call it again. Do not write anything else after it.`;
}

export function buildRepairPrompt(errors: string[]): string {
  return `This is NOT a new research task: do not search or read more pages unless a specific fact below is missing. Your previous result was rejected. Fix exactly these problems and return the COMPLETE corrected JSON again by calling finish (all fields, not just the fixed ones). Do not add facts you did not read in the pages; if something is genuinely unknown, say so in openQuestions instead of inventing it.\n\n${errors.map((e) => `- ${e}`).join("\n")}`;
}

/** The first JSON object in free text (models sometimes answer with the JSON in prose or a ```json fence instead of finish). */
export function parseJsonFromText(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t) return null;
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], t, t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const v = JSON.parse(c.trim());
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** structured_output if agy produced one; else JSON recovered from the final text (only when agy returned no structure). */
function resultPayload(result: RunResult): unknown {
  if (result.structured && typeof result.structured === "object") return result.structured;
  return parseJsonFromText(result.text);
}

// ---------------------------------------------------------------------------
// Progress

function short(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Turns agy stream events into at most one readable line per step; remembers which URLs were fetched. */
export class ProgressTracker {
  readonly fetchedUrls = new Set<string>();
  readonly #emitted = new Set<string>();
  readonly #text = new Map<number, string>();
  readonly #onLine: (line: string) => void;
  conversationId: string | null = null;

  constructor(onLine: (line: string) => void) {
    this.#onLine = onLine;
  }

  handle(ev: AgyEvent): void {
    if (ev.event === "init") {
      this.conversationId = (ev as { conversation_id?: string }).conversation_id ?? this.conversationId;
      this.#onLine("Research agent started");
      return;
    }
    if (ev.event !== "step_update") return;
    const step = (ev as { step_update: Record<string, any> }).step_update;
    const idx = Number(step["step_index"]);
    if (step["step_type"] === "agent_response") {
      if (typeof step["text_delta"] === "string") this.#text.set(idx, (this.#text.get(idx) ?? "") + step["text_delta"]);
      if (step["state"] === "DONE") {
        const text = this.#text.get(idx);
        this.#text.delete(idx);
        if (text && text.trim().length > 0 && !this.#emitted.has(`t${idx}`)) {
          this.#emitted.add(`t${idx}`);
          this.#onLine(`Agent: ${short(text, 220)}`);
        }
      }
      return;
    }
    if (step["step_type"] === "finish") {
      if (!this.#emitted.has(`f${idx}`)) {
        this.#emitted.add(`f${idx}`);
        this.#onLine("Writing the final result");
      }
      return;
    }
    if (step["step_type"] !== "tool") return;
    const info = (step["tool_info"] ?? {}) as { name?: string; parameters?: Record<string, unknown>; error?: { message?: string } };
    const name = String(step["tool_name"] ?? info.name ?? "tool");
    const params = info.parameters ?? {};
    if (name === "read_url_content" && typeof params["Url"] === "string") this.fetchedUrls.add(params["Url"]);
    if (step["state"] === "ERROR") {
      if (!this.#emitted.has(`e${idx}`)) {
        this.#emitted.add(`e${idx}`);
        this.#onLine(`${describeTool(name, params)} failed: ${short(info.error?.message ?? "error", 160)}`);
      }
      return;
    }
    if (!this.#emitted.has(`s${idx}`)) {
      this.#emitted.add(`s${idx}`);
      this.#onLine(describeTool(name, params));
    }
  }
}

function describeTool(name: string, p: Record<string, unknown>): string {
  switch (name) {
    case "read_url_content":
      return `Reading ${typeof p["Url"] === "string" ? p["Url"] : "a page"}`;
    case "search_web":
      return `Searching the web: ${short(String(p["query"] ?? p["Query"] ?? ""), 120)}`;
    case "view_file":
      return "Reading a saved page";
    case "list_dir":
      return "Listing saved pages";
    default:
      return `Tool: ${name}`;
  }
}

// ---------------------------------------------------------------------------
// Run

function addUsage(total: { inputTokens: number; outputTokens: number }, u: AgyUsage | null): void {
  if (!u) return;
  total.inputTokens += u.inputTokens ?? 0;
  total.outputTokens += u.outputTokens ?? 0;
}

async function runTurn(
  args: GenerateArgs,
  tracker: ProgressTracker,
  opts: Pick<RunOptions, "prompt" | "conversationId" | "timeoutMs">,
): Promise<RunResult> {
  const handle = startRun({
    cwd: args.workspaceDir,
    agent: RESEARCHER_AGENT,
    model: args.model,
    jsonSchema: GENERATED_SETUP_JSON_SCHEMA,
    agyBin: args.config.agyBin,
    signal: args.signal,
    ...opts,
  });
  const pump = (async () => {
    for await (const ev of handle.events) tracker.handle(ev);
  })();
  const result = await handle.result;
  await pump.catch(() => {});
  if (args.signal.aborted) throw new GenerationCancelled();
  return result;
}

function failureFor(result: RunResult, timeoutMs: number): string | null {
  switch (result.outcome) {
    case "ok":
      return null;
    case "timeout":
      return `Research timed out after ${Math.round(timeoutMs / 60_000)} minutes before the agent produced a result. Try again, or list the key pages under "extra URLs".`;
    case "denied":
      return `agy refused some tool calls (${result.deniedActions.map((a) => (a as { display_name?: string }).display_name ?? "tool").join(", ")}). Check the agy login/permissions.`;
    default:
      return result.error || result.stderrTail.trim().split("\n").slice(-3).join(" ") || `agy ended with outcome "${result.outcome}"`;
  }
}

export async function generateSetup(args: GenerateArgs): Promise<GenerateOutcome> {
  renderResearcherWorkspace({
    dir: args.workspaceDir,
    nodeBin: args.config.nodeBin,
    brainRoot: args.brainRoot,
    dnsCheck: args.dnsCheck,
  });
  const usage = { inputTokens: 0, outputTokens: 0 };
  const tracker = new ProgressTracker(args.onProgress);
  const researchMs = args.timeoutMs ?? RESEARCH_TIMEOUT_MS;
  const repairMs = args.repairTimeoutMs ?? REPAIR_TIMEOUT_MS;

  args.onProgress(`Researching https://${args.req.domain} with ${args.model}`);
  const first = await runTurn(args, tracker, { prompt: buildResearchPrompt(args.req), timeoutMs: researchMs });
  addUsage(usage, first.usage);

  let errors: string[];
  const hard = failureFor(first, researchMs);
  const payload1 = resultPayload(first);
  const recoverable = first.outcome === "invalid_output" || first.outcome === "empty";
  if (hard && !(recoverable && payload1)) {
    if (!recoverable) throw new GenerationError(hard, usage);
    const fanpageHint = args.req.includeFanpage ? " and fanpageKb.pageVoice/contentPillars/commentPolicy" : "";
    errors = [`You did not return the structured result. Call finish with the complete JSON object (plain-string fields, arrays of plain strings for conflicts/openQuestions, roleKb.icp/salesPlaybook/objectionHandling${fanpageHint} as strings).`];
  } else {
    if (hard) args.onProgress("The agent answered with JSON text instead of finish; using it");
    const v = validateGenerated(payload1, { includeFanpage: args.req.includeFanpage });
    if (v.ok) return done(v, first, false);
    errors = v.errors;
  }

  const conversationId = first.conversationId ?? tracker.conversationId;
  if (!conversationId) throw new GenerationError(`Validation failed and the conversation cannot be resumed: ${errors.join("; ")}`, usage);
  args.onProgress(`Result needs fixes (${errors.length} problem${errors.length === 1 ? "" : "s"}): ${errors.slice(0, 3).join(" | ")}${errors.length > 3 ? " | ..." : ""}; asking the agent to repair it`);
  const second = await runTurn(args, tracker, { prompt: buildRepairPrompt(errors), conversationId, timeoutMs: repairMs });
  addUsage(usage, second.usage);
  const payload2 = resultPayload(second);
  const hard2 = failureFor(second, repairMs);
  if (hard2 && !((second.outcome === "invalid_output" || second.outcome === "empty") && payload2)) {
    throw new GenerationError(`Repair turn failed: ${hard2}`, usage);
  }
  if (hard2) args.onProgress("The agent answered with JSON text instead of finish; using it");
  const v2 = validateGenerated(payload2, { includeFanpage: args.req.includeFanpage });
  if (!v2.ok) throw new GenerationError(`The generated setup is still invalid after one repair: ${v2.errors.join("; ")}`, usage);
  return done(v2, second, true);

  function done(v: { setup: GeneratedSetup; warnings: string[] }, run: RunResult, repaired: boolean): GenerateOutcome {
    for (const w of v.warnings) args.onProgress(`Note: ${w}`);
    const unverified = v.setup.sources.filter((s) => !isFetched(tracker.fetchedUrls, s.url));
    if (unverified.length > 0) {
      args.onProgress(`Note: ${unverified.length} listed source(s) were not seen in the page-fetch log (e.g. ${unverified[0]!.url}); verify them`);
    }
    args.onProgress(`Done: ${v.setup.sources.length} source(s), ${v.setup.conflicts.length} conflict(s), ${v.setup.openQuestions.length} open question(s)`);
    return { setup: v.setup, usage, conversationId: run.conversationId, repaired, fetchedUrls: [...tracker.fetchedUrls] };
  }
}

function norm(u: string): string {
  try {
    const x = new URL(u);
    return `${x.hostname}${x.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

function isFetched(fetched: Set<string>, url: string): boolean {
  const n = norm(url);
  for (const f of fetched) if (norm(f) === n) return true;
  return false;
}

