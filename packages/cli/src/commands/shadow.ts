// Shadow-run CLI — see the "Shadow run" block in packages/server/src/admin-types.ts.
//   hq shadow start [--days 14] [--agents a,b] [--notes <text>]
//   hq shadow status [--id <runId>] [--daily]
//   hq shadow end [--id <runId>] [--notes <text>]
//   hq shadow list
import { parseArgs } from "node:util";
import type { ShadowOverview, ShadowRunStatus } from "@agyhq/server";
import { HqClient } from "../client.ts";
import { printJson, printTable } from "../format.ts";
import type { CliGlobals } from "./types.ts";

export const SHADOW_HELP = [
  "usage: hq shadow <subcommand> [args]",
  "",
  "A shadow run is a bounded evaluation (default 14 days) of shadow-tier agents: they read real mail and draft,",
  "you approve / edit / reject in the inbox, nothing is ever sent. `status` shows per-agent results and a verdict.",
  "",
  "subcommands:",
  "  start [--days <n>] [--agents <id,id>] [--notes <text>]   begin a run (default: every shadow-tier SDR/AM agent, 14 days)",
  "  status [--id <runId>] [--daily]                          day N of M, per-agent breakdown, verdict (active run, else the last one)",
  "  end [--id <runId>] [--notes <text>]                      close the run (the result stays visible with `status`)",
  "  list                                                     all runs",
].join("\n");

function fail(message: string): never {
  console.error(`hq: ${message}`);
  process.exit(1);
}

const pct = (x: number | null): string => (x === null ? "-" : `${Math.round(x * 1000) / 10}%`);
const minutes = (x: number | null): string => (x === null ? "-" : x < 90 ? `${Math.round(x * 10) / 10}m` : `${Math.round(x / 6) / 10}h`);
const VERDICT_LABEL = { on_track: "ON TRACK", not_enough_data: "NOT ENOUGH DATA", below_bar: "BELOW BAR" } as const;

/** Human-readable status, one line per fact. Exported for tests. */
export function formatShadowStatus(st: ShadowRunStatus, opts: { daily?: boolean } = {}): string[] {
  const lines: string[] = [];
  const state = st.active ? (st.complete ? "planned length reached — time to decide" : `${st.daysRemaining} day(s) left`) : `ended ${st.run.endedAt}`;
  lines.push(`shadow run ${st.run.id}  day ${st.day} of ${st.plannedDays}  (${state})`);
  lines.push(`started ${st.run.startedAt}  planned end ${st.endsAt}${st.run.notes ? `  notes: ${st.run.notes}` : ""}`);
  const c = st.criteria;
  lines.push(
    `bar: >= ${c.minDecided} decided, approval >= ${pct(c.minApprovalRate)}, median edit <= ${pct(c.maxMedianEditRatio)}, ` +
      `compliance rejections <= ${c.maxComplianceRejections}, lint errors <= ${pct(c.maxLintErrorsRate)}`,
  );
  const t = st.totals;
  lines.push(
    `totals: ${t.drafts} drafts, ${t.approvedUnchanged} approved unchanged, ${t.approvedEdited} approved with edits, ${t.rejected} rejected, ${t.pending} waiting for you` +
      (t.oldestPendingAt ? ` (oldest ${t.oldestPendingAt})` : ""),
  );
  return lines;
}

export function shadowAgentRows(st: ShadowRunStatus): Record<string, unknown>[] {
  return st.agents.map((a) => ({
    agent: a.agentId,
    verdict: VERDICT_LABEL[a.verdict.status],
    drafts: a.drafts,
    unchanged: a.approvedUnchanged,
    edited: `${a.approvedEdited}${a.medianEditRatioOfEdited === null ? "" : ` (med ${pct(a.medianEditRatioOfEdited)})`}`,
    rejected: a.rejected,
    pending: a.pending,
    "lint err": a.lintErrors,
    "needs human": a.needsHuman,
    review: minutes(a.medianReviewMinutes),
  }));
}

