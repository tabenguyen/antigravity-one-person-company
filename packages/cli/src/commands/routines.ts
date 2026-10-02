// `hq routine ...` and `hq eval ...` — recurring work per agent, and template regression evals.
// See packages/server/src/admin-types.ts "Phase 3 additions" for the routes.

import { parseArgs } from "node:util";
import type { EvalCaseResult, EvalRun, Routine, RoutineKind } from "@agyhq/core";
import { HqClient } from "../client.ts";
import { printJson, printTable } from "../format.ts";
import type { CliGlobals } from "./types.ts";

export const ROUTINE_HELP = [
  "usage: hq routine <subcommand> [args]",
  "",
  "subcommands:",
  "  list [--agent <id>]",
  "  create --agent <id> --kind <prospecting|pipeline_review|account_review|daily_digest|custom_task> --name <name> --schedule '<cron>'",
  "         [--tz <IANA zone, default Asia/Ho_Chi_Minh>] [--config '<json>'] [--disabled]",
  "  update <id> [--name <n>] [--schedule '<cron>'] [--tz <zone>] [--kind <k>] [--config '<json>'] [--enabled true|false]",
  "  delete <id>",
  "  run <id>                     run now, regardless of schedule (does not move the next scheduled run)",
  "",
  "schedule is a 5-field cron (minute hour day-of-month month day-of-week) evaluated in --tz:",
  "  '0 9 * * 1-5'   weekdays at 09:00      '30 8 * * *'   daily at 08:30      '*/15 * * * *'   every 15 minutes",
  "",
  "config by kind:",
  "  prospecting      {\"batchSize\":5,\"stages\":[\"new\"]}   research the next N uncontacted leads (max 25)",
  "  pipeline_review  {}                                 daily pipeline summary + missing follow-ups",
  "  account_review   {\"maxAccounts\":40,\"staleAfterDays\":14}   account manager: review customer accounts, flag at-risk, schedule check-ins",
  "  daily_digest     {\"lookbackHours\":24}                chief of staff: the owner's daily brief (see `hq briefings`)",
  "  custom_task      {\"kind\":\"sdr.follow_up\",\"title\":\"...\",\"input\":{}}   create this task each time",
].join("\n");

export const EVAL_HELP = [
  "usage: hq eval <subcommand> [args]",
  "",
  "subcommands:",
  "  run [--suite sales-sdr|account-manager|chief-of-staff] [--case <id> ...] [--model <model-id>] [--wait]",
  "        start a regression run (real model runs: costs quota; cases run one at a time).",
  "        --wait follows the run and prints the results table (exit code 1 if any case is not 'pass').",
  "  list [--suite <name>] [--limit <n>]",
  "  show <run-id>              per-case results with assertion details",
  "  suites                     available suites and their case ids",
].join("\n");

const ROUTINE_KINDS: RoutineKind[] = ["prospecting", "pipeline_review", "account_review", "daily_digest", "custom_task"];

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)

function strictParse<T extends Record<string, unknown>>(argv: string[], options: Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }>, usage: string, positionals = false) {
  try {
    return parseArgs({ args: argv, options: { ...options, help: { type: "boolean", short: "h" } }, allowPositionals: positionals, strict: true }) as unknown as {
      values: T & { help?: boolean };
      positionals: string[];
    };
  } catch (err) {
    throw new Error(`${(err as Error).message}\n\n${usage}`);
  }
}

function parseConfigJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--config must be valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--config must be a JSON object");
  return parsed as Record<string, unknown>;
}

export interface RoutineCreateArgs {
  help: boolean;
  body: { agentId: string; kind: RoutineKind; name: string; schedule: string; timezone?: string; config: Record<string, unknown>; enabled: boolean };
}

