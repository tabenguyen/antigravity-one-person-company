// outbox_draft_email never puts two drafts for the same email in the approval queue:
//   same task + recipient  -> rewrite in place (pending) / `conflict` (already reviewed)
//   same thread, other task -> supersede when the contact wrote since, `conflict` otherwise
// and none of it may distort scorecards, shadow-run stats, KPIs or stats.
import { describe, expect, it } from "vitest";
import { isReplacedDraft, mcpRoute } from "@agyhq/core";
import type { OutboxItem } from "@agyhq/core";
import { computeStats } from "../../src/stats.ts";
import { computeKpis } from "../../src/kpis.ts";
import { computeScorecard } from "../../src/quality/scorecard.ts";
import { computeShadowStatus } from "../../src/shadow.ts";
import { setupTestApi, type TestApi } from "./test-helpers.ts";

const NO_CTA = "Thanks for your time yesterday."; // lint: no_cta (warn)
const WITH_CTA = "Thanks for your time yesterday. Would Thursday work for a quick chat?";

interface Res {
  status: number;
  ok: boolean;
  data?: { item: OutboxItem; outcome: "created" | "updated"; message: string };
  error?: { code: string; message: string };
}

async function draft(t: TestApi, body: Record<string, unknown>, opts: { taskId?: string; token?: string } = {}): Promise<Res> {
  const taskId = opts.taskId ?? t.taskId;
  const res = await t.app.request(mcpRoute("outbox_draft_email"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.token ?? t.token}`,
      "x-agyhq-agent-id": t.agentId,
      "x-agyhq-task-id": taskId,
      "content-type": "application/json",
    },
    body: JSON.stringify({ to: "jane@acme.com", subject: "Quick question", body: WITH_CTA, reason: "first touch", ...body }),
  });
  const json = (await res.json()) as { ok: boolean; data?: Res["data"]; error?: Res["error"] };
  return { status: res.status, ...json };
}

/** A second task for the same agent, with its own run token. */
function otherTask(t: TestApi, threadKey: string | null = null, kind = "sdr.follow_up") {
  const task = t.db.tasks.create({ agentId: t.agentId, kind, title: "other", threadKey });
  return { taskId: task.id, token: t.tokens.issue(t.agentId, task.id) };
}

const rows = (t: TestApi) => t.db.outbox.list({ agentId: t.agentId });
const pending = (t: TestApi) => t.db.outbox.list({ agentId: t.agentId, status: ["pending_approval"] });

describe("same task, same recipient", () => {
  it("rewrites the pending draft in place: one queue item, same id, revisions + 1, outbox.revised audit", async () => {
    const t = setupTestApi();
    const first = await draft(t, { body: NO_CTA });
    expect(first.data?.outcome).toBe("created");
    const second = await draft(t, { subject: "Quick question v2", body: WITH_CTA, reason: "better ask" });

    expect(second.status).toBe(200);
    expect(second.data?.outcome).toBe("updated");
    expect(second.data?.item.id).toBe(first.data?.item.id);
    expect(second.data?.item).toMatchObject({ status: "pending_approval", subject: "Quick question v2", body: WITH_CTA, reason: "better ask", revisions: 1 });
    expect(second.data?.message).toMatch(/UPDATED in place/);
    expect(second.data?.message).toMatch(/not duplicated/);

    expect(rows(t)).toHaveLength(1);
    const stored = rows(t)[0]!;
    expect(stored).toMatchObject({ subject: "Quick question v2", body: WITH_CTA, revisions: 1, editedByHuman: false });
    // the agent's latest text is the baseline for the human edit ratio
    expect(stored.originalBody).toBe(WITH_CTA);
    expect(stored.originalSubject).toBe("Quick question v2");

    expect(t.db.audit.list({ agentId: t.agentId, kind: ["outbox.drafted"] })).toHaveLength(1);
    const revised = t.db.audit.list({ agentId: t.agentId, kind: ["outbox.revised"] });
    expect(revised).toHaveLength(1);
    expect(revised[0]?.data).toMatchObject({ id: first.data?.item.id, revisions: 1 });

    const third = await draft(t, { body: `${WITH_CTA} Cheers.` });
    expect(third.data?.item.revisions).toBe(2);
    expect(rows(t)).toHaveLength(1);
  });

  it("re-runs lint on the new content (warning gone after the rewrite)", async () => {
    const t = setupTestApi();
    const first = await draft(t, { body: NO_CTA });
    expect(first.data?.item.lint.map((f) => f.code)).toContain("no_cta");
    const second = await draft(t, { body: WITH_CTA });
    expect(second.data?.item.lint.map((f) => f.code)).not.toContain("no_cta");
    expect(rows(t)[0]!.lint.map((f) => f.code)).not.toContain("no_cta");
  });

  it("a rewrite that fails lint with an error is refused and leaves the queued draft untouched", async () => {
    const t = setupTestApi();
    const first = await draft(t, { body: WITH_CTA });
    const bad = await draft(t, { body: "Hi {{firstName}}, would Thursday work?" });
    expect(bad.status).toBe(400);
    expect(bad.error?.message).toMatch(/Draft NOT created or changed/);
    const stored = t.db.outbox.get(first.data!.item.id)!;
    expect(stored).toMatchObject({ body: WITH_CTA, revisions: 0, status: "pending_approval" });
    expect(rows(t)).toHaveLength(1);
  });

  it.each(["approved", "held", "rejected", "blocked"] as const)("refuses with conflict once the earlier draft is %s", async (status) => {
    const t = setupTestApi();
    const first = await draft(t, {});
    t.db.outbox.decide(first.data!.item.id, status, status === "blocked" ? { statusReason: "recipient has opted out" } : { decidedBy: "human:ops" });
    const again = await draft(t, { body: `${WITH_CTA} Again.` });
    expect(again.status).toBe(409);
    expect(again.error?.code).toBe("conflict");
    expect(again.error?.message).toMatch(/Draft NOT created/);
    expect(again.error?.message).toMatch(/already reviewed/);
    expect(again.error?.message).toContain(first.data!.item.id);
    expect(again.error?.message).toMatch(/do not draft it again/);
    expect(rows(t)).toHaveLength(1);
    expect(rows(t)[0]!.status).toBe(status);
    expect(t.db.audit.list({ agentId: t.agentId, kind: ["outbox.draft_refused"] })).toHaveLength(1);
    // a refusal is not a lint failure: lint stats must not move
    expect(t.db.audit.list({ agentId: t.agentId, kind: ["outbox.lint_blocked"] })).toHaveLength(0);
  });

  it("refuses with conflict once the earlier draft was sent", async () => {
    const t = setupTestApi();
    const first = await draft(t, {});
    t.db.outbox.decide(first.data!.item.id, "approved", { decidedBy: "human:ops" });
    t.db.outbox.claimNextToSend();
    t.db.outbox.decide(first.data!.item.id, "sent", { sentAt: new Date().toISOString() });
    const again = await draft(t, {});
    expect(again.status).toBe(409);
    expect(again.error?.message).toMatch(/approved and sent/);
    expect(rows(t)).toHaveLength(1);
  });

  it("refuses once a human started editing the pending draft (their edit is not overwritten)", async () => {
    const t = setupTestApi();
    const first = await draft(t, {});
    t.db.outbox.edit(first.data!.item.id, { body: "human wording" });
    const again = await draft(t, { body: WITH_CTA });
    expect(again.status).toBe(409);
    expect(again.error?.message).toMatch(/human reviewer is already editing/);
    expect(t.db.outbox.get(first.data!.item.id)!.body).toBe("human wording");
  });

  it("different recipients in one task are independent drafts (key is task + recipient)", async () => {
    const t = setupTestApi();
    const a = await draft(t, { to: "a@acme.com" });
    const b = await draft(t, { to: "b@acme.com" });
    expect(a.data?.outcome).toBe("created");
    expect(b.data?.outcome).toBe("created");
    expect(rows(t)).toHaveLength(2);
    // recipient match is case-insensitive
    const a2 = await draft(t, { to: "A@Acme.com", body: `${WITH_CTA} v2` });
    expect(a2.data?.outcome).toBe("updated");
    expect(a2.data?.item.id).toBe(a.data?.item.id);
    expect(rows(t)).toHaveLength(2);
  });

  it("a rewrite does not use up the daily outbox limit", async () => {
    const t = setupTestApi({ outboxDailyLimit: 1 });
    await draft(t, {});
    const again = await draft(t, { body: `${WITH_CTA} v2` });
    expect(again.data?.item.status).toBe("pending_approval");
    expect(again.data?.outcome).toBe("updated");
  });

  it("a rewrite for a recipient that has opted out in the meantime ends up blocked", async () => {
    const t = setupTestApi();
    await draft(t, {});
    t.db.crm.upsertContact({ email: "jane@acme.com", attributes: { optOut: true } });
    const again = await draft(t, { body: `${WITH_CTA} v2` });
    expect(again.data?.outcome).toBe("updated");
    expect(again.data?.item.status).toBe("blocked");
    expect(again.data?.message).toMatch(/BLOCKED by policy/);
  });
});

describe("tool result text", () => {
  it("a stored draft with warnings says: saved and queued, warnings are for the reviewer, do not draft again", async () => {
    const t = setupTestApi();
    const res = await draft(t, { body: NO_CTA });
    expect(res.data?.item.lint.some((f) => f.severity === "warn")).toBe(true);
    const m = res.data!.message;
    expect(m).toMatch(/saved/);
    expect(m).toMatch(/queued for the human reviewer/);
    expect(m).toMatch(/Warnings are notes for the reviewer/);
    expect(m).toMatch(/do NOT call outbox_draft_email again/);
    expect(m).toContain("no_cta");
  });

  it("a clean draft also says not to draft again", async () => {
    const t = setupTestApi();
    const res = await draft(t, {});
    expect(res.data?.message).toMatch(/Do not call outbox_draft_email again/);
    expect(res.data?.message).not.toMatch(/Warnings are notes/);
  });

  it("a lint error still refuses and creates nothing", async () => {
    const t = setupTestApi();
    const res = await draft(t, { body: "Hi {{firstName}}, would Thursday work?" });
    expect(res.status).toBe(400);
    expect(res.error?.message).toMatch(/Draft NOT created/);
    expect(rows(t)).toHaveLength(0);
  });
});

describe("same thread, different task", () => {
  const KEY = "contact:jane@acme.com";

  it("refuses to stack a new draft on a pending one when the contact has not written since (e.g. a follow-up)", async () => {
    const t = setupTestApi();
    const first = await draft(t, { threadKey: KEY });
    const follow = otherTask(t, KEY);
    const second = await draft(t, { subject: "Following up", body: WITH_CTA }, follow);
    expect(second.status).toBe(409);
    expect(second.error?.code).toBe("conflict");
    expect(second.error?.message).toContain(first.data!.item.id);
    expect(second.error?.message).toMatch(/still waiting for the human reviewer/);
    expect(rows(t)).toHaveLength(1);
    expect(rows(t)[0]!.status).toBe("pending_approval");
    expect(t.db.audit.list({ agentId: t.agentId, kind: ["outbox.draft_refused"] })).toHaveLength(1);
  });

  it("an omitted threadKey defaults to the contact thread, so a no-thread draft is also not stacked", async () => {
    const t = setupTestApi();
    await draft(t, {}); // task thread null -> contact:jane@acme.com
    const second = await draft(t, {}, otherTask(t, KEY));
    expect(second.status).toBe(409);
  });

  it("supersedes the older pending draft when the contact wrote after it was queued", async () => {
    const t = setupTestApi();
    const first = await draft(t, { threadKey: KEY });
    // the contact answers after the draft was queued
    t.db.inbound.insertIfNew({ source: "email", externalId: "m1", fromAddress: "jane@acme.com", subject: "Quick question", bodyText: "Tell me more?", threadKey: KEY, classification: "reply" });
    t.db.sqlite.prepare("UPDATE outbox SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), first.data!.item.id);

    const reply = otherTask(t, KEY, "sdr.handle_reply");
    const second = await draft(t, { subject: "Re: Quick question", body: WITH_CTA }, reply);
    expect(second.status).toBe(200);
    expect(second.data?.outcome).toBe("created");
    expect(second.data?.message).toMatch(/closed as superseded/);
    expect(second.data?.message).toContain(first.data!.item.id);

    const old = t.db.outbox.get(first.data!.item.id)!;
    expect(old.status).toBe("rejected");
    expect(old.decidedBy).toBe("policy:superseded");
    expect(old.rejectionCategory).toBeNull();
    expect(old.statusReason).toMatch(/^superseded: replaced by a newer draft/);
    expect(old.statusReason).toContain(second.data!.item.id);
    expect(isReplacedDraft(old)).toBe(true);

    expect(pending(t).map((i) => i.id)).toEqual([second.data!.item.id]); // one live item in the queue
    const audit = t.db.audit.list({ agentId: t.agentId, kind: ["outbox.superseded"] });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.data).toMatchObject({ id: first.data!.item.id, by: "newer_draft", replacedBy: second.data!.item.id });
    // no agent memory is written (that is what a human reject does)
    expect(t.db.memory.list(t.agentId, {})).toHaveLength(0);
  });

  it("does not supersede (refuses) when a human is already editing the older draft, even if the contact wrote since", async () => {
    const t = setupTestApi();
    const first = await draft(t, { threadKey: KEY });
    t.db.outbox.edit(first.data!.item.id, { body: "human wording" });
    t.db.inbound.insertIfNew({ source: "email", externalId: "m1", fromAddress: "jane@acme.com", subject: "s", bodyText: "x", threadKey: KEY, classification: "reply" });
    t.db.sqlite.prepare("UPDATE outbox SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), first.data!.item.id);
    const second = await draft(t, { subject: "Re: s" }, otherTask(t, KEY, "sdr.handle_reply"));
    expect(second.status).toBe(409);
    expect(second.error?.message).toMatch(/a human is already editing it/);
    expect(t.db.outbox.get(first.data!.item.id)!.status).toBe("pending_approval");
  });

  it("auto-replies and bounces do not make an older draft stale", async () => {
    const t = setupTestApi();
    const first = await draft(t, { threadKey: KEY });
    t.db.inbound.insertIfNew({ source: "email", externalId: "ooo", fromAddress: "jane@acme.com", subject: "Out of office", bodyText: "away", threadKey: KEY, classification: "auto_reply" });
    t.db.sqlite.prepare("UPDATE outbox SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), first.data!.item.id);
    expect((await draft(t, {}, otherTask(t, KEY))).status).toBe(409);
  });

  it("a different thread to the same recipient, or the same thread of another agent, is not touched", async () => {
    const t = setupTestApi();
    await draft(t, { threadKey: "thread:a" });
    const sameRecipientOtherThread = await draft(t, { threadKey: "thread:b" }, otherTask(t, "thread:b"));
    expect(sameRecipientOtherThread.data?.outcome).toBe("created");
    expect(pending(t)).toHaveLength(2);

    // another agent's pending draft to the same recipient/thread is never superseded by this agent
    t.db.agents.create({ id: "am-01", role: "account-manager", displayName: "AM", model: "m", workspacePath: "/tmp/am", policy: { builtins: [], mcp: [] } });
    t.db.outbox.createDraft({ agentId: "am-01", taskId: null, channel: "email", to: "jane@acme.com", subject: "x", body: "y", reason: "r", threadKey: "thread:a" });
    const mine = await draft(t, { to: "other@acme.com", threadKey: "thread:a" }, otherTask(t, "thread:a"));
    expect(mine.data?.outcome).toBe("created");
    expect(t.db.outbox.list({ agentId: "am-01", status: ["pending_approval"] })).toHaveLength(1);
  });

  it("a blocked new draft (daily limit) does not supersede the older pending one", async () => {
    const t = setupTestApi({ outboxDailyLimit: 1 });
    const first = await draft(t, { threadKey: KEY });
    t.db.inbound.insertIfNew({ source: "email", externalId: "m1", fromAddress: "jane@acme.com", subject: "s", bodyText: "x", threadKey: KEY, classification: "reply" });
    t.db.sqlite.prepare("UPDATE outbox SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), first.data!.item.id);
    const second = await draft(t, { subject: "Re: s" }, otherTask(t, KEY, "sdr.handle_reply"));
    expect(second.data?.item.status).toBe("blocked");
    expect(t.db.outbox.get(first.data!.item.id)!.status).toBe("pending_approval");
  });

  it("a superseded draft's own task cannot draft again (already handled)", async () => {
    const t = setupTestApi();
    const first = await draft(t, { threadKey: KEY });
    t.db.inbound.insertIfNew({ source: "email", externalId: "m1", fromAddress: "jane@acme.com", subject: "s", bodyText: "x", threadKey: KEY, classification: "reply" });
    t.db.sqlite.prepare("UPDATE outbox SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), first.data!.item.id);
    await draft(t, { subject: "Re: s" }, otherTask(t, KEY, "sdr.handle_reply"));
    const retry = await draft(t, { threadKey: KEY });
    expect(retry.status).toBe(409);
    expect(retry.error?.message).toMatch(/superseded/);
  });
});

describe("scorecards, shadow stats, KPIs and stats stay honest", () => {
  it("rewrites and superseded drafts are counted once / not at all", async () => {
    const t = setupTestApi();
    const KEY = "contact:jane@acme.com";
    t.db.agents.update(t.agentId, { trustTier: "shadow" });
    const run = t.db.shadowRuns.create({ plannedDays: 14, agentIds: [t.agentId], startedAt: new Date(Date.now() - 3_600_000).toISOString(), notes: null });

    // Task A: draft, rewrite twice -> ONE draft; a human approves it (held in shadow).
    const a1 = await draft(t, { to: "ann@acme.com", body: NO_CTA });
    await draft(t, { to: "ann@acme.com", body: WITH_CTA });
    await draft(t, { to: "ann@acme.com", body: `${WITH_CTA} Thanks!` });
    t.db.outbox.decide(a1.data!.item.id, "held", { decidedBy: "human:ops", decidedAt: new Date().toISOString() });

    // Jane: a draft that gets superseded by the next one, which a human rejects.
    const j1 = await draft(t, { threadKey: KEY }, otherTask(t, KEY, "sdr.first_touch"));
    t.db.inbound.insertIfNew({ source: "email", externalId: "m1", fromAddress: "jane@acme.com", subject: "s", bodyText: "x", threadKey: KEY, classification: "reply" });
    t.db.sqlite.prepare("UPDATE outbox SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), j1.data!.item.id);
    const j2 = await draft(t, { subject: "Re: s", threadKey: KEY }, otherTask(t, KEY, "sdr.handle_reply"));
    t.db.outbox.decide(j2.data!.item.id, "rejected", { decidedBy: "human:ops", decidedAt: new Date().toISOString(), rejectionCategory: "tone" });

    expect(rows(t)).toHaveLength(3); // ann (1 row, 2 revisions), jane old (replaced), jane new
    expect(t.db.outbox.get(j1.data!.item.id)!.status).toBe("rejected");

    const agent = t.db.agents.get(t.agentId)!;
    const sc = computeScorecard(t.db, agent, 7);
    expect(sc.drafts).toBe(2); // not 5 attempts, not 3 rows
    expect(sc.approved).toBe(1);
    expect(sc.rejected).toBe(1); // the human rejection only, not the superseded draft
    expect(sc.decided).toBe(2);
    expect(sc.approvalRate).toBe(0.5);
    expect(sc.rejectionsByCategory).toEqual({ tone: 1 });
    expect(sc.medianEditRatio).toBe(0); // baseline moved with the agent's rewrites, nothing a human changed
    expect(sc.lintErrorRate).toBe(0);

    const shadow = computeShadowStatus(t.db, run).agents[0]!;
    expect(shadow.drafts).toBe(2);
    expect(shadow.decided).toBe(2);
    expect(shadow.approvedUnchanged).toBe(1);
    expect(shadow.approvedEdited).toBe(0);
    expect(shadow.rejected).toBe(1);
    expect(shadow.pending).toBe(0);
    expect(shadow.daily.reduce((n, d) => n + d.drafts, 0)).toBe(2);

    const kpis = computeKpis(t.db, 7);
    expect(kpis.roles["sales-sdr"].firstTouchDrafted).toBe(0); // the only first_touch draft was superseded

    const stats = computeStats(t.db, 7).agents.find((s) => s.agentId === t.agentId)!;
    expect(stats.outboxByStatus).toEqual({ held: 1, rejected: 1 });
    expect(stats.approvalRate).toBe(0.5);
  });
});
