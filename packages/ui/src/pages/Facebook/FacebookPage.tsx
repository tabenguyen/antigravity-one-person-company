// Facebook: the channel's health and the scheduled-posts view. Approved posts are handed to Facebook as SCHEDULED posts (never
// posted at once); this page lists them and lets a human cancel one, the same as Meta Business Suite would.

import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../../api/client.ts";
import { facebookApi, type ScheduledPostView } from "../../api/facebook.ts";
import { useApi } from "../../hooks/useApi.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { useToast } from "../../components/Toast.tsx";
import { formatDateTime, relativeAge } from "../../lib/time.ts";
import "../Inbox/facebook.css";

const EVENTS = ["facebook.post_scheduled", "facebook.scheduled_cancelled", "outbox.updated"];

export function FacebookPage() {
  const { notify } = useToast();
  const status = useApi(() => facebookApi.status(), [], ["facebook.comments", "facebook.error", ...EVENTS]);
  const scheduled = useApi(() => facebookApi.scheduled(), [], EVENTS);
  const [cancelling, setCancelling] = useState<ScheduledPostView | null>(null);

  async function cancel(post: ScheduledPostView) {
    try {
      await facebookApi.cancelScheduled(post.postId);
      notify("Scheduled post cancelled.", "success");
      scheduled.refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    } finally {
      setCancelling(null);
    }
  }

  const s = status.data?.status;
  const counts = status.data?.commentsByStatus ?? {};
  const posts = scheduled.data?.posts ?? [];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Facebook</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Posts and replies wait in the <Link to="/inbox">Inbox</Link> for your approval. An approved post is only ever scheduled, so you can still cancel it here or in Meta Business Suite.
          </p>
        </div>
      </div>

      {status.error && <p className="form-error">{status.error}</p>}
      {s && !s.configured && (
        <div className="banner banner-warning" role="status">
          {s.configError ?? `Facebook is not connected (facebook.kind is "${s.kind}").`} Add a <code>facebook</code> block to <code>agyhq.config.json</code> and run <code>hq facebook doctor</code>.
        </div>
      )}
      {s?.lastPollError && (
        <div className="banner banner-danger" role="alert">
          Last poll failed: {s.lastPollError}
        </div>
      )}

      {s && (
        <div className="card">
          <h3>Channel</h3>
          <div className="fb-status">
            <div>
              <div className="stat-label">Provider</div>
              <div>{s.kind}</div>
            </div>
            <div>
              <div className="stat-label">Page</div>
              <div>{s.pageId ?? "—"}</div>
            </div>
            <div>
              <div className="stat-label">Last poll</div>
              <div>{s.lastPollAt ? relativeAge(s.lastPollAt) : "—"}</div>
            </div>
            <div>
              <div className="stat-label">Posts scheduled at least</div>
              <div>{s.scheduleLeadHours}h ahead</div>
            </div>
            <div>
              <div className="stat-label">Comments</div>
              <div>
                {counts["new"] ?? 0} waiting · {counts["assigned"] ?? 0} with an agent · {counts["replied"] ?? 0} replied · {counts["hidden"] ?? 0} hidden
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h3>Scheduled posts</h3>
        {scheduled.error && <p className="form-error">{scheduled.error}</p>}
        {scheduled.data?.source === "local" && (
          <p className="faint" role="status">
            Showing what we sent{scheduled.data.error ? ` (Facebook could not be asked: ${scheduled.data.error})` : ""}.
          </p>
        )}
        {scheduled.loading && !scheduled.data && <p className="empty-state">Loading…</p>}
        {scheduled.data && posts.length === 0 && <p className="empty-state">No scheduled posts.</p>}
        {posts.length > 0 && (
          <table className="fb-table">
            <thead>
              <tr>
                <th>Goes live</th>
                <th>Post</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => (
                <tr key={p.postId}>
                  <td>{formatDateTime(p.scheduledPublishTime)}</td>
                  <td>
                    <div className="fb-text">{p.message ?? "(no text)"}</div>
                    <div className="faint fb-meta">
                      {p.postId}
                      {p.outboxId ? (
                        <>
                          {" "}
                          · from draft <Link to="/inbox">{p.outboxId}</Link>
                        </>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => setCancelling(p)}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {cancelling && (
        <ConfirmDialog
          title="Cancel this scheduled post?"
          description={
            <>
              <p>It will not go live{cancelling.scheduledPublishTime ? ` on ${formatDateTime(cancelling.scheduledPublishTime)}` : ""}. This deletes the scheduled post on Facebook.</p>
              <p className="faint">{cancelling.message}</p>
            </>
          }
          confirmLabel="Cancel the post"
          cancelLabel="Keep it"
          destructive
          onConfirm={() => void cancel(cancelling)}
          onCancel={() => setCancelling(null)}
        />
      )}
    </div>
  );
}