export async function cmdShadow(argv: string[], global: CliGlobals): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(SHADOW_HELP);
    return;
  }
  const c = new HqClient(global);
  const parse = (options: Record<string, { type: "string" | "boolean" }>) => {
    try {
      return parseArgs({ args: rest, options }).values as Record<string, string | boolean | undefined>;
    } catch (err) {
      return fail(`${(err as Error).message}\n${SHADOW_HELP}`);
    }
  };

  switch (sub) {
    case "start": {
      const v = parse({ days: { type: "string" }, agents: { type: "string" }, notes: { type: "string" } });
      const body: { plannedDays?: number; agentIds?: string[]; notes?: string } = {};
      if (v.days !== undefined) {
        const days = Number(v.days);
        if (!Number.isInteger(days) || days < 1 || days > 90) fail("--days must be an integer between 1 and 90");
        body.plannedDays = days;
      }
      if (typeof v.agents === "string") body.agentIds = v.agents.split(",").map((s) => s.trim()).filter(Boolean);
      if (typeof v.notes === "string") body.notes = v.notes;
      const { status } = await c.post<{ status: ShadowRunStatus }>("/v1/admin/shadow", body);
      if (global.json) return printJson(status);
      console.log(`started shadow run ${status.run.id} for ${status.run.agentIds.join(", ")} (${status.plannedDays} days, ends ${status.endsAt})`);
      console.log("nothing is sent in shadow tier: approving a draft only records your verdict (status: held).");
      return;
    }
    case "status": {
      const v = parse({ id: { type: "string" }, daily: { type: "boolean" } });
      let status: ShadowRunStatus | null;
      if (typeof v.id === "string") {
        status = (await c.get<{ status: ShadowRunStatus }>(`/v1/admin/shadow/${encodeURIComponent(v.id)}`)).status;
      } else {
        const overview = await c.get<ShadowOverview>("/v1/admin/shadow");
        status = overview.active ?? overview.last;
        if (!status) {
          if (global.json) return printJson(overview);
          console.log("no shadow run yet. Start one with: hq shadow start");
          if (overview.candidates.length) console.log(`agents it would cover: ${overview.candidates.map((a) => a.agentId).join(", ")}`);
          return;
        }
      }
      if (global.json) return printJson(status);
      for (const line of formatShadowStatus(status)) console.log(line);
      console.log("");
      printTable(shadowAgentRows(status));
      console.log("");
      for (const a of status.agents) {
        console.log(`${a.agentId}: ${VERDICT_LABEL[a.verdict.status]} — ${a.verdict.reason}`);
        const cats = Object.entries(a.rejectionsByCategory).map(([k, n]) => `${k}=${n}`).join(", ");
        if (cats) console.log(`  rejections: ${cats}`);
      }
      if (v.daily) {
        console.log("");
        printTable(status.daily.map((d) => ({ day: d.day, from: d.startAt.slice(0, 10), drafts: d.drafts, unchanged: d.approvedUnchanged, edited: d.approvedEdited, rejected: d.rejected })));
      }
      return;
    }
    case "end": {
      const v = parse({ id: { type: "string" }, notes: { type: "string" } });
      let id = typeof v.id === "string" ? v.id : null;
      if (!id) {
        const overview = await c.get<ShadowOverview>("/v1/admin/shadow");
        if (!overview.active) fail("no active shadow run");
        id = overview.active.run.id;
      }
      const { status } = await c.post<{ status: ShadowRunStatus }>(`/v1/admin/shadow/${encodeURIComponent(id)}/end`, typeof v.notes === "string" ? { notes: v.notes } : {});
      if (global.json) return printJson(status);
      console.log(`ended shadow run ${status.run.id} at day ${status.day} of ${status.plannedDays}`);
      for (const a of status.agents) console.log(`${a.agentId}: ${VERDICT_LABEL[a.verdict.status]} — ${a.verdict.reason}`);
      console.log("promotion is still a separate, explicit step: hq scorecard / hq promote <agentId>");
      return;
    }
    case "list": {
      const { history } = await c.get<ShadowOverview>("/v1/admin/shadow");
      if (global.json) return printJson(history);
      printTable(history.map((r) => ({ id: r.id, started: r.startedAt, days: r.plannedDays, ended: r.endedAt ?? "(active)", agents: r.agentIds.join(",") })));
      return;
    }
    default:
      return fail(`unknown "shadow" subcommand: ${sub}. Expected start|status|end|list.`);
  }
}
