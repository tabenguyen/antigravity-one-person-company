// The two Fanpage routines: content_calendar (plan the week as draft_post tasks) and comment_poll (assign stored comments).
import { describe, expect, it } from "vitest";
import type { Routine, RoutineKind } from "@agyhq/core";
import { createAdminApi } from "../src/admin-api.ts";
import { EventBus } from "../src/event-bus.ts";
import { CommentPollConfigZ, ContentCalendarConfigZ, parseRoutineConfig } from "../src/routines/config.ts";
import { runRoutine } from "../src/routines/run.ts";
import { addAgent, makePhase4Env } from "./phase4-helpers.ts";

const NOW = new Date("2026-10-05T01:00:00.000Z"); // Monday 08:00 in Vietnam

function setup() {
  const env = makePhase4Env();
  addAgent(env.db, "fp-01", "fanpage-manager");
  addAgent(env.db, "sdr-01", "sales-sdr");
  const routine = (agentId: string, kind: RoutineKind, config: Record<string, unknown> = {}): Routine =>
    env.db.routines.create({ agentId, kind, name: `${kind} r`, schedule: "0 8 * * 1", timezone: "Asia/Ho_Chi_Minh", config, nextRunAt: NOW.toISOString() });
  const comment = (id: string, createdTime = "2026-10-04T10:00:00.000Z") =>
    env.db.facebook.insertCommentIfNew({ id, postId: "p1", parentId: null, message: `câu hỏi ${id}`, authorId: "u", authorName: "An", createdTime, status: "new" });
  return { ...env, routine, comment };
}

describe("routine config schemas", () => {
  it("content_calendar defaults, bounds and the post types a calendar may plan (never news)", () => {
    expect(ContentCalendarConfigZ.parse({})).toEqual({ postsPerWeek: 3, postTypes: ["feature", "tip", "release"], daysAhead: 7 });
    expect(parseRoutineConfig("content_calendar", { postsPerWeek: 14, daysAhead: 30 })).toMatchObject({ postsPerWeek: 14, daysAhead: 30 });
    expect(() => parseRoutineConfig("content_calendar", { postsPerWeek: 0 })).toThrow(/postsPerWeek/);
    expect(() => parseRoutineConfig("content_calendar", { postTypes: ["news"] })).toThrow(/postTypes/);
    expect(() => parseRoutineConfig("content_calendar", { postTypes: [] })).toThrow(/postTypes/);
  });

  it("comment_poll defaults and bounds", () => {
    expect(CommentPollConfigZ.parse({})).toEqual({ maxPerRun: 20 });
    expect(() => parseRoutineConfig("comment_poll", { maxPerRun: 101 })).toThrow(/maxPerRun/);
  });
});

describe("content_calendar routine", () => {
  it("queues one fanpage.content_calendar task with the window, what is already planned and what was posted", () => {
    const t = setup();
    t.db.facebook.recordAgentPost({ id: "s1", message: "Bài đã lên lịch về 2.4", permalinkUrl: null, createdTime: NOW.toISOString(), isPublished: false, scheduledPublishTime: "2026-10-07T01:30:00.000Z", outboxId: "obx_1" });
    t.db.facebook.upsertPost({ id: "old", message: "Bài đã đăng", permalinkUrl: null, createdTime: "2026-09-30T01:00:00.000Z", isPublished: true, scheduledPublishTime: null });
    const draft = t.db.outbox.createDraft({
      agentId: "fp-01",
      channel: "facebook_post",
      to: "fb:page:p",
      subject: "Facebook post (tip)",
      body: "Mẹo chờ duyệt",
      reason: "r",
      payload: { kind: "post", postType: "tip", link: null, sourceUrl: null, publishAt: null },
    });

    const outcome = runRoutine({ db: t.db, now: () => NOW }, t.routine("fp-01", "content_calendar", { postsPerWeek: 2, daysAhead: 7 }), { manual: false });
    expect(outcome.skipped).toBe(false);
    expect(outcome.taskIds).toHaveLength(1);
    expect(outcome.result).toMatch(/queued content calendar 2026-10-05\.\.2026-10-12 \(2 posts; 1 scheduled, 1 drafts already\)/);
    const task = t.db.tasks.get(outcome.taskIds[0]!)!;
    expect(task).toMatchObject({ kind: "fanpage.content_calendar", agentId: "fp-01", status: "queued" });
    expect(task.input).toMatchObject({ weekStart: "2026-10-05", weekEnd: "2026-10-12", postsPerWeek: 2, postTypes: ["feature", "tip", "release"] });
    expect(task.input["scheduled"]).toMatchObject([{ postId: "s1", scheduledPublishTime: "2026-10-07T01:30:00.000Z" }]);
    expect(task.input["pendingDrafts"]).toMatchObject([{ outboxId: draft.id, postType: "tip" }]);
    expect(task.input["recent"]).toMatchObject([{ postId: "old" }]);
  });

  it("skips while the previous calendar is still queued or running, and for a paused agent", () => {
    const t = setup();
    const r = t.routine("fp-01", "content_calendar");
    expect(runRoutine({ db: t.db, now: () => NOW }, r, { manual: true }).taskIds).toHaveLength(1);
    const again = runRoutine({ db: t.db, now: () => NOW }, r, { manual: true });
    expect(again.taskIds).toEqual([]);
    expect(again.result).toMatch(/skipped: previous content calendar/);
    t.db.agents.setStatus("fp-01", "paused");
    expect(runRoutine({ db: t.db, now: () => NOW }, r, { manual: true }).skipped).toBe(true);
  });
});

