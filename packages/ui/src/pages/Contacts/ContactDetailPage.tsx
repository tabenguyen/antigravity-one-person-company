import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../api/client.ts";
import { useApi } from "../../hooks/useApi.ts";
import { formatDateTime } from "../../lib/time.ts";
import type { TimelineEntry } from "../../api/types.ts";

export function ContactDetailPage() {
  const { id = "" } = useParams();
  const { data, loading, error } = useApi(() => api.getContact(id), [id]);

  if (loading && !data) return <p className="empty-state">Loading…</p>;
  if (error) return <p className="form-error">{error}</p>;
  if (!data) return <p className="empty-state">Contact not found.</p>;

  const { contact, timeline } = data;

  return (
    <div>
      <p>
        <Link to="/contacts">&larr; Contacts</Link>
      </p>
      <h1>{contact.name ?? contact.email}</h1>
      <div className="two-col">
        <div className="card">
          <h3>Details</h3>
          <p>Email: {contact.email ?? "—"}</p>
          <p>Title: {contact.title ?? "—"}</p>
          <p>Phone: {contact.phone ?? "—"}</p>
          <p>Company: {contact.company?.name ?? "—"}</p>
          <p>
            Stage: <span className="chip">{contact.stage}</span>
          </p>
          <p>Owner: {contact.ownerAgentId ?? "—"}</p>
          <p>Language: {contact.language ?? "—"}</p>
          {contact.recentNotes.length > 0 && (
            <>
              <h3>Notes</h3>
              {contact.recentNotes.map((n) => (
                <p key={n.id} className="muted">
                  {n.body}
                </p>
              ))}
            </>
          )}
        </div>

        <div className="card">
          <h3>Timeline</h3>
          <div className="timeline">
            {timeline.length === 0 && <p className="empty-state">No activity yet.</p>}
            {timeline.map((entry, i) => (
              <div className="timeline-item" key={i}>
                <div className="faint">{formatDateTime(entry.at)}</div>
                <div>{describe(entry)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function describe(entry: TimelineEntry): ReactNode {
  switch (entry.type) {
    case "note":
      return `Note: ${entry.note.body}`;
    case "outbox":
      return (
        <>
          Outbox <span className="chip">{entry.item.status}</span> — {entry.item.subject ?? "(no subject)"}
        </>
      );
    case "inbound":
      return (
        <>
          Inbound <span className="chip">{entry.event.classification}</span> — {entry.event.subject ?? entry.event.bodyText.slice(0, 80)}
        </>
      );
    case "task":
      return (
        <>
          Task <span className="chip">{entry.task.status}</span> —{" "}
          <Link to={`/tasks/${entry.task.id}`}>{entry.task.title}</Link>
        </>
      );
    default:
      return null;
  }
}