export function parseRoutineCreateArgs(argv: string[]): RoutineCreateArgs {
  const { values } = strictParse<{ agent?: string; kind?: string; name?: string; schedule?: string; tz?: string; config?: string; disabled?: boolean }>(
    argv,
    { agent: { type: "string" }, kind: { type: "string" }, name: { type: "string" }, schedule: { type: "string" }, tz: { type: "string" }, config: { type: "string" }, disabled: { type: "boolean" } },
    ROUTINE_HELP,
  );
  if (values.help) return { help: true, body: { agentId: "", kind: "prospecting", name: "", schedule: "", config: {}, enabled: true } };
  for (const required of ["agent", "kind", "name", "schedule"] as const) {
    if (!values[required]) throw new Error(`--${required} is required\n\n${ROUTINE_HELP}`);
  }
  if (!ROUTINE_KINDS.includes(values.kind as RoutineKind)) throw new Error(`--kind must be one of ${ROUTINE_KINDS.join(", ")} (got "${values.kind}")`);
  return {
    help: false,
    body: {
      agentId: values.agent!,
      kind: values.kind as RoutineKind,
      name: values.name!,
      schedule: values.schedule!,
      ...(values.tz ? { timezone: values.tz } : {}),
      config: parseConfigJson(values.config) ?? {},
      enabled: values.disabled !== true,
    },
  };
}

export interface RoutineUpdateArgs {
  help: boolean;
  id: string;
  body: Record<string, unknown>;
}

export function parseRoutineUpdateArgs(argv: string[]): RoutineUpdateArgs {
  const { values, positionals } = strictParse<{ name?: string; schedule?: string; tz?: string; kind?: string; config?: string; enabled?: string }>(
    argv,
    { name: { type: "string" }, schedule: { type: "string" }, tz: { type: "string" }, kind: { type: "string" }, config: { type: "string" }, enabled: { type: "string" } },
    ROUTINE_HELP,
    true,
  );
  if (values.help) return { help: true, id: "", body: {} };
  const id = positionals[0];
  if (!id) throw new Error("routine update <id> [flags]");
  const body: Record<string, unknown> = {};
  if (values.name !== undefined) body["name"] = values.name;
  if (values.schedule !== undefined) body["schedule"] = values.schedule;
  if (values.tz !== undefined) body["timezone"] = values.tz;
  if (values.kind !== undefined) {
    if (!ROUTINE_KINDS.includes(values.kind as RoutineKind)) throw new Error(`--kind must be one of ${ROUTINE_KINDS.join(", ")}`);
    body["kind"] = values.kind;
  }
  const config = parseConfigJson(values.config);
  if (config !== undefined) body["config"] = config;
  if (values.enabled !== undefined) {
    if (values.enabled !== "true" && values.enabled !== "false") throw new Error('--enabled must be "true" or "false"');
    body["enabled"] = values.enabled === "true";
  }
  if (Object.keys(body).length === 0) throw new Error(`nothing to update: pass at least one of --name --schedule --tz --kind --config --enabled`);
  return { help: false, id, body };
}

export interface EvalRunArgs {
  help: boolean;
  body: { suite: string; model?: string; caseIds?: string[] };
  wait: boolean;
}

export function parseEvalRunArgs(argv: string[]): EvalRunArgs {
  const { values } = strictParse<{ suite?: string; case?: string[]; model?: string; wait?: boolean }>(
    argv,
    { suite: { type: "string" }, case: { type: "string", multiple: true }, model: { type: "string" }, wait: { type: "boolean" } },
    EVAL_HELP,
  );
  const caseIds = (values.case ?? []).flatMap((c) => c.split(",")).map((c) => c.trim()).filter(Boolean);
  return {
    help: values.help === true,
    body: { suite: values.suite ?? "sales-sdr", ...(values.model ? { model: values.model } : {}), ...(caseIds.length ? { caseIds } : {}) },
    wait: values.wait === true,
  };
}

