// Phase 4 CLI commands — see packages/server/src/admin-types.ts "Phase 4 additions".
//   hq kpis [--days 7]
//   hq briefings [list [--limit <n>] | show <id>]
import { parseArgs } from "node:util";
import type { Briefing } from "@agyhq/core";
import type { KpiReport } from "@agyhq/server";
import { HqClient } from "../client.ts";
import { printJson, printTable } from "../format.ts";
import type { CliGlobals } from "./types.ts";

export const KPIS_HELP = [
  "usage: hq kpis [--days <n>]",
  "",
  "Per-role KPIs over the last <n> days (default 7). '-' means there is no data (never a made-up 0).",
].join("\n");

export const BRIEFINGS_HELP = [
  "usage: hq briefings <subcommand> [args]",
  "",
  "subcommands:",
  "  list [--limit <n>]     latest first",
  "  show <id>              the digest as markdown",
].join("\n");

function fail(message: string): never {
  console.error(`hq: ${message}`);
  process.exit(1);
}

const pct = (x: number | null): string => (x === null ? "-" : `${Math.round(x * 1000) / 10}%`);
const num = (x: number | null): string => (x === null ? "-" : String(Math.round(x * 10) / 10));

/** One row per role/metric, for the table view. */
export function kpiRows(report: KpiReport): { role: string; metric: string; value: string }[] {
  const { roles, common } = report;
  const rows: { role: string; metric: string; value: string }[] = [];
  const add = (role: string, metric: string, value: string) => rows.push({ role, metric, value });
  const sdr = roles["sales-sdr"];
  add("sales-sdr", "agents", String(sdr.agents));
  add("sales-sdr", "leadsResearched", String(sdr.leadsResearched));
  add("sales-sdr", "firstTouchDrafted", String(sdr.firstTouchDrafted));
  add("sales-sdr", "emailsSent", String(sdr.emailsSent));
  add("sales-sdr", "replies", String(sdr.replies));
  add("sales-sdr", "replyRate", pct(sdr.replyRate));
  add("sales-sdr", "qualified", String(sdr.qualified));
  add("sales-sdr", "meetingsBooked", String(sdr.meetingsBooked));
  add("sales-sdr", "handoffs", String(sdr.handoffs));
  const am = roles["account-manager"];
  add("account-manager", "agents", String(am.agents));
  add("account-manager", "accounts", String(am.accounts));
  add("account-manager", "messagesHandled", String(am.messagesHandled));
  add("account-manager", "medianFirstResponseMinutes", num(am.medianFirstResponseMinutes));
  add("account-manager", "escalations", String(am.escalations));
  add("account-manager", "checkInsDrafted", String(am.checkInsDrafted));
  add("account-manager", "churned", String(am.churned));
  const cos = roles["chief-of-staff"];
  add("chief-of-staff", "agents", String(cos.agents));
  add("chief-of-staff", "triaged", String(cos.triaged));
  add("chief-of-staff", "delegated", String(cos.delegated));
  add("chief-of-staff", "escalated", String(cos.escalated));
  add("chief-of-staff", "digests", String(cos.digests));
  // Absent when talking to a daemon older than the Fanpage Manager role.
  const fanpage = roles["fanpage-manager"] as KpiReport["roles"]["fanpage-manager"] | undefined;
  if (fanpage) {
    add("fanpage-manager", "agents", String(fanpage.agents));
    add("fanpage-manager", "postsDrafted", String(fanpage.postsDrafted));
    add("fanpage-manager", "postsScheduled", String(fanpage.postsScheduled));
    add("fanpage-manager", "commentsReceived", String(fanpage.commentsReceived));
    add("fanpage-manager", "repliesDrafted", String(fanpage.repliesDrafted));
    add("fanpage-manager", "repliesSent", String(fanpage.repliesSent));
    add("fanpage-manager", "hideProposals", String(fanpage.hideProposals));
    add("fanpage-manager", "escalations", String(fanpage.escalations));
    add("fanpage-manager", "handoffs", String(fanpage.handoffs));
  }
  add("common", "tasksDone", String(common.tasksDone));
  add("common", "tasksFailed", String(common.tasksFailed));
  add("common", "needsHuman", String(common.needsHuman));
  add("common", "approvalRate", pct(common.approvalRate));
  add("common", "medianEditRatio", pct(common.medianEditRatio));
  return rows;
}

export async function cmdKpis(argv: string[], global: CliGlobals): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(KPIS_HELP);
    return;
  }
  let values: { days?: string };
  try {
    ({ values } = parseArgs({ args: argv, options: { days: { type: "string" } } }));
  } catch (err) {
    return fail(`${(err as Error).message}\n${KPIS_HELP}`);
  }
  const days = values.days === undefined ? 7 : Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 365) fail("--days must be an integer between 1 and 365");
  const report = await new HqClient(global).get<KpiReport>(`/v1/admin/kpis?days=${days}`);
  if (global.json) return printJson(report);
  console.log(`window: last ${report.windowDays} days`);
  printTable(kpiRows(report));
}

export async function cmdBriefings(argv: string[], global: CliGlobals): Promise<void> {
  const [sub = "list", ...rest] = argv;
  if (sub === "--help" || sub === "-h") {
    console.log(BRIEFINGS_HELP);
    return;
  }
  const c = new HqClient(global);
  switch (sub) {
    case "list": {
      let values: { limit?: string };
      try {
        ({ values } = parseArgs({ args: rest, options: { limit: { type: "string" } } }));
      } catch (err) {
        return fail(`${(err as Error).message}\n${BRIEFINGS_HELP}`);
      }
      const qs = new URLSearchParams();
      if (values.limit) qs.set("limit", values.limit);
      const { briefings } = await c.get<{ briefings: Briefing[] }>(`/v1/admin/briefings?${qs}`);
      if (global.json) return printJson(briefings);
      printTable(briefings.map((b) => ({ id: b.id, agent: b.agentId, periodStart: b.periodStart, periodEnd: b.periodEnd, createdAt: b.createdAt })));
      return;
    }
    case "show": {
      const id = rest[0];
      if (!id) return fail("briefings show <id>");
      const { briefing } = await c.get<{ briefing: Briefing }>(`/v1/admin/briefings/${id}`);
      if (global.json) return printJson(briefing);
      console.log(`${briefing.id}  ${briefing.periodStart} -> ${briefing.periodEnd}  (agent ${briefing.agentId})\n`);
      console.log(briefing.markdown);
      return;
    }
    default:
      return fail(`unknown "briefings" subcommand: ${sub}. Expected list|show.`);
  }
}
