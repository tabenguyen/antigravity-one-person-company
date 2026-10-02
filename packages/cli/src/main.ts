#!/usr/bin/env node
// `hq` — CLI for the agy-hq daemon. Talks to the admin API over HTTP
// (see client.ts for URL/token resolution); `hq serve` is the one command
// that runs the daemon in-process instead of calling it.

import { parseArgs } from "node:util";
import type {
  Agent,
  AgentRole,
  AgentStatus,
  AuditEvent,
  HqSettings,
  InboundEvent,
  MemoryItem,
  OutboxItem,
  OutboxStatus,
  Task,
  TaskStatus,
  TrustTier,
} from "@agyhq/core";
import { TERMINAL_TASK_STATUSES } from "@agyhq/core";
import { loadConfig, startDaemon, type DaemonStatus } from "@agyhq/server";
import { HqApiError, HqClient, type ClientOptions } from "./client.ts";
import { printJson, printKv, printTable } from "./format.ts";
import { readSse } from "./sse.ts";
import { cmdReadiness, cmdSetup } from "./commands/setup.ts";
import { cmdPromote, cmdScorecard } from "./commands/quality.ts";
import { cmdEval, cmdRoutine } from "./commands/routines.ts";
import { cmdBriefings, cmdKpis } from "./commands/coordination.ts";
import { cmdShadow } from "./commands/shadow.ts";
import { cmdEmail } from "./commands/email.ts";

const HELP: Record<string, string> = {
  agent: [
    "usage: hq agent <subcommand> [args]",
    "",
    "subcommands:",
    "  create <id> --role <sales-sdr|account-manager|chief-of-staff> --display-name <name> [--model <m>] [--trust-tier <t>] [--max-concurrency <n>]",
    "  list [--status <s>] [--role <r>]",
    "  show <id>",
    "  pause <id>",
    "  resume <id>",
    "  rerender <id>",
  ].join("\n"),
  task: [
    "usage: hq task <subcommand> [args]",
    "",
    "subcommands:",
    "  create --agent <id> --kind <k> --title <t> [--input <json>] [--priority <n>] [--thread-key <k>] [--conversation-id <id>] [--max-attempts <n>] [--wake-at <iso>]",
    "  list [--agent <id>] [--status <s>] [--limit <n>]",
    "  show <id>",
    "  cancel <id>",
    "  retry <id>",
    "  watch <id>",
  ].join("\n"),
  outbox: [
    "usage: hq outbox <subcommand> [args]",
    "",
    "subcommands:",
    "  list [--agent <id>] [--status <s>]",
    "  edit <id> [--subject <s>] [--body <b>]           (only while pending_approval)",
    "  approve <id> [--note <n>] [--reviewer <name>]    (shadow-tier agents -> held, never sent)",
    "  reject <id> --category <c> [--reason <r>] [--reviewer <name>]   (category: factual_error|tone|too_long|not_personalized|wrong_recipient|bad_timing|compliance|other; reason becomes agent memory)",
    "  retry <id>                                       (failed -> approved)",
  ].join("\n"),
  memory: [
    "usage: hq memory <subcommand> [args]",
    "",
    "subcommands:",
    "  list [--agent <id>] [--subject <s>] [--status <s>]",
    "  accept <id>",
    "  reject <id>",
  ].join("\n"),
  kb: [
    "usage: hq kb <subcommand> [args]",
    "",
    "subcommands:",
    "  sync",
    "  search --query <q> --scopes <company,role:sales-sdr> [--limit <n>]",
  ].join("\n"),
  contact: [
    "usage: hq contact <subcommand> [args]",
    "",
    "subcommands:",
    "  add --email <e> [--name <n>] [--title <t>] [--phone <p>] [--linkedin-url <u>] [--language <l>] [--source <s>] [--company-name <c>] [--company-domain <d>]",
    "  list [--query <q>]",
    "  handoff <id> [--to account-manager] [--summary <text>]   hand a won contact to the default Account Manager",
  ].join("\n"),
  inbound: [
    "usage: hq inbound <subcommand> [args]",
    "",
    "subcommands:",
    "  list [--status <s>] [--classification <c>] [--limit <n>]",
    "  show <id>",
  ].join("\n"),
  settings: [
    "usage: hq settings <subcommand> [args]",
    "",
    "subcommands:",
    "  show",
    '  set <key> <json-value>     (e.g. hq settings set sendRatePerHour 10, hq settings set quietHours \'{"startHour":21,"endHour":8,"timezone":"UTC"}\')',
  ].join("\n"),
  killswitch: [
    "usage: hq killswitch <on|off> [--reason <text>] [--force]",
    "",
    "Turns outbound sending on or off and records a reason.",
    "Turning it on is refused while go-live readiness checks fail (see `hq readiness`);",
    "--force overrides that and is recorded in the audit log.",
  ].join("\n"),
  status: "usage: hq status\n\nShows email provider health, kill switch state, quiet hours, quota throttle, and running task count.",
  quota: "usage: hq quota\n\nShows the most recent agy /usage quota snapshot.",
  serve: "usage: hq serve\n\nRuns the agy-hq daemon in this process (admin API + agent-facing API).",
};

