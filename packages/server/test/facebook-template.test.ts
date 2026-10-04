// The shipped templates/fanpage-manager: it loads, its tools exist, every prompt placeholder is filled by whatever creates
// the task, the workspace renders, and the eval suite parses.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { McpTools } from "@agyhq/core";
import { loadTemplate } from "@agyhq/workspace";
import { createAgent } from "../src/provision.ts";
import { loadSuite } from "../src/evals/suite.ts";
import { assignComments } from "../src/facebook/intake.ts";
import { runRoutine } from "../src/routines/run.ts";
import { makeTestConfig, openTestDb, REPO_ROOT } from "./helpers.ts";

const TEMPLATES = path.join(REPO_ROOT, "templates");
const tpl = loadTemplate(TEMPLATES, "fanpage-manager");

const placeholders = (text: string): string[] => [...new Set([...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]!))];
const promptOf = (kind: string): string => {
  const spec = tpl.taskKinds.find((k) => k.kind === kind)!;
  return fs.readFileSync(path.join(tpl.templateDir, spec.prompt), "utf8");
};

describe("templates/fanpage-manager", () => {
  it("defines the three task kinds, no email routing (it never owns contacts), and only tools that exist", () => {
    expect(tpl.taskKinds.map((k) => k.kind)).toEqual(["fanpage.draft_post", "fanpage.reply_comment", "fanpage.content_calendar"]);
    expect(tpl.routing).toBeNull();
    const tools = tpl.policy.mcp.map((m) => m.tool);
    for (const t of tools) expect(Object.keys(McpTools)).toContain(t);
    expect(tools).toEqual(expect.arrayContaining(["kb_search", "fb_draft_post", "fb_draft_reply", "fb_propose_hide", "task_create"]));
  });

  it("cannot send email, read the web, or touch contacts: comments are untrusted, and Facebook has no addresses", () => {
    const tools = tpl.policy.mcp.map((m) => m.tool);
    expect(tools).not.toContain("outbox_draft_email");
    expect(tools.some((t) => t.startsWith("crm_"))).toBe(false);
    expect(tpl.policy.builtins).not.toContain("read_url_content");
    expect(tpl.policy.builtins).not.toContain("search_web");
  });

  it("reply_comment's prompt placeholders are all filled by the comment intake", () => {
    const db = openTestDb();
    db.agents.create({ id: "fp-01", role: "fanpage-manager", displayName: "F", model: "m", workspacePath: "/tmp/f", policy: { builtins: [], mcp: [] } });
    db.facebook.insertCommentIfNew({ id: "c1", postId: "p1", parentId: null, message: "Xin chào", authorId: null, authorName: null, createdTime: "2026-10-04T10:00:00.000Z", status: "new" });
    const { taskIds } = assignComments(db, db.agents.get("fp-01")!, 5);
    const input = db.tasks.get(taskIds[0]!)!.input;
    const missing = placeholders(promptOf("fanpage.reply_comment")).filter((p) => !(p in input));
    expect(missing).toEqual([]);
    // an author-less comment still renders every field as text (no null / undefined in the prompt)
    expect(input["commenterName"]).toBe("(name not available)");
  });

  it("content_calendar's prompt placeholders are all filled by the routine", () => {
    const db = openTestDb();
    db.agents.create({ id: "fp-01", role: "fanpage-manager", displayName: "F", model: "m", workspacePath: "/tmp/f", policy: { builtins: [], mcp: [] } });
    const routine = db.routines.create({ agentId: "fp-01", kind: "content_calendar", name: "Lịch tuần", schedule: "0 8 * * 1", timezone: "Asia/Ho_Chi_Minh", config: {}, nextRunAt: null });
    const out = runRoutine({ db, now: () => new Date("2026-10-05T01:00:00.000Z") }, routine, { manual: true });
    const input = db.tasks.get(out.taskIds[0]!)!.input;
    expect(placeholders(promptOf("fanpage.content_calendar")).filter((p) => !(p in input))).toEqual([]);
  });

  it("draft_post's prompt placeholders are the documented inputs (missing ones render as 'not provided')", () => {
    expect(placeholders(promptOf("fanpage.draft_post")).sort()).toEqual(["notes", "postType", "publishAt", "sourceExcerpt", "sourceTitle", "sourceUrl", "topic"]);
  });

  it("renders a workspace with the persona, the rules and the skills", () => {
    const config = makeTestConfig();
    const db = openTestDb();
    const agent = createAgent({ config, db }, { id: "fp-01", role: "fanpage-manager", displayName: "Mai" });
    expect(agent.policy.mcp.map((m) => m.tool)).toContain("fb_draft_post");
    const ws = agent.workspacePath;
    expect(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8")).toContain("Fanpage Manager");
    expect(fs.existsSync(path.join(ws, ".agents/agents/fanpage-manager.md"))).toBe(true);
    for (const rule of ["no-invented-facts", "comment-handling", "publishing-and-approval", "voice-and-tone", "compliance"]) {
      expect(fs.existsSync(path.join(ws, ".agents/rules", `${rule}.md`)), rule).toBe(true);
    }
    for (const skill of ["write-post", "reply-to-comment", "moderate-spam", "hand-off", "plan-content-calendar"]) {
      expect(fs.existsSync(path.join(ws, ".agents/skills", skill, "SKILL.md")), skill).toBe(true);
    }
    expect(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8")).not.toMatch(/\{\{/);
    db.close();
  });

  it("ships an eval suite with the cases the role is judged on", () => {
    const suite = loadSuite(TEMPLATES, "fanpage-manager");
    expect(suite.cases.length).toBeGreaterThanOrEqual(8);
    const ids = suite.cases.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "news-post-cites-source",
        "release-without-kb-facts",
        "comment-price-question-uses-price-tool",
        "comment-spam-hide-proposal-no-reply",
        "comment-complaint-escalates",
        "comment-duplicate-one-task-one-draft",
        "comment-prompt-injection-is-data",
      ]),
    );
    // Facebook cases stage their data in the fake Page; every other case supplies its own input
    for (const c of suite.cases) expect(Boolean(c.facebook) || Object.keys(c.input).length > 0, c.id).toBe(true);
    expect(suite.kbFiles.map((f) => path.basename(f)).sort()).toEqual(["comment-policy.md", "company-overview.md", "pricing-policy.md", "product-facts.md"]);
  });

  it("the role KB templates carry TODO markers (so readiness refuses them until the owner fills them in)", () => {
    for (const f of fs.readdirSync(path.join(tpl.templateDir, "kb"))) {
      expect(fs.readFileSync(path.join(tpl.templateDir, "kb", f), "utf8"), f).toMatch(/TODO/);
    }
  });
});
