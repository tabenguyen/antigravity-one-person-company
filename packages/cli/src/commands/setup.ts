// `hq setup company|email-test` and `hq readiness` — guided go-live setup.
// See packages/server/src/admin-types.ts "Phase 3 additions" for the routes.

import fs from "node:fs";
import readline from "node:readline";
import { parseArgs } from "node:util";
import type { CompanyProfile, ReadinessCheck, ReadinessReport } from "@agyhq/core";
import { HqApiError, HqClient } from "../client.ts";
import { printJson } from "../format.ts";
import type { CliGlobals } from "./types.ts";

export const SETUP_HELP = [
  "usage: hq setup <subcommand> [args]",
  "",
  "subcommands:",
  "  company [--file profile.json]   save the company profile (renders kb/company/*.md and re-syncs the KB)",
  "  email-test                      test the email connection now",
].join("\n");

export const SETUP_COMPANY_HELP = [
  "usage: hq setup company [--file <profile.json>]",
  "",
  "Saves the company profile agents rely on (what you sell, to whom, price policy, forbidden claims).",
  "Without --file, you are prompted for each field; multi-line fields end with an empty line.",
  "Press Enter on a prompt to keep the current value (when a profile already exists).",
  "",
  "profile.json fields: companyName, website?, oneLiner, productDescription, targetCustomers,",
  "  painPoints, differentiators?, pricingPolicy, proofPoints?, forbiddenClaims?, meetingLink?, languages?",
].join("\n");

export const SETUP_EMAIL_TEST_HELP = "usage: hq setup email-test\n\nVerifies the configured email provider (IMAP/SMTP login) and prints the result. Exit code 1 on failure.";

export const READINESS_HELP = [
  "usage: hq readiness",
  "",
  "Shows the go-live checklist. Marks: ✓ pass, ! warning (does not block), ✗ failing (blocks enabling outbound).",
  "Exit code 1 when any check is failing.",
].join("\n");

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)

export interface SetupCompanyArgs {
  file: string | null;
  help: boolean;
}

/** Parses `hq setup company` flags. Throws Error with a user-facing message on bad input. */
export function parseSetupCompanyArgs(argv: string[]): SetupCompanyArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { file: { type: "string", short: "f" }, help: { type: "boolean", short: "h" } },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    throw new Error(`${(err as Error).message}\n\n${SETUP_COMPANY_HELP}`);
  }
  const file = parsed.values.file ?? null;
  if (file !== null && file.trim() === "") throw new Error("--file needs a path");
  return { file, help: parsed.values.help === true };
}

const MARKS = { pass: "✓", warn: "!", fail: "✗" } as const;

/** Human-readable checklist lines; details and fix hints only for non-passing checks. */
export function formatReadiness(report: ReadinessReport): string[] {
  const lines: string[] = [];
  for (const c of report.checks) {
    lines.push(`${MARKS[c.status]} ${c.title}  [${c.id}]`);
    if (c.status !== "pass") {
      lines.push(`    ${c.detail}`);
      if (c.fixPath) lines.push(`    fix: ${c.fixPath}`);
    }
  }
  const failing = report.checks.filter((c) => c.status === "fail").length;
  const warns = report.checks.filter((c) => c.status === "warn").length;
  lines.push("");
  lines.push(
    report.ready
      ? `Ready to enable outbound${warns > 0 ? ` (${warns} warning${warns === 1 ? "" : "s"})` : ""}.`
      : `NOT ready: ${failing} failing check${failing === 1 ? "" : "s"}${warns > 0 ? `, ${warns} warning${warns === 1 ? "" : "s"}` : ""}.`,
  );
  return lines;
}