function isHelp(arg: string | undefined): boolean {
  return arg === "--help" || arg === "-h";
}

interface GlobalFlags extends ClientOptions {
  json: boolean;
}

/**
 * Pulls the four global flags (--config/--url/--token/--json) out of argv
 * wherever they appear, leaving everything else — including the command
 * name and every subcommand-specific flag — untouched in `rest`.
 *
 * Deliberately NOT implemented with node:util's parseArgs over the whole
 * argv: with `strict: false` (needed since this pass doesn't know the
 * subcommand's own option names), parseArgs guesses an unrecognized
 * `--role sales-sdr` is a boolean `--role` flag followed by a positional
 * `sales-sdr`, corrupting every subcommand's own args. Each subcommand runs
 * its own strict parseArgs over `rest` instead, where it knows its options.
 */
function splitGlobalFlags(argv: string[]): { global: GlobalFlags; rest: string[] } {
  const rest: string[] = [];
  let configPath: string | undefined;
  let url: string | undefined;
  let token: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--config") configPath = argv[++i];
    else if (arg === "--url") url = argv[++i];
    else if (arg === "--token") token = argv[++i];
    else if (arg === "--json") json = true;
    else rest.push(arg);
  }

  return { global: { configPath, url, token, json }, rest };
}

function client(global: GlobalFlags): HqClient {
  return new HqClient(global);
}

function fail(message: string): never {
  console.error(`hq: ${message}`);
  process.exit(1);
}

