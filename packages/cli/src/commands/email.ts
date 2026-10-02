// `hq email doctor` — read-only preflight of the configured real mailbox (see packages/server/src/email-doctor.ts).

import { parseArgs } from "node:util";
import { openDbSnapshot } from "@agyhq/db";
import { loadConfig, runEmailDoctor, type DoctorSampleView, type EmailDoctorReport } from "@agyhq/server";
import { HqApiError, HqClient } from "../client.ts";
import { printJson } from "../format.ts";
import type { CliGlobals } from "./types.ts";

export const EMAIL_HELP = [
  "usage: hq email doctor [--sample <n>] [--send-test <address>] [--local | --daemon]",
  "",
  "Read-only preflight of the configured imap-smtp mailbox, to run BEFORE a shadow run:",
  "  - IMAP login, the mailbox opened read-only, Sent-folder discovery",
  "  - how many existing messages the first sync WOULD ingest (default: none)",
  "  - the latest <n> messages (default 10) parsed, classified, and the agent/task each WOULD be routed to",
  "  - SMTP authentication, WITHOUT sending",
  "Nothing is created, marked as read, moved or sent. Passwords are never printed.",
  "",
  "  --send-test <address>   ALSO send exactly one test email to that address (only when you pass this)",
  "  --local                 run in this process from the config file + env passwords (no daemon needed)",
  "  --daemon                require the running daemon (uses the saved settings, incl. the Setup page)",
  "Default: the daemon if it is reachable, else --local. Exit code 1 when any check fails.",
].join("\n");

const MARKS = { pass: "✓", warn: "!", fail: "✗" } as const;

function clip(s: string | null, n: number): string {
  const t = (s ?? "-").replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function describeRoute(s: DoctorSampleView): string {
  if (s.parseError) return `(unparsed: ${clip(s.parseError, 40)})`;
  if (!s.route) return "-";
  if (s.route.action === "task") return `${s.route.agentId} -> ${s.route.taskKind}`;
  return s.route.action === "ignore" || s.route.action === "skip" ? `ignored` : s.route.action === "parked" ? "unrouted" : s.route.action;
}

/** Human-readable report lines. Pure, so it is unit-tested. */
export function formatEmailDoctor(r: EmailDoctorReport): string[] {
  const lines: string[] = [];
  const c = r.config;
  lines.push(`agy-hq email doctor  (${r.mode})  ${c.address ?? "-"}  ${c.imap ? `imap ${c.imap.host}:${c.imap.port}` : ""}${c.smtp ? `  smtp ${c.smtp.host}:${c.smtp.port}` : ""}`);
  lines.push(`mailbox ${c.mailbox ?? "-"}  |  syncSent ${c.syncSent ? "on" : "off"}  |  initialSyncDays ${c.initialSyncDays}`);
  lines.push("");
  for (const k of r.checks) {
    lines.push(`${MARKS[k.status]} ${k.title}  [${k.id}]`);
    lines.push(`    ${k.detail}`);
  }
  if (r.samples.length > 0) {
    lines.push("");
    lines.push(`Latest ${r.samples.length} message(s), oldest first - what the harness would do (nothing was created):`);
    for (const s of r.samples) {
      const when = s.arrivedAt ? s.arrivedAt.slice(0, 16).replace("T", " ") : "-";
      const sig = s.signals.length ? ` [${s.signals.join(",")}]` : "";
      lines.push(`  ${when}  ${clip(s.from, 34).padEnd(34)}  ${clip(s.subject, 38).padEnd(38)}  ${(s.classification ?? "-")}${sig}${s.knownThread ? " (known thread)" : ""}${s.alreadyIngested ? " (already ingested)" : ""}`);
      lines.push(`      -> ${describeRoute(s)}${s.route ? `: ${s.route.summary}` : ""}`);
    }
  }
  const failing = r.checks.filter((k) => k.status === "fail").length;
  const warns = r.checks.filter((k) => k.status === "warn").length;
  lines.push("");
  lines.push(failing > 0 ? `NOT OK: ${failing} failing check(s)${warns ? `, ${warns} warning(s)` : ""}.` : `OK${warns ? ` (${warns} warning(s) to read above)` : ""}.`);
  return lines;
}

async function fetchReport(global: CliGlobals, opts: { sample: number; sendTest: string | null; local: boolean; daemon: boolean }): Promise<EmailDoctorReport> {
  if (!opts.local) {
    try {
      const { report } = await new HqClient(global).post<{ report: EmailDoctorReport }>("/v1/admin/email/doctor", {
        sample: opts.sample,
        ...(opts.sendTest ? { sendTest: opts.sendTest } : {}),
      });
      return report;
    } catch (err) {
      if (!(err instanceof HqApiError && err.code === "network") || opts.daemon) throw err;
      console.error("(daemon not reachable - checking locally from the config file; routing is predicted against a snapshot of its database if there is one)");
    }
  }
  const config = loadConfig({ configPath: global.configPath });
  const snap = await openDbSnapshot(config.dbPath);
  try {
    return await runEmailDoctor({ config, db: snap.db }, config.email, { sample: opts.sample, sendTest: opts.sendTest, mode: "local" });
  } finally {
    snap.cleanup();
  }
}

export async function cmdEmail(argv: string[], global: CliGlobals): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(EMAIL_HELP);
    return;
  }
  if (sub !== "doctor") {
    console.error(`hq: unknown email subcommand "${sub}"\n\n${EMAIL_HELP}`);
    process.exit(1);
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: { sample: { type: "string" }, "send-test": { type: "string" }, local: { type: "boolean" }, daemon: { type: "boolean" }, help: { type: "boolean", short: "h" } },
      strict: true,
    }));
  } catch (err) {
    console.error(`hq: ${(err as Error).message}\n\n${EMAIL_HELP}`);
    process.exit(1);
  }
  if (values.help) {
    console.log(EMAIL_HELP);
    return;
  }
  const sample = values.sample === undefined ? 10 : Number(values.sample);
  if (!Number.isInteger(sample) || sample < 0 || sample > 50) {
    console.error("hq: --sample must be an integer between 0 and 50");
    process.exit(1);
  }
  if (values.local && values.daemon) {
    console.error("hq: use either --local or --daemon, not both");
    process.exit(1);
  }
  const report = await fetchReport(global, { sample, sendTest: values["send-test"]?.trim() || null, local: values.local === true, daemon: values.daemon === true });
  if (global.json) printJson(report);
  else for (const line of formatEmailDoctor(report)) console.log(line);
  if (!report.ok) process.exit(1);
}