export function readProfileFile(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${file}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Interactive prompting

/** Reads one line per call; resolves null at end of input. Works for TTYs and pipes alike. */
export interface LineReader {
  ask(prompt: string): Promise<string | null>;
  close(): void;
}

export function createLineReader(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): LineReader {
  const rl = readline.createInterface({ input, terminal: false });
  const queue: string[] = [];
  const waiters: ((line: string | null) => void)[] = [];
  let ended = false;
  rl.on("line", (line) => {
    const w = waiters.shift();
    if (w) w(line);
    else queue.push(line);
  });
  rl.on("close", () => {
    ended = true;
    while (waiters.length) waiters.shift()!(null);
  });
  return {
    ask(prompt) {
      output.write(prompt);
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close: () => rl.close(),
  };
}

interface FieldSpec {
  key: keyof CompanyProfile;
  label: string;
  hint: string;
  kind: "line" | "multi" | "list";
  required: boolean;
}

export const COMPANY_FIELDS: FieldSpec[] = [
  { key: "companyName", label: "Company name", hint: "as customers know it", kind: "line", required: true },
  { key: "website", label: "Website", hint: "https://… (optional)", kind: "line", required: false },
  { key: "oneLiner", label: "One-liner", hint: "what you sell, one sentence", kind: "line", required: true },
  { key: "productDescription", label: "Product description", hint: "what it does, how it works, key features", kind: "multi", required: true },
  { key: "targetCustomers", label: "Target customers (ICP)", hint: "industry, size, geography, buyer role", kind: "multi", required: true },
  { key: "painPoints", label: "Pain points you solve", hint: "one per line, e.g. '- Overselling across channels'", kind: "multi", required: true },
  { key: "differentiators", label: "Differentiators", hint: "optional; why you over alternatives", kind: "multi", required: false },
  { key: "pricingPolicy", label: "Pricing policy", hint: "exactly what agents may say about price", kind: "multi", required: true },
  { key: "proofPoints", label: "Proof points", hint: "optional; case studies / numbers agents may cite", kind: "multi", required: false },
  { key: "forbiddenClaims", label: "Forbidden claims", hint: "optional; things agents must never say", kind: "multi", required: false },
  { key: "meetingLink", label: "Meeting booking link", hint: "https://… (optional)", kind: "line", required: false },
  { key: "languages", label: "Languages", hint: "comma-separated codes, e.g. vi,en", kind: "list", required: true },
];

/**
 * Walks every profile field. Single-line fields take one line; multi-line fields
 * end with an empty line. An empty answer keeps the existing value (or the default).
 * Required fields without a value are asked again (up to 3 times, then the error
 * surfaces from the server). Returns the profile body to PUT.
 */
export async function promptCompanyProfile(
  reader: LineReader,
  existing: CompanyProfile | null,
  out: (line: string) => void = (l) => console.log(l),
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  out("Company profile — answer each question. Press Enter to keep the current value; multi-line answers end with an empty line.\n");

  for (const f of COMPANY_FIELDS) {
    const current = existing?.[f.key];
    const currentText = Array.isArray(current) ? current.join(",") : typeof current === "string" ? current : "";
    const fallback = f.key === "languages" && !currentText ? "vi,en" : currentText;
    let value = "";

    for (let attempt = 0; attempt < 3; attempt++) {
      const keep = fallback ? ` [${fallback.length > 40 ? `${fallback.slice(0, 37)}…` : fallback}]` : "";
      if (f.kind === "multi") {
        out(`${f.label} — ${f.hint}${keep ? `\n  current:${keep}` : ""}`);
        const lines: string[] = [];
        for (;;) {
          const line = await reader.ask(lines.length === 0 ? "> " : "  ");
          if (line === null || line.trim() === "") break;
          lines.push(line);
        }
        value = lines.join("\n");
      } else {
        const line = await reader.ask(`${f.label} (${f.hint})${keep}: `);
        value = (line ?? "").trim();
      }
      if (value === "") value = fallback;
      if (value !== "" || !f.required) break;
      out(`  ${f.label} is required.`);
    }

    if (f.kind === "list") result[f.key] = value.split(",").map((s) => s.trim()).filter(Boolean);
    else if (f.kind === "line" && value === "" && !f.required) result[f.key] = null;
    else result[f.key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Commands

function bail(message: string): never {
  console.error(`hq: ${message}`);
  process.exit(1);
}

export async function cmdSetup(argv: string[], global: CliGlobals): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case "--help":
    case "-h":
      console.log(SETUP_HELP);
      return;
    case "company":
      return setupCompany(rest, global);
    case "email-test":
      return setupEmailTest(rest, global);
    default:
      bail(`unknown setup subcommand "${sub}"\n\n${SETUP_HELP}`);
  }
}

async function setupCompany(argv: string[], global: CliGlobals): Promise<void> {
  let args: SetupCompanyArgs;
  try {
    args = parseSetupCompanyArgs(argv);
  } catch (err) {
    return bail((err as Error).message);
  }
  if (args.help) {
    console.log(SETUP_COMPANY_HELP);
    return;
  }

  const c = new HqClient(global);
  let body: Record<string, unknown>;
  if (args.file) {
    try {
      body = readProfileFile(args.file);
    } catch (err) {
      return bail((err as Error).message);
    }
  } else {
    const { profile } = await c.get<{ profile: CompanyProfile | null }>("/v1/admin/setup/company");
    const reader = createLineReader();
    try {
      body = await promptCompanyProfile(reader, profile);
    } finally {
      reader.close();
    }
  }

  const saved = await c.request<{ profile: CompanyProfile; files?: string[] }>("PUT", "/v1/admin/setup/company", body);
  if (global.json) {
    printJson(saved);
    return;
  }
  console.log(`Saved company profile for ${saved.profile.companyName}.`);
  for (const f of saved.files ?? []) console.log(`  wrote ${f}`);
  const { readiness } = await c.get<{ readiness: ReadinessReport }>("/v1/admin/readiness");
  const failing = readiness.checks.filter((x: ReadinessCheck) => x.status === "fail");
  console.log(failing.length === 0 ? "\nAll go-live checks pass. Run `hq readiness` for details." : `\n${failing.length} go-live check(s) still failing — run \`hq readiness\`.`);
}

async function setupEmailTest(argv: string[], global: CliGlobals): Promise<void> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    console.log(SETUP_EMAIL_TEST_HELP);
    return;
  }
  if (argv.length > 0) bail(`unexpected argument "${argv[0]}"\n\n${SETUP_EMAIL_TEST_HELP}`);
  const c = new HqClient(global);
  const result = await c.post<{ ok: boolean; error: string | null; checkedAt: string }>("/v1/admin/setup/email-test");
  if (global.json) printJson(result);
  else console.log(result.ok ? `✓ email connection OK (${result.checkedAt})` : `✗ email connection failed: ${result.error ?? "unknown error"}`);
  if (!result.ok) process.exitCode = 1;
}

export async function cmdReadiness(argv: string[], global: CliGlobals): Promise<void> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    console.log(READINESS_HELP);
    return;
  }
  if (argv.length > 0) bail(`unexpected argument "${argv[0]}"\n\n${READINESS_HELP}`);
  const c = new HqClient(global);
  let readiness: ReadinessReport;
  try {
    ({ readiness } = await c.get<{ readiness: ReadinessReport }>("/v1/admin/readiness"));
  } catch (err) {
    if (err instanceof HqApiError) return bail(`${err.code}: ${err.message}`);
    throw err;
  }
  if (global.json) printJson(readiness);
  else for (const line of formatReadiness(readiness)) console.log(line);
  if (!readiness.ready) process.exitCode = 1;
}