/** Cron in words is a UI nicety; the CLI prints the raw schedule + timezone. */
export function routineRows(routines: Routine[]): Record<string, unknown>[] {
  return routines.map((r) => ({
    id: r.id,
    agent: r.agentId,
    kind: r.kind,
    name: r.name,
    schedule: `${r.schedule} (${r.timezone})`,
    enabled: r.enabled ? "yes" : "no",
    next: r.nextRunAt ?? "-",
    last: r.lastRunAt ?? "-",
    lastResult: r.lastResult ?? "-",
  }));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export function evalRunRows(runs: EvalRun[]): Record<string, unknown>[] {
  return runs.map((r) => ({
    id: r.id,
    suite: r.suite,
    model: r.model,
    status: r.status,
    pass: r.summary ? `${r.summary.pass}/${r.summary.total}` : "-",
    fail: r.summary?.fail ?? "-",
    error: r.summary?.error ?? "-",
    started: r.startedAt,
    duration: r.finishedAt ? formatDuration(new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) : "-",
  }));
}

const MARK: Record<EvalCaseResult["status"], string> = { pass: "PASS", fail: "FAIL", error: "ERROR", skipped: "SKIP" };

export function evalCaseRows(results: EvalCaseResult[]): Record<string, unknown>[] {
  return results.map((r) => {
    const bad = r.assertions.filter((a) => !a.ok);
    return {
      case: r.caseId,
      result: MARK[r.status],
      time: formatDuration(r.durationMs),
      assertions: `${r.assertions.length - bad.length}/${r.assertions.length}`,
      failed: bad.length ? bad.map((a) => a.name).join("; ") : "-",
    };
  });
}

/** Detailed lines for non-passing cases (assertion name + why), for `eval show` / `eval run --wait`. */
export function evalFailureLines(results: EvalCaseResult[]): string[] {
  const lines: string[] = [];
  for (const r of results.filter((x) => x.status !== "pass")) {
    lines.push("", `${MARK[r.status]} ${r.caseId}`);
    for (const a of r.assertions.filter((x) => !x.ok)) lines.push(`  x ${a.name}${a.detail ? `\n      ${a.detail}` : ""}`);
  }
  return lines;
}

export function evalSummaryLine(run: EvalRun): string {
  const s = run.summary;
  if (!s) return `run ${run.id}: ${run.status} (${run.results.length} case(s) finished so far)`;
  return `run ${run.id} [${run.suite} / ${run.model}]: ${s.pass}/${s.total} passed, ${s.fail} failed, ${s.error} error, ${s.skipped} skipped`;
}

// ---------------------------------------------------------------------------
// Commands

/** Thrown for usage/validation problems; the command wrappers print it as `hq: <message>` and set exit code 1. */
class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

function report(err: unknown): void {
  console.error(`hq: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}

export async function cmdRoutine(argv: string[], global: CliGlobals): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") return void console.log(ROUTINE_HELP);
  try {
    const c = new HqClient(global);
    switch (sub) {
      case "list": {
        const { values } = strictParse<{ agent?: string }>(rest, { agent: { type: "string" } }, ROUTINE_HELP);
        if (values.help) return void console.log(ROUTINE_HELP);
        const qs = values.agent ? `?agentId=${encodeURIComponent(values.agent)}` : "";
        const { routines } = await c.get<{ routines: Routine[] }>(`/v1/admin/routines${qs}`);
        return global.json ? printJson(routines) : printTable(routineRows(routines));
      }
      case "create": {
        const args = parseRoutineCreateArgs(rest);
        if (args.help) return void console.log(ROUTINE_HELP);
        const { routine } = await c.post<{ routine: Routine }>("/v1/admin/routines", args.body);
        return global.json ? printJson(routine) : (console.log(`created ${routine.id} (next run ${routine.nextRunAt ?? "-"})`), void 0);
      }
      case "update": {
        const args = parseRoutineUpdateArgs(rest);
        if (args.help) return void console.log(ROUTINE_HELP);
        const { routine } = await c.patch<{ routine: Routine }>(`/v1/admin/routines/${encodeURIComponent(args.id)}`, args.body);
        return global.json ? printJson(routine) : (console.log(`updated ${routine.id} (next run ${routine.nextRunAt ?? "-"})`), void 0);
      }
      case "delete": {
        const id = rest[0];
        if (!id || id.startsWith("-")) return rest[0] === "--help" ? void console.log(ROUTINE_HELP) : fail("routine delete <id>");
        await c.request("DELETE", `/v1/admin/routines/${encodeURIComponent(id)}`);
        return global.json ? printJson({ deleted: true }) : console.log(`deleted ${id}`);
      }
      case "run": {
        const id = rest[0];
        if (!id || id.startsWith("-")) return rest[0] === "--help" ? void console.log(ROUTINE_HELP) : fail("routine run <id>");
        const { routine } = await c.post<{ routine: Routine }>(`/v1/admin/routines/${encodeURIComponent(id)}/run`);
        return global.json ? printJson(routine) : console.log(`${routine.name}: ${routine.lastResult ?? "(no result)"}`);
      }
      default:
        fail(`unknown "routine" subcommand: ${sub}. Expected list|create|update|delete|run.`);
    }
  } catch (err) {
    report(err);
  }
}

export interface EvalWaitOptions {
  intervalMs?: number;
  onProgress?: (run: EvalRun) => void;
}

/** Polls GET /evals/:id until the run leaves "running". */
export async function waitForEvalRun(c: Pick<HqClient, "get">, id: string, opts: EvalWaitOptions = {}): Promise<EvalRun> {
  let lastCount = -1;
  for (;;) {
    const { run } = await c.get<{ run: EvalRun }>(`/v1/admin/evals/${encodeURIComponent(id)}`);
    if (run.results.length !== lastCount) {
      lastCount = run.results.length;
      opts.onProgress?.(run);
    }
    if (run.status !== "running") return run;
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 2000));
  }
}

function printEvalRun(run: EvalRun): void {
  console.log(evalSummaryLine(run));
  printTable(evalCaseRows(run.results));
  for (const line of evalFailureLines(run.results)) console.log(line);
}

export async function cmdEval(argv: string[], global: CliGlobals): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") return void console.log(EVAL_HELP);
  try {
    const c = new HqClient(global);
    switch (sub) {
      case "run": {
        const args = parseEvalRunArgs(rest);
        if (args.help) return void console.log(EVAL_HELP);
        const { run: started } = await c.post<{ run: EvalRun }>("/v1/admin/evals", args.body);
        if (!args.wait) {
          return global.json ? printJson(started) : console.log(`started eval run ${started.id} (suite ${started.suite}, model ${started.model})\nfollow it with: hq eval show ${started.id}`);
        }
        if (!global.json) console.log(`started eval run ${started.id} (suite ${started.suite}, model ${started.model}); waiting...`);
        const run = await waitForEvalRun(c, started.id, {
          intervalMs: Number(process.env["AGYHQ_EVAL_POLL_MS"]) || 2000,
          onProgress: (r) => {
            if (!global.json && r.results.length > 0) console.log(`  ${r.results.length} case(s) finished (last: ${r.results[r.results.length - 1]!.caseId} ${MARK[r.results[r.results.length - 1]!.status]})`);
          },
        });
        global.json ? printJson(run) : printEvalRun(run);
        if (run.status !== "done" || (run.summary && run.summary.pass !== run.summary.total)) process.exitCode = 1;
        return;
      }
      case "list": {
        const { values } = strictParse<{ suite?: string; limit?: string }>(rest, { suite: { type: "string" }, limit: { type: "string" } }, EVAL_HELP);
        if (values.help) return void console.log(EVAL_HELP);
        const qs = new URLSearchParams();
        if (values.suite) qs.set("suite", values.suite);
        if (values.limit) qs.set("limit", values.limit);
        const { runs } = await c.get<{ runs: EvalRun[] }>(`/v1/admin/evals${qs.size ? `?${qs}` : ""}`);
        return global.json ? printJson(runs) : printTable(evalRunRows(runs));
      }
      case "show": {
        const id = rest[0];
        if (!id || id.startsWith("-")) return rest[0] === "--help" ? void console.log(EVAL_HELP) : fail("eval show <run-id>");
        const { run } = await c.get<{ run: EvalRun }>(`/v1/admin/evals/${encodeURIComponent(id)}`);
        return global.json ? printJson(run) : printEvalRun(run);
      }
      case "suites": {
        const { suites } = await c.get<{ suites: { name: string; defaultModel: string | null; cases: { id: string; kind: string; description: string }[] }[] }>("/v1/admin/evals/suites");
        if (global.json) return printJson(suites);
        for (const s of suites) {
          console.log(`${s.name} (default model ${s.defaultModel ?? "-"})`);
          printTable(s.cases.map((k) => ({ case: k.id, kind: k.kind, description: k.description })));
        }
        return;
      }
      default:
        fail(`unknown "eval" subcommand: ${sub}. Expected run|list|show|suites.`);
    }
  } catch (err) {
    report(err);
  }
}
