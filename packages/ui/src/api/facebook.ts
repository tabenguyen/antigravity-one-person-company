// Fanpage Manager admin API (GET/POST /v1/admin/facebook/...). Wire types come from @agyhq/server (type-only, erased at build).

import type { FbCommentRecord, OutboxItem } from "@agyhq/core";
import type { FacebookStatus, ScheduledPostView } from "@agyhq/server";
import { request } from "./client.ts";

export type { FacebookStatus, ScheduledPostView };

export interface FacebookOverview {
  status: FacebookStatus;
  commentsByStatus: Record<string, number>;
}

export interface ScheduledPosts {
  posts: ScheduledPostView[];
  /** "facebook": live from the Page. "local": what we sent, because Facebook could not be asked (see `error`). */
  source: "facebook" | "local";
  error: string | null;
}

export const facebookApi = {
  status: () => request<FacebookOverview>("/v1/admin/facebook/status", { method: "GET" }),
  scheduled: () => request<ScheduledPosts>("/v1/admin/facebook/scheduled", { method: "GET" }),
  cancelScheduled: (postId: string) => request<{ postId: string }>(`/v1/admin/facebook/scheduled/${encodeURIComponent(postId)}/cancel`, { method: "POST" }),
  comments: (status?: string[]) =>
    request<{ comments: FbCommentRecord[] }>(`/v1/admin/facebook/comments${status && status.length ? `?status=${status.join(",")}` : ""}`, { method: "GET" }),
  preview: (outboxId: string) => request<{ postId: string }>(`/v1/admin/facebook/preview/${encodeURIComponent(outboxId)}`, { method: "POST" }),
};

/** Is this outbox item a Facebook post, reply or hide proposal? */
export function isFacebookItem(item: Pick<OutboxItem, "channel">): boolean {
  return item.channel !== "email";
}

/** Short label for the Inbox list: what kind of Facebook action this is and what it concerns. */
export function facebookLabel(item: OutboxItem): string {
  const p = item.payload;
  if (!p) return "Facebook";
  if (p.kind === "post") return `Page post · ${p.postType}`;
  if (p.kind === "reply") return `Reply to ${p.commenterName ?? "a visitor"}`;
  return `Hide comment by ${p.commenterName ?? "a visitor"}`;
}
