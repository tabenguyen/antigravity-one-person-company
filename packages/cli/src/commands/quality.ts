// Phase 3 CLI commands — see packages/server/src/admin-types.ts "Phase 3 additions".
//   hq scorecard [--days 14] [--agent <id>]
//   hq promote <agentId> [--force] [--note <text>]
import { parseArgs } from "node:util";
import type { Agent, AgentScorecard, PromotionCriteria } from "@agyhq/core";
import { HqClient } from "../client.ts";
import { printJson, printTable } from "../format.ts";
import type { CliGlobals } from "./types.ts";

export const SCORECARD_HELP = [
  "usage: hq scorecard [--days <n>] [--agent <id>]",
  "",
  "Per-agent quality scorecard over the last <n> days (default 14): draft volume,",
  "approval rate, edit ratio, lint error rate, replies, and whether the agent is",
  "eligible for promotion to its next trust tier (with the unmet criteria).",
].join("\n");

export const PROMOTE_HELP = [
  "usage: hq promote <agentId> [--force] [--note <text>]",
  "",
  "Move an agent to its next trust tier (shadow -> assisted -> autonomous).",
  "Refused (409) unless the scorecard says it is eligible; --force overrides and is audited.",
].join("\n");

function fail(message: string): never {
  console.error(`hq: ${message}`);
  process.exit(1);
}

const pct = (x: number | null): string => (x === null ? "-" : `${Math.round(x * 1000) / 10}%`);
const minutes = (x: number | null): string => (x === null ? "-" : x < 90 ? `${Math.round(x * 10) / 10}m` : `${Math.round(x / 6) / 10}h`);

export function formatCriteriaLines(criteria: PromotionCriteria, days: number): string[] {
  const lines: string[] = [];
  lines.push(`window: last ${days} days`);
  lines.push(
    `criteria: >= ${criteria.minDecided} decided, approval >= ${pct(criteria.minApprovalRate)}, median edit <= ${pct(criteria.maxMedianEditRatio)}, ` +
      `compliance rejections <= ${criteria.maxComplianceRejections}, lint errors <= ${pct(criteria.maxLintErrorsRate)}`,
  );
  return lines;
}

export async function cmdScorecard(argv: string[], global: CliGlobals): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(SCORECARD_HELP);
    return;
  }
  let values: { days?: string; agent?: string };
  try {
    ({ values } = parseArgs({ args: argv, options: { days: { type: "string" }, agent: { type: "string" } } }));
  } catch (err) {
    return fail(`${(err as Error).message}\n${SCORECARD_HELP}`);
  }
  const days = values.days === undefined ? 14 : Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 365) fail("--days must be an integer between 1 and 365");

  const c = new HqClient(global);
  const qs = new URLSearchParams({ days: String(days) });
  if (values.agent) qs.set("agentId", values.agent);
  const data = await c.get<{ days: number; criteria: PromotionCriteria; scorecards: AgentScorecard[] }>(`/v1/admin/scorecards?${qs}`);
  if (global.json) return printJson(data);

  for (const line of formatCriteriaLines(data.criteria, data.days)) console.log(line);
  console.log("");
  printTable(
    data.scorecards.map((s) => ({
      agent: s.agentId,
      tier: s.trustTier,
      drafts: s.drafts,
      decided: s.decided,
      approval: pct(s.approvalRate),
      "med edit": pct(s.medianEditRatio),
      "lint err": pct(s.lintErrorRate),
      review: minutes(s.medianReviewMinutes),
      sent: s.sent,
      replies: s.replies,
      next: s.promotion ? `${s.promotion.nextTier}${s.promotion.eligible ? " (eligible)" : ""}` : "-",
    })),
  );

  for (const s of data.scorecards) {
    const cats = Object.entries(s.rejectionsByCategory);
    if (cats.length > 0) console.log(`\n${s.agentId} rejections: ${cats.map(([k, v]) => `${k}=${v}`).join(", ")}`);
    if (s.promotion && !s.promotion.eligible) {
      console.log(`\n${s.agentId} not yet eligible for ${s.promotion.nextTier}:`);
      for (const reason of s.promotion.unmet) console.log(`  - ${reason}`);
    } else if (s.promotion?.eligible) {
      console.log(`\n${s.agentId} is eligible for ${s.promotion.nextTier}: hq promote ${s.agentId}`);
    }
  }
}

export async function cmdPromote(argv: string[], global: CliGlobals): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(PROMOTE_HELP);
    return;
  }
  let parsed: { values: { force?: boolean; note?: string }; positionals: string[] };
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { force: { type: "boolean" }, note: { type: "string" } } });
  } catch (err) {
    return fail(`${(err as Error).message}\n${PROMOTE_HELP}`);
  }
  const agentId = parsed.positionals[0];
  if (!agentId) fail(`agent id required\n${PROMOTE_HELP}`);

  const c = new HqClient(global);
  const before = await c.get<{ agent: Agent }>(`/v1/admin/agents/${encodeURIComponent(agentId)}`);
  const { agent } = await c.post<{ agent: Agent }>(`/v1/admin/agents/${encodeURIComponent(agentId)}/promote`, {
    ...(parsed.values.force ? { force: true } : {}),
    ...(parsed.values.note ? { note: parsed.values.note } : {}),
  });
  if (global.json) return printJson({ agent, from: before.agent.trustTier, to: agent.trustTier });
  console.log(`${agent.id}: ${before.agent.trustTier} -> ${agent.trustTier}${parsed.values.force ? " (forced)" : ""}`);
}
