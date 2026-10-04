// Shared fixtures for the Fanpage Manager tests: an in-memory db with a fanpage agent, a FakeFacebookProvider, and a thin
// wrapper over the agent-api so tests can call fb_draft_post / fb_draft_reply / fb_propose_hide like the company MCP does.

import { openDb, type Db } from "@agyhq/db";
import { FakeFacebookProvider } from "@agyhq/channels";
import { mcpRoute } from "@agyhq/core";
import type { FbDraftOutput, McpToolName, ToolPolicy, TrustTier } from "@agyhq/core";
import type { Hono } from "hono";
import { createAgentApi, RunTokenRegistry } from "../src/agent-api/index.ts";
import type { AgentApiDeps } from "../src/agent-api/index.ts";
import { EventBus } from "../src/event-bus.ts";
import { FacebookSender } from "../src/facebook/sender.ts";
import { FacebookPoller } from "../src/facebook/poller.ts";
import { storeFetched } from "../src/facebook/intake.ts";
import { makeTestConfig } from "./helpers.ts";

export const NOW = new Date("2026-10-04T12:00:00.000Z");
export const PAGE_ID = "page-1";

export const FANPAGE_POLICY: ToolPolicy = {
  builtins: ["view_file", "list_dir"],
  mcp: ["kb_search", "memory_list", "memory_propose", "task_create", "fb_draft_post", "fb_draft_reply", "fb_propose_hide"].map((tool) => ({ server: "company", tool })),
};

export interface FanpageEnv {
  db: Db;
  bus: EventBus;
  tokens: RunTokenRegistry;
  app: Hono;
  provider: FakeFacebookProvider;
  agentId: string;
  /** Clock the fake provider, sender and poller share (mutable via `clock.now`). */
  clock: { now: Date };
  /** A fresh task of `kind` for the fanpage agent, with its own run token. */
  newTask(kind?: string, input?: Record<string, unknown>): { taskId: string; token: string };
  /** Call a Facebook tool as `task` (default: a new reply_comment task). */
  call(tool: Extract<McpToolName, `fb_${string}`>, body: Record<string, unknown>, task?: { taskId: string; token: string }): Promise<{ status: number; ok: boolean; data?: FbDraftOutput; error?: { code: string; message: string } }>;
  /** Stage a post + comment on the fake Page and ingest them, as the poller would. Returns the stored comment id. */
  ingestComment(opts?: { id?: string; message?: string; from?: { id: string; name: string | null } | null; parentId?: string | null }): string;
  sender(): FacebookSender;
  poller(): FacebookPoller;
}

export function setupFanpage(opts: { trustTier?: TrustTier; api?: Partial<Omit<AgentApiDeps, "db" | "tokens">> } = {}): FanpageEnv {
  const db = openDb(":memory:");
  const bus = new EventBus();
  const tokens = new RunTokenRegistry();
  const clock = { now: new Date(NOW) };
  const provider = new FakeFacebookProvider({ pageId: PAGE_ID, now: () => clock.now });
  const app = createAgentApi({ db, tokens, now: () => clock.now, facebookPageId: () => PAGE_ID, ...opts.api });
  const agentId = "fp-01";
  db.agents.create({ id: agentId, role: "fanpage-manager", displayName: "Fan", model: "m", workspacePath: "/tmp/fp-01", policy: FANPAGE_POLICY, trustTier: opts.trustTier ?? "assisted" });
  db.settings.patch({ defaultFanpageAgentId: agentId, outboundEnabled: true, quietHours: null, sendRatePerHour: 100 });
  const config = makeTestConfig({ facebook: { kind: "fake", pageId: PAGE_ID, pollIntervalMs: 120_000, scheduleLeadHours: 24, lookbackDays: 14 } });

  const env: FanpageEnv = {
    db,
    bus,
    tokens,
    app,
    provider,
    agentId,
    clock,
    newTask(kind = "fanpage.reply_comment", input = {}) {
      const task = db.tasks.create({ agentId, kind, title: `t-${kind}`, input });
      return { taskId: task.id, token: tokens.issue(agentId, task.id) };
    },
    async call(tool, body, task = env.newTask()) {
      const res = await app.request(mcpRoute(tool), {
        method: "POST",
        headers: { authorization: `Bearer ${task.token}`, "x-agyhq-agent-id": agentId, "x-agyhq-task-id": task.taskId, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { ok: boolean; data?: FbDraftOutput; error?: { code: string; message: string } };
      return { status: res.status, ...json };
    },
    ingestComment(o = {}) {
      const post = provider.addPost({ id: "post-1", message: "StockSync 2.4 vừa phát hành", createdTime: "2026-10-03T08:00:00.000Z" });
      const id = o.id ?? `c-${db.facebook.listComments().length + 1}`;
      const comment = provider.addComment({ postId: post.id, id, message: o.message ?? "Có hỗ trợ Shopee không ad?", parentId: o.parentId ?? null, from: o.from, createdTime: clock.now.toISOString() });
      storeFetched({ db, pageId: PAGE_ID }, { posts: [post], comments: [comment], cursor: null });
      return id;
    },
    sender() {
      return new FacebookSender({ config, db, bus, provider, now: () => clock.now });
    },
    poller() {
      return new FacebookPoller({ db, bus, config }, () => provider);
    },
  };
  return env;
}

/** Put the KB text the lint grounds facts and prices in (company scope). */
export function addKb(db: Db, body: string, title = "kb"): void {
  db.kb.upsertDocument({ scope: "company", title, sourcePath: `${title}.md`, body });
}