function parseJsonArg(raw: string | undefined, flagName: string): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch (err) {
    fail(`--${flagName} must be a JSON object: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// agent

async function cmdAgent(argv: string[], global: GlobalFlags): Promise<void> {
  const [sub, ...rest] = argv;
  const c = client(global);

  switch (sub) {
    case "--help":
    case "-h":
      console.log(HELP.agent);
      return;
    case "create": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          role: { type: "string" },
          "display-name": { type: "string" },
          model: { type: "string" },
          "trust-tier": { type: "string" },
          "max-concurrency": { type: "string" },
        },
      });
      const id = positionals[0];
      if (!id) fail("agent create <id> --role <role> --display-name <name>");
      if (!values.role) fail("--role is required");
      if (!values["display-name"]) fail("--display-name is required");
      const { agent } = await c.post<{ agent: Agent }>("/v1/admin/agents", {
        id,
        role: values.role as AgentRole,
        displayName: values["display-name"],
        model: values.model as string | undefined,
        trustTier: values["trust-tier"] as TrustTier | undefined,
        maxConcurrency: values["max-concurrency"] ? Number(values["max-concurrency"]) : undefined,
      });
      global.json ? printJson(agent) : printKv(agent as unknown as Record<string, unknown>);
      return;
    }
    case "list": {
      const { values } = parseArgs({
        args: rest,
        options: { status: { type: "string" }, role: { type: "string" } },
      });
      const qs = new URLSearchParams();
      if (values.status) qs.set("status", values.status);
      if (values.role) qs.set("role", values.role);
      const { agents } = await c.get<{ agents: Agent[] }>(`/v1/admin/agents?${qs}`);
      if (global.json) return printJson(agents);
      printTable(
        agents.map((a) => ({
          id: a.id,
          role: a.role,
          displayName: a.displayName,
          status: a.status,
          trustTier: a.trustTier,
          model: a.model,
          maxConcurrency: a.maxConcurrency,
        })),
      );
      return;
    }
    case "show": {
      const id = rest[0];
      if (!id) fail("agent show <id>");
      const { agent } = await c.get<{ agent: Agent }>(`/v1/admin/agents/${id}`);
      global.json ? printJson(agent) : printKv(agent as unknown as Record<string, unknown>);
      return;
    }
    case "pause": {
      const id = rest[0];
      if (!id) fail("agent pause <id>");
      const { agent } = await c.patch<{ agent: Agent }>(`/v1/admin/agents/${id}`, { status: "paused" as AgentStatus });
      global.json ? printJson(agent) : console.log(`${id} -> paused`);
      return;
    }
    case "resume": {
      const id = rest[0];
      if (!id) fail("agent resume <id>");
      const { agent } = await c.patch<{ agent: Agent }>(`/v1/admin/agents/${id}`, { status: "active" as AgentStatus });
      global.json ? printJson(agent) : console.log(`${id} -> active`);
      return;
    }
    case "rerender": {
      const id = rest[0];
      if (!id) fail("agent rerender <id>");
      const { agent, files } = await c.post<{ agent: Agent; files: string[] }>(`/v1/admin/agents/${id}/rerender`);
      global.json ? printJson({ agent, files }) : console.log(`rendered ${files?.length ?? 0} files for ${agent.id}`);
      return;
    }
    default:
      fail(`unknown "agent" subcommand: ${sub ?? "(none)"}. Expected create|list|show|pause|resume|rerender.`);
  }
}

// ---------------------------------------------------------------------------
// task

async function cmdTask(argv: string[], global: GlobalFlags): Promise<void> {
  const [sub, ...rest] = argv;
  const c = client(global);

  switch (sub) {
    case "--help":
    case "-h":
      console.log(HELP.task);
      return;
    case "create": {
      const { values } = parseArgs({
        args: rest,
        options: {
          agent: { type: "string" },
          kind: { type: "string" },
          title: { type: "string" },
          input: { type: "string" },
          priority: { type: "string" },
          "thread-key": { type: "string" },
          "conversation-id": { type: "string" },
          "max-attempts": { type: "string" },
          "wake-at": { type: "string" },
        },
      });
      if (!values.agent) fail("--agent is required");
      if (!values.kind) fail("--kind is required");
      if (!values.title) fail("--title is required");
      const { task } = await c.post<{ task: Task }>("/v1/admin/tasks", {
        agentId: values.agent,
        kind: values.kind,
        title: values.title,
        input: parseJsonArg(values.input as string | undefined, "input"),
        priority: values.priority ? Number(values.priority) : undefined,
        threadKey: values["thread-key"] as string | undefined,
        conversationId: values["conversation-id"] as string | undefined,
        maxAttempts: values["max-attempts"] ? Number(values["max-attempts"]) : undefined,
        wakeAt: values["wake-at"] as string | undefined,
      });
      global.json ? printJson(task) : printKv(task as unknown as Record<string, unknown>);
      return;
    }
    case "list": {
      const { values } = parseArgs({
        args: rest,
        options: { agent: { type: "string" }, status: { type: "string" }, limit: { type: "string" } },
      });
      const qs = new URLSearchParams();
      if (values.agent) qs.set("agentId", values.agent);
      if (values.status) qs.set("status", values.status);
      if (values.limit) qs.set("limit", values.limit);
      const { tasks } = await c.get<{ tasks: Task[] }>(`/v1/admin/tasks?${qs}`);
      if (global.json) return printJson(tasks);
      printTable(
        tasks.map((t) => ({
          id: t.id,
          agentId: t.agentId,
          kind: t.kind,
          status: t.status,
          priority: t.priority,
          attempts: `${t.attempts}/${t.maxAttempts}`,
          updatedAt: t.updatedAt,
        })),
      );
      return;
    }
    case "show": {
      const id = rest[0];
      if (!id) fail("task show <id>");
      const { task, audit } = await c.get<{ task: Task; audit: AuditEvent[] }>(`/v1/admin/tasks/${id}`);
      if (global.json) return printJson({ task, audit });
      printKv(task as unknown as Record<string, unknown>);
      console.log("\naudit trail:");
      printTable(audit.map((e) => ({ at: e.at, kind: e.kind, data: e.data })));
      return;
    }
    case "cancel": {
      const id = rest[0];
      if (!id) fail("task cancel <id>");
      const { task } = await c.post<{ task: Task }>(`/v1/admin/tasks/${id}/cancel`);
      global.json ? printJson(task) : console.log(`${id} -> cancelled`);
      return;
    }
    case "retry": {
      const id = rest[0];
      if (!id) fail("task retry <id>");
      const { task } = await c.post<{ task: Task }>(`/v1/admin/tasks/${id}/retry`);
      global.json ? printJson(task) : console.log(`${id} -> queued`);
      return;
    }
    case "watch": {
      const id = rest[0];
      if (!id) fail("task watch <id>");
      await watchTask(c, id, global);
      return;
    }
    default:
      fail(`unknown "task" subcommand: ${sub ?? "(none)"}. Expected create|list|show|cancel|retry|watch.`);
  }
}

async function watchTask(c: HqClient, taskId: string, global: GlobalFlags): Promise<void> {
  const { task } = await c.get<{ task: Task }>(`/v1/admin/tasks/${taskId}`);
  console.log(`[${task.status}] ${task.id} ${task.kind} (agent ${task.agentId})`);
  if ((TERMINAL_TASK_STATUSES as readonly TaskStatus[]).includes(task.status)) return;

  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const res = await c.stream("/v1/admin/events", controller.signal);

  await readSse(
    res,
    (ev) => {
      let parsed: { type: string; data: Record<string, unknown>; at: string };
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (parsed.data?.taskId !== taskId) return;
      if (global.json) {
        printJson(parsed);
      } else {
        console.log(`${parsed.at} ${parsed.type} ${JSON.stringify(parsed.data)}`);
      }
      if (parsed.type === "task.transition" && typeof parsed.data.to === "string") {
        if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(parsed.data.to)) {
          controller.abort();
        }
      }
    },
    controller.signal,
  ).catch(() => {
    // aborted — expected once we see a terminal transition or Ctrl+C.
  });
}

// ---------------------------------------------------------------------------
// outbox / memory

async function cmdOutbox(argv: string[], global: GlobalFlags): Promise<void> {
  const [sub, ...rest] = argv;
  const c = client(global);
  switch (sub) {
    case "--help":
    case "-h":
      console.log(HELP.outbox);
      return;
    case "list": {
      const { values } = parseArgs({ args: rest, options: { agent: { type: "string" }, status: { type: "string" } } });
      const qs = new URLSearchParams();
      if (values.agent) qs.set("agentId", values.agent);
      if (values.status) qs.set("status", values.status);
      const { items } = await c.get<{ items: OutboxItem[] }>(`/v1/admin/outbox?${qs}`);
      if (global.json) return printJson(items);
      printTable(items.map((i) => ({ id: i.id, agentId: i.agentId, to: i.to, subject: i.subject, status: i.status })));
      return;
    }
    case "edit": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { subject: { type: "string" }, body: { type: "string" } },
      });
      const id = positionals[0];
      if (!id) fail("outbox edit <id> [--subject <s>] [--body <b>]");
      if (!values.subject && !values.body) fail("--subject or --body is required");
      const { item } = await c.request<{ item: OutboxItem }>("PATCH", `/v1/admin/outbox/${id}`, {
        subject: values.subject,
        body: values.body,
      });
      global.json ? printJson(item) : printKv(item as unknown as Record<string, unknown>);
      return;
    }
    case "approve": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { note: { type: "string" }, reviewer: { type: "string" } },
      });
      const id = positionals[0];
      if (!id) fail("outbox approve <id> [--note <n>] [--reviewer <name>]");
      const { item } = await c.post<{ item: OutboxItem }>(`/v1/admin/outbox/${id}/approve`, {
        note: values.note,
        reviewer: values.reviewer,
      });
      global.json ? printJson(item) : console.log(`${id} -> ${item.status}`); // "approved", or "held" for a shadow-tier agent
      return;
    }
    case "reject": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { reason: { type: "string" }, reviewer: { type: "string" }, category: { type: "string" } },
      });
      const id = positionals[0];
      if (!id) fail("outbox reject <id> --category <c> [--reason <r>] [--reviewer <name>]");
      if (!values.reason && !values.category) fail("--reason or --category is required");
      const { item } = await c.post<{ item: OutboxItem }>(`/v1/admin/outbox/${id}/reject`, {
        reason: values.reason,
        category: values.category,
        reviewer: values.reviewer,
      });
      global.json ? printJson(item) : console.log(`${id} -> rejected`);
      return;
    }
    case "retry": {
      const id = rest[0];
      if (!id) fail("outbox retry <id>");
      const { item } = await c.post<{ item: OutboxItem }>(`/v1/admin/outbox/${id}/retry`);
      global.json ? printJson(item) : console.log(`${id} -> approved`);
      return;
    }
    default:
      fail(`unknown "outbox" subcommand: ${sub ?? "(none)"}. Expected list|edit|approve|reject|retry.`);
  }
}

async function cmdMemory(argv: string[], global: GlobalFlags): Promise<void> {
  const [sub, ...rest] = argv;
  const c = client(global);
  switch (sub) {
    case "--help":
    case "-h":
      console.log(HELP.memory);
      return;
    case "list": {
      const { values } = parseArgs({
        args: rest,
        options: { agent: { type: "string" }, subject: { type: "string" }, status: { type: "string" } },
      });
      const qs = new URLSearchParams();
      if (values.agent) qs.set("agentId", values.agent);
      if (values.subject) qs.set("subject", values.subject);
      if (values.status) qs.set("status", values.status);
      const { items } = await c.get<{ items: MemoryItem[] }>(`/v1/admin/memory?${qs}`);
      if (global.json) return printJson(items);
      printTable(items.map((m) => ({ id: m.id, agentId: m.agentId, subject: m.subject, content: m.content, status: m.status })));
      return;
    }
    case "accept": {
      const id = rest[0];
      if (!id) fail("memory accept <id>");
      const { item } = await c.post<{ item: MemoryItem }>(`/v1/admin/memory/${id}/accept`);
      global.json ? printJson(item) : console.log(`${id} -> accepted`);
      return;
    }
    case "reject": {
      const id = rest[0];
      if (!id) fail("memory reject <id>");
      const { item } = await c.post<{ item: MemoryItem }>(`/v1/admin/memory/${id}/reject`);
      global.json ? printJson(item) : console.log(`${id} -> rejected`);
      return;
    }
    default:
      fail(`unknown "memory" subcommand: ${sub ?? "(none)"}. Expected list|accept|reject.`);
  }
}

// ---------------------------------------------------------------------------
// kb / contact / quota

async function cmdKb(argv: string[], global: GlobalFlags): Promise<void> {
  const [sub, ...rest] = argv;
  const c = client(global);
  switch (sub) {
    case "--help":
    case "-h":
      console.log(HELP.kb);
      return;
    case "sync": {
      const summary = await c.post<{ scanned: number; changed: number; deleted: number }>("/v1/admin/kb/sync");
      global.json ? printJson(summary) : printKv(summary as unknown as Record<string, unknown>);
      return;
    }
    case "search": {
      const { values } = parseArgs({
        args: rest,
        options: { query: { type: "string" }, scopes: { type: "string" }, limit: { type: "string" } },
      });
      if (!values.query) fail("--query is required");
      if (!values.scopes) fail('--scopes is required (e.g. "company,role:sales-sdr")');
      const qs = new URLSearchParams({ query: values.query, scopes: values.scopes });
      if (values.limit) qs.set("limit", values.limit);
      const { results } = await c.get<{ results: { docId: string; title: string; scope: string; snippet: string; score: number }[] }>(
        `/v1/admin/kb/search?${qs}`,
      );
      if (global.json) return printJson(results);
      printTable(results);
      return;
    }
    default:
      fail(`unknown "kb" subcommand: ${sub ?? "(none)"}. Expected sync|search.`);
  }
}

async function cmdContact(argv: string[], global: GlobalFlags): Promise<void> {
  const [sub, ...rest] = argv;
  const c = client(global);
  switch (sub) {
    case "--help":
    case "-h":
      console.log(HELP.contact);
      return;
    case "add": {
      const { values } = parseArgs({
        args: rest,
        options: {
          email: { type: "string" },
          name: { type: "string" },
          title: { type: "string" },
          phone: { type: "string" },
          "linkedin-url": { type: "string" },
          language: { type: "string" },
          source: { type: "string" },
          "company-name": { type: "string" },
          "company-domain": { type: "string" },
        },
      });
      if (!values.email) fail("--email is required");
      const { contact, created } = await c.post<{ contact: unknown; created: boolean }>("/v1/admin/contacts", {
        email: values.email,
        name: values.name,
        title: values.title,
        phone: values.phone,
        linkedinUrl: values["linkedin-url"],
        language: values.language,
        source: values.source,
        companyName: values["company-name"],
        companyDomain: values["company-domain"],
      });
      global.json ? printJson({ contact, created }) : printKv({ ...(contact as Record<string, unknown>), created });
      return;
    }
    case "list": {
      const { values } = parseArgs({ args: rest, options: { query: { type: "string" } } });
      const qs = new URLSearchParams();
      if (values.query) qs.set("query", values.query);
      const { contacts } = await c.get<{ contacts: { id: string; email: string | null; name: string | null; stage: string }[] }>(
        `/v1/admin/contacts?${qs}`,
      );
      if (global.json) return printJson(contacts);
      printTable(contacts.map((ct) => ({ id: ct.id, email: ct.email, name: ct.name, stage: ct.stage })));
      return;
    }
    case "handoff": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { to: { type: "string" }, summary: { type: "string" } },
      });
      const id = positionals[0];
      if (!id) fail("contact handoff <id> [--to account-manager] [--summary <text>]");
      const body: { toRole: string; summary?: string } = { toRole: values.to ?? "account-manager" };
      if (values.summary) body.summary = values.summary;
      const result = await c.post<{ contact: unknown; task: { id: string }; fromAgentId: string | null; toAgentId: string }>(
        `/v1/admin/contacts/${id}/handoff`,
        body,
      );
      global.json
        ? printJson(result)
        : console.log(`handed off to ${result.toAgentId} (was ${result.fromAgentId ?? "unassigned"}); onboarding task ${result.task.id}`);
      return;
    }
    default:
      fail(`unknown "contact" subcommand: ${sub ?? "(none)"}. Expected add|list|handoff.`);
  }
}

async function cmdQuota(argv: string[], global: GlobalFlags): Promise<void> {
  if (isHelp(argv[0])) {
    console.log(HELP.quota);
    return;
  }
  const c = client(global);
  const data = await c.get<{ at: string; buckets: unknown[] } | null>("/v1/admin/quota");
  if (!data) {
    console.log("no quota snapshot yet (the daemon polls /usage shortly after startup)");
    return;
  }
  global.json ? printJson(data) : printTable(data.buckets as Record<string, unknown>[]);
}

// ---------------------------------------------------------------------------
// inbound

async function cmdInbound(argv: string[], global: GlobalFlags): Promise<void> {
  const [sub, ...rest] = argv;
  const c = client(global);
  switch (sub) {
    case "--help":
    case "-h":
      console.log(HELP.inbound);
      return;
    case "list": {
      const { values } = parseArgs({
        args: rest,
        options: { status: { type: "string" }, classification: { type: "string" }, limit: { type: "string" } },
      });
      const qs = new URLSearchParams();
      if (values.status) qs.set("status", values.status);
      if (values.classification) qs.set("classification", values.classification);
      if (values.limit) qs.set("limit", values.limit);
      const { events } = await c.get<{ events: InboundEvent[] }>(`/v1/admin/inbound?${qs}`);
      if (global.json) return printJson(events);
      printTable(
        events.map((e) => ({
          id: e.id,
          source: e.source,
          from: e.fromAddress,
          classification: e.classification,
          status: e.status,
          receivedAt: e.receivedAt,
        })),
      );
      return;
    }
    case "show": {
      const id = rest[0];
      if (!id) fail("inbound show <id>");
      const { event } = await c.get<{ event: InboundEvent }>(`/v1/admin/inbound/${id}`);
      global.json ? printJson(event) : printKv(event as unknown as Record<string, unknown>);
      return;
    }
    default:
      fail(`unknown "inbound" subcommand: ${sub ?? "(none)"}. Expected list|show.`);
  }
}

// ---------------------------------------------------------------------------
// settings / killswitch / status

async function cmdSettings(argv: string[], global: GlobalFlags): Promise<void> {
  const [sub, ...rest] = argv;
  const c = client(global);
  switch (sub) {
    case "--help":
    case "-h":
      console.log(HELP.settings);
      return;
    case "show": {
      const { settings } = await c.get<{ settings: HqSettings }>("/v1/admin/settings");
      global.json ? printJson(settings) : printKv(settings as unknown as Record<string, unknown>);
      return;
    }
    case "set": {
      const key = rest[0];
      const rawValue = rest[1];
      if (!key || rawValue === undefined) fail("settings set <key> <json-value>");
      let value: unknown;
      try {
        value = JSON.parse(rawValue!);
      } catch (err) {
        fail(`<json-value> must be valid JSON: ${(err as Error).message}`);
      }
      const { settings } = await c.request<{ settings: HqSettings }>("PATCH", "/v1/admin/settings", { [key!]: value });
      global.json ? printJson(settings) : printKv(settings as unknown as Record<string, unknown>);
      return;
    }
    default:
      fail(`unknown "settings" subcommand: ${sub ?? "(none)"}. Expected show|set.`);
  }
}

async function cmdKillswitch(argv: string[], global: GlobalFlags): Promise<void> {
  const [sub, ...rest] = argv;
  if (isHelp(sub)) {
    console.log(HELP.killswitch);
    return;
  }
  if (sub !== "on" && sub !== "off") fail('killswitch <on|off> [--reason "..."] [--force]');
  const { values } = parseArgs({ args: rest, options: { reason: { type: "string" }, force: { type: "boolean" } } });
  const c = client(global);
  const { settings } = await c.post<{ settings: HqSettings }>("/v1/admin/killswitch", {
    outboundEnabled: sub === "on",
    reason: values.reason,
    ...(values.force ? { force: true } : {}),
  });
  global.json
    ? printJson(settings)
    : console.log(`outboundEnabled -> ${settings.outboundEnabled}${settings.outboundDisabledReason ? ` (${settings.outboundDisabledReason})` : ""}`);
}

async function cmdStatus(argv: string[], global: GlobalFlags): Promise<void> {
  if (isHelp(argv[0])) {
    console.log(HELP.status);
    return;
  }
  const c = client(global);
  const { status } = await c.get<{ status: DaemonStatus }>("/v1/admin/status");
  global.json ? printJson(status) : printKv(status as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// serve

async function cmdServe(argv: string[], global: GlobalFlags): Promise<void> {
  if (isHelp(argv[0])) {
    console.log(HELP.serve);
    return;
  }
  const config = loadConfig({ configPath: global.configPath });
  const handle = await startDaemon(config);
  console.log(`agy-hq daemon listening on http://${config.host}:${handle.port}`);
  console.log(`data dir: ${config.dataDir}`);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nreceived ${signal}, shutting down...`);
    handle
      .stop()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error("error during shutdown:", err);
        process.exit(1);
      });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

// ---------------------------------------------------------------------------
// main

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { global, rest } = splitGlobalFlags(argv);
  const [command, ...commandArgs] = rest;

  switch (command) {
    case "serve":
      return await cmdServe(commandArgs, global);
    case "agent":
      return await cmdAgent(commandArgs, global);
    case "task":
      return await cmdTask(commandArgs, global);
    case "outbox":
      return await cmdOutbox(commandArgs, global);
    case "memory":
      return await cmdMemory(commandArgs, global);
    case "kb":
      return await cmdKb(commandArgs, global);
    case "contact":
      return await cmdContact(commandArgs, global);
    case "inbound":
      return await cmdInbound(commandArgs, global);
    case "settings":
      return await cmdSettings(commandArgs, global);
    case "killswitch":
      return await cmdKillswitch(commandArgs, global);
    case "status":
      return await cmdStatus(commandArgs, global);
    case "quota":
      return await cmdQuota(commandArgs, global);
    case "setup":
      return await cmdSetup(commandArgs, global);
    case "readiness":
      return await cmdReadiness(commandArgs, global);
    case "scorecard":
      return await cmdScorecard(commandArgs, global);
    case "promote":
      return await cmdPromote(commandArgs, global);
    case "routine":
      return await cmdRoutine(commandArgs, global);
    case "eval":
      return await cmdEval(commandArgs, global);
    case "kpis":
      return await cmdKpis(commandArgs, global);
    case "briefings":
      return await cmdBriefings(commandArgs, global);
    case "email":
      return await cmdEmail(commandArgs, global);
    case "shadow":
      return await cmdShadow(commandArgs, global);
    case "--help":
    case "-h":
    default:
      console.log(
        [
          "usage: hq <command> [args] [--json] [--config <path>] [--url <url>] [--token <token>]",
          "",
          "Run `hq <command> --help` for a command's subcommands and flags.",
          "",
          "commands:",
          "  serve",
          "  agent       create|list|show|pause|resume|rerender",
          "  task        create|list|show|cancel|retry|watch",
          "  outbox      list|edit|approve|reject|retry",
          "  memory      list|accept|reject",
          "  kb          sync|search",
          "  contact     add|list|handoff",
          "  inbound     list|show",
          "  settings    show|set",
          "  setup       company|email-test   (guided setup)",
          "  readiness   show go-live checklist",
          "  scorecard   per-agent quality scorecards",
          "  promote     <agentId> move an agent to its next trust tier",
          "  routine     list|create|update|delete|run",
          "  eval        run|list|show|suites",
          "  kpis        per-role KPIs over the last N days",
          "  briefings   list|show   (the Chief of Staff's daily digests)",
          "  shadow      start|status|end|list   (the 2-week shadow-run evaluation)",
          "  email       doctor   (read-only mailbox preflight; run before a shadow run)",
          "  killswitch  on|off",
          "  status",
          "  quota",
        ].join("\n"),
      );
      process.exit(command && command !== "--help" && command !== "-h" ? 1 : 0);
  }
}

main().catch((err) => {
  if (err instanceof HqApiError) {
    console.error(`hq: ${err.code}: ${err.message}`);
  } else {
    console.error("hq: unexpected error:", err);
  }
  process.exit(1);
});
