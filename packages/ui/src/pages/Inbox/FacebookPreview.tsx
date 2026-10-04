// The Inbox's view of a Facebook draft: a post preview (type, text, link, source, planned go-live) or the comment being answered
// with our reply (or hide proposal) under it. The text is edited in the shared textarea of InboxDetail; this adds what
// is specific to Facebook.

import type { OutboxItem } from "../../api/types.ts";
import { formatDateTime } from "../../lib/time.ts";
import "./facebook.css";

type PostPayload = Extract<NonNullable<OutboxItem["payload"]>, { kind: "post" }>;
type CommentPayload = Extract<NonNullable<OutboxItem["payload"]>, { kind: "reply" | "hide" }>;

/** `datetime-local` wants "YYYY-MM-DDTHH:mm" in the browser's zone; the API takes an ISO instant. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function CommentCard({ payload }: { payload: CommentPayload }) {
  return (
    <div className="fb-card fb-comment" aria-label="Comment on the Page">
      <div className="fb-card-head">
        <span className="fb-avatar" aria-hidden="true">
          {(payload.commenterName ?? "?").slice(0, 1).toUpperCase()}
        </span>
        <strong>{payload.commenterName ?? "A visitor"}</strong>
        <span className="faint">commented{payload.postId ? ` on post ${payload.postId}` : ""}</span>
      </div>
      <p className="fb-text">{payload.commentText}</p>
    </div>
  );
}

export function PostCard({ payload, body, leadHours }: { payload: PostPayload; body: string; leadHours: number | null }) {
  return (
    <div className="fb-card fb-post" aria-label="Post preview">
      <div className="fb-card-head">
        <span className="pill pill-neutral">{payload.postType}</span>
        <span className="faint">Facebook Page post (preview)</span>
      </div>
      <p className="fb-text">{body}</p>
      {payload.link && (
        <p className="fb-meta">
          Link: <span className="fb-url">{payload.link}</span>
        </p>
      )}
      {payload.sourceUrl && (
        <p className="fb-meta">
          Source: <span className="fb-url">{payload.sourceUrl}</span>
        </p>
      )}
      <p className="fb-meta faint">
        {payload.fbPostId
          ? `Scheduled on Facebook for ${formatDateTime(payload.scheduledPublishTime ?? null)} (post ${payload.fbPostId}); cancel it on the Facebook page if you change your mind.`
          : `Never posted at once: approved, it is scheduled for ${payload.publishAt ? `${formatDateTime(payload.publishAt)} or ` : ""}at least ${leadHours ?? 24}h from approval, so you can still cancel it.`}
      </p>
    </div>
  );
}
