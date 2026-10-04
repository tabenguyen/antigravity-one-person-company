// Fanpage Manager admin routes (docs/FANPAGE.md section 10):
//   GET  /v1/admin/facebook/status                    -> { status }
//   GET  /v1/admin/facebook/scheduled                 -> { posts, source, error }   (live from Facebook, else what we sent)
//   POST /v1/admin/facebook/scheduled/:postId/cancel  -> { postId }
//   GET  /v1/admin/facebook/comments?status=&limit=   -> { comments }
//   POST /v1/admin/facebook/doctor                    -> { report }
//   POST /v1/admin/facebook/preview/:outboxId         -> { postId }   (an unpublished preview post of a draft)

import type { Context, Hono } from "hono";
import type { ApiEnvelope, ApiErrorCode, FbCommentRecord, FbCommentStatus } from "@agyhq/core";
import { ConflictError, NotFoundError } from "@agyhq/db";
import type { AdminApiDeps } from "./admin-api.ts";
import { runFacebookDoctor, type FacebookDoctorReport } from "./facebook/doctor.ts";
import type { FacebookStatus } from "./facebook/runtime.ts";
import { ValidationError } from "./util.ts";

export interface ScheduledPostView {
  postId: string;
  message: string | null;
  scheduledPublishTime: string | null;
  permalinkUrl: string | null;
  /** The outbox draft we scheduled it from, when we did. */
  outboxId: string | null;
}

export type FacebookStatusResponse = ApiEnvelope<{ status: FacebookStatus; commentsByStatus: Record<string, number> }>;
export type FacebookScheduledResponse = ApiEnvelope<{ posts: ScheduledPostView[]; source: "facebook" | "local"; error: string | null }>;
export type FacebookDoctorResponse = ApiEnvelope<{ report: FacebookDoctorReport }>;
export type FacebookCommentsResponse = ApiEnvelope<{ comments: FbCommentRecord[] }>;

function ok<T>(c: Context, data: T) {
  const body: ApiEnvelope<T> = { ok: true, data };
  return c.json(body, 200);
}

function fail(c: Context, code: ApiErrorCode, message: string, status: 400 | 404 | 409 | 500) {
  const body: ApiEnvelope<never> = { ok: false, error: { code, message } };
  return c.json(body, status);
}

async function guarded(c: Context, fn: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    return ok(c, (await fn()) as object);
  } catch (err) {
    if (err instanceof NotFoundError) return fail(c, "not_found", err.message, 404);
    if (err instanceof ConflictError) return fail(c, "conflict", err.message, 409);
    if (err instanceof ValidationError) return fail(c, "invalid_request", err.message, 400);
    return fail(c, "internal", err instanceof Error ? err.message : String(err), 500);
  }
}

const COMMENT_STATUSES: FbCommentStatus[] = ["new", "assigned", "own", "skipped", "replied", "hidden"];

export function registerFacebookRoutes(app: Hono, deps: AdminApiDeps): void {
  const { db, bus, config } = deps;

  app.get("/v1/admin/facebook/status", (c) =>
    guarded(c, () => {
      const counts: Record<string, number> = {};
      for (const s of COMMENT_STATUSES) counts[s] = db.facebook.listComments({ status: [s], limit: 10_000 }).length;
      const status: FacebookStatus = deps.facebook
        ? deps.facebook.status()
        : {
            kind: config.facebook.kind,
            configured: false,
            configError: null,
            pageId: null,
            lastPollAt: null,
            lastPollError: null,
            lastSendAt: null,
            pollIntervalMs: config.facebook.pollIntervalMs,
            scheduleLeadHours: config.facebook.scheduleLeadHours,
          };
      return { status, commentsByStatus: counts };
    }),
  );

  app.get("/v1/admin/facebook/scheduled", (c) =>
    guarded(c, async () => {
      const local = (): ScheduledPostView[] =>
        db.facebook.listPosts({ scheduledAfter: new Date().toISOString(), limit: 100 }).map((p) => ({
          postId: p.id,
          message: p.message,
          scheduledPublishTime: p.scheduledPublishTime,
          permalinkUrl: p.permalinkUrl,
          outboxId: p.outboxId,
        }));
      const provider = deps.facebook?.provider ?? null;
      if (!provider) return { posts: local(), source: "local" as const, error: deps.facebook?.configError ?? "no Facebook provider is configured" };
      try {
        const live = await provider.listScheduledPosts();
        const posts: ScheduledPostView[] = live.map((p) => ({
          postId: p.id,
          message: p.message,
          scheduledPublishTime: p.scheduledPublishTime,
          permalinkUrl: p.permalinkUrl,
          outboxId: db.facebook.getPost(p.id)?.outboxId ?? null,
        }));
        return { posts, source: "facebook" as const, error: null };
      } catch (err) {
        return { posts: local(), source: "local" as const, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  app.post("/v1/admin/facebook/scheduled/:postId/cancel", (c) => {
    const postId = c.req.param("postId");
    return guarded(c, async () => {
      const provider = deps.facebook?.provider;
      if (!provider) throw new ValidationError("no Facebook provider is configured");
      await provider.cancelScheduledPost(postId);
      const known = db.facebook.getPost(postId);
      db.facebook.deletePost(postId);
      if (known?.outboxId) db.outbox.annotateSuperseded(known.outboxId, "cancelled: the scheduled post was cancelled from agy-ui and will not go live");
      db.audit.append({ kind: "facebook.scheduled_cancelled", agentId: null, taskId: null, conversationId: null, data: { postId, outboxId: known?.outboxId ?? null } });
      bus.emit("facebook.scheduled_cancelled", { postId });
      return { postId };
    });
  });

  app.get("/v1/admin/facebook/comments", (c) => {
    const statusParam = c.req.query("status");
    const status = statusParam ? (statusParam.split(",").filter((s): s is FbCommentStatus => (COMMENT_STATUSES as string[]).includes(s))) : undefined;
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 500);
    return guarded(c, () => ({ comments: db.facebook.listComments({ status, limit }) }));
  });

  app.post("/v1/admin/facebook/doctor", (c) =>
    guarded(c, async () => ({
      report: await runFacebookDoctor({ config, db }, deps.facebook?.provider ?? null, { mode: "daemon", providerError: deps.facebook?.configError ?? null }),
    })),
  );

  app.post("/v1/admin/facebook/preview/:outboxId", (c) => {
    const id = c.req.param("outboxId");
    return guarded(c, async () => {
      const item = db.outbox.get(id);
      if (!item) throw new NotFoundError("outbox item", id);
      if (item.channel !== "facebook_post" || item.payload?.kind !== "post") throw new ValidationError("only Facebook post drafts can be previewed");
      if (item.status !== "pending_approval" && item.status !== "approved") throw new ConflictError(`the draft is ${item.status}; only a pending or approved draft can be previewed`);
      const provider = deps.facebook?.provider;
      if (!provider) throw new ValidationError("no Facebook provider is configured");
      const res = await provider.createPost({ message: item.body, link: item.payload.link, mode: "preview" });
      db.audit.append({ kind: "facebook.preview_created", agentId: item.agentId, taskId: item.taskId, conversationId: null, data: { id: item.id, postId: res.postId } });
      return { postId: res.postId };
    });
  });
}