describe("comment_poll routine", () => {
  it("assigns stored comments that have no task, oldest first, up to maxPerRun, and never twice", () => {
    const t = setup();
    t.comment("c1", "2026-10-04T10:00:00.000Z");
    t.comment("c2", "2026-10-04T11:00:00.000Z");
    t.comment("c3", "2026-10-04T12:00:00.000Z");
    const r = t.routine("fp-01", "comment_poll", { maxPerRun: 2 });

    const first = runRoutine({ db: t.db, now: () => NOW }, r, { manual: false });
    expect(first.taskIds).toHaveLength(2);
    expect(first.result).toBe("queued 2 comment replies (1 more waiting)");
    expect(t.db.tasks.get(first.taskIds[0]!)!.input["commentId"]).toBe("c1");

    const second = runRoutine({ db: t.db, now: () => NOW }, r, { manual: false });
    expect(second.taskIds).toHaveLength(1);
    expect(t.db.tasks.get(second.taskIds[0]!)!.input["commentId"]).toBe("c3");

    const third = runRoutine({ db: t.db, now: () => NOW }, r, { manual: false });
    expect(third).toMatchObject({ taskIds: [], result: "no new comments waiting" });
    expect(t.db.tasks.list({}).filter((x) => x.kind === "fanpage.reply_comment")).toHaveLength(3);
  });

  it("does not take comments the poller already assigned", () => {
    const t = setup();
    t.comment("c1");
    t.db.facebook.assign("c1", "task-elsewhere", "fp-01");
    expect(runRoutine({ db: t.db, now: () => NOW }, t.routine("fp-01", "comment_poll"), { manual: true }).taskIds).toEqual([]);
  });
});

describe("routine routes accept the Fanpage kinds only for an agent whose template defines them", () => {
  it("creates both kinds for a fanpage agent, refuses them for an SDR", async () => {
    const t = setup();
    const app = createAdminApi({ config: t.config, db: t.db, bus: new EventBus() });
    const post = (body: unknown) =>
      app.request("/v1/admin/routines", { method: "POST", headers: { authorization: `Bearer ${t.config.adminToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const base = { schedule: "*/10 * * * *", timezone: "Asia/Ho_Chi_Minh" };

    expect((await post({ ...base, agentId: "fp-01", kind: "comment_poll", name: "Comments", config: { maxPerRun: 10 } })).status).toBe(200);
    expect((await post({ ...base, agentId: "fp-01", kind: "content_calendar", name: "Lịch tuần", schedule: "0 8 * * 1" })).status).toBe(200);
    const sdr = await post({ ...base, agentId: "sdr-01", kind: "content_calendar", name: "nope" });
    expect(sdr.status).toBe(400);
    expect(((await sdr.json()) as { error: { message: string } }).error.message).toMatch(/fanpage\.content_calendar.*not defined by the sales-sdr template/);
  });
});
