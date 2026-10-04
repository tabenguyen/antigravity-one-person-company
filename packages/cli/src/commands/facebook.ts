// `hq facebook doctor` — read-only preflight of the Facebook Page channel (see packages/server/src/facebook/doctor.ts).

import { parseArgs } from "node:util";
import { openDbSnapshot } from "@agyhq/db";
import { loadConfig, runFacebookDoctor, tryCreateProvider, type FacebookDoctorReport } from "@agyhq/server";
import { HqApiError, HqClient } from "../client.ts";
import { printJson } from "../format.ts";
import type { CliGlobals } from "./types.ts";

export const FACEBOOK_HELP = [
  "usage: hq facebook doctor [--local | --daemon]",
  "",
  "Read-only preflight of the Facebook Page channel, to run BEFORE the first shadow run:",
  "  - the access token is accepted (read from the env var named by facebook.tokenEnv; never printed)",
  "  - /me resolves to the configured Page",
  "  - the five Page permissions (pages_manage_posts, pages_read_engagement, pages_manage_engagement,",
  "    pages_read_user_content, pages_show_list) are granted",
  "  - the app mode (development / live) and the scheduling lead time",
  "  - who could post what (kill switch, trust tiers, default Fanpage agent)",
  "Nothing is posted, scheduled, hidden or deleted. With facebook.kind \"fake\" it runs entirely offline.",
  "",
  "  --local     run in this process from the config file + env vars (no daemon needed)",
  "  --daemon    require the running daemon (uses its live provider)",
  "Default: the daemon if it is reachable, else --local. Exit code 1 when any check fails.",
].join("\n");

const MARKS = { pass: "✓", warn: "!", fail: "✗" } as const;

/** Human-readable report lines. Pure, so it is unit-tested. */
export function formatFacebookDoctor(r: FacebookDoctorReport): string[] {
  const c = r.config;
  const lines: string[] = [];
  lines.push(`agy-hq facebook doctor  (${r.mode})  kind ${c.kind}${c.pageId ? `  page ${c.pageId}` : ""}${c.apiVersion ? `  api ${c.apiVersion}` : ""}`);
  lines.push(
    `app ${c.appId ?? "(appId not set in the config)"}  |  app secret ${c.appSecretPresent === null ? "n/a" : c.appSecretPresent ? "set" : "not set"}  |  appsecret_proof ${r.inspection ? (r.inspection.appSecretProof ? "sent" : "not sent") : "unknown"}`,
  );
  lines.push(`token ${c.tokenEnv ? `$${c.tokenEnv} ${c.tokenPresent ? "set" : "NOT SET"}` : "n/a"}  |  poll every ${Math.round(c.pollIntervalMs / 1000)}s  |  posts scheduled >= ${c.scheduleLeadHours}h ahead`);
  lines.push("");
  for (const k of r.checks) {
    lines.push(`${MARKS[k.status]} ${k.title}  [${k.id}]`);
    lines.push(`    ${k.detail}`);
  }
  const s = r.safety;
  lines.push("");
  lines.push(
    `outbound ${s.outboundEnabled ? "ENABLED" : "disabled (kill switch)"}  |  fanpage agents: ${s.agents.length ? s.agents.map((a) => `${a.id} (${a.trustTier}, ${a.status})`).join(", ") : "none"}  |  drafts waiting: ${s.pendingDrafts}`,
  );
  const failing = r.checks.filter((k) => k.status === "fail").length;
  const warns = r.checks.filter((k) => k.status === "warn").length;
  lines.push(failing > 0 ? `NOT OK: ${failing} failing check(s)${warns ? `, ${warns} warning(s)` : ""}.` : `OK${warns ? ` (${warns} warning(s) to read above)` : ""}.`);
  return lines;
}

async function fetchReport(global: CliGlobals, opts: { local: boolean; daemon: boolean }): Promise<FacebookDoctorReport> {
  if (!opts.local) {
    try {
      const { report } = await new HqClient(global).post<{ report: FacebookDoctorReport }>("/v1/admin/facebook/doctor", {});
      return report;
    } catch (err) {
      if (!(err instanceof HqApiError && err.code === "network") || opts.daemon) throw err;
      console.error("(daemon not reachable - checking locally from the config file and the environment)");
    }
  }
  const config = loadConfig({ configPath: global.configPath });
  const { provider, error } = tryCreateProvider(config.facebook);
  const snap = await openDbSnapshot(config.dbPath);
  try {
    return await runFacebookDoctor({ config, db: snap.db }, provider, { mode: "local", providerError: error });
  } finally {
    await provider?.close().catch(() => {});
    snap.cleanup();
  }
}

export async function cmdFacebook(argv: string[], global: CliGlobals): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(FACEBOOK_HELP);
    return;
  }
  if (sub !== "doctor") {
    console.error(`hq: unknown facebook subcommand "${sub}"\n\n${FACEBOOK_HELP}`);
    process.exit(1);
  }
  let values;
  try {
    ({ values } = parseArgs({ args: rest, options: { local: { type: "boolean" }, daemon: { type: "boolean" }, help: { type: "boolean", short: "h" } }, strict: true }));
  } catch (err) {
    console.error(`hq: ${(err as Error).message}\n\n${FACEBOOK_HELP}`);
    process.exit(1);
  }
  if (values.help) {
    console.log(FACEBOOK_HELP);
    return;
  }
  if (values.local && values.daemon) {
    console.error("hq: use either --local or --daemon, not both");
    process.exit(1);
  }
  const report = await fetchReport(global, { local: values.local === true, daemon: values.daemon === true });
  if (global.json) printJson(report);
  else for (const line of formatFacebookDoctor(report)) console.log(line);
  if (!report.ok) process.exit(1);
}
