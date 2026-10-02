import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client.ts";
import { useApi } from "../../hooks/useApi.ts";
import { relativeAge, formatDateTime } from "../../lib/time.ts";
import type { InboundClassification, InboundEvent, InboundStatus } from "../../api/types.ts";

const STATUSES: InboundStatus[] = ["received", "routed", "ignored", "failed"];
const CLASSIFICATIONS: InboundClassification[] = ["reply", "new_lead", "unsubscribe", "auto_reply", "bounce", "spam", "other"];

interface AttachmentMeta {
  filename: string | null;
  contentType: string;
  size: number;
  /** Relative path of the saved file; null when the content wasn't saved. */
  file: string | null;
  error?: string;
}

function attachmentsOf(ev: InboundEvent): AttachmentMeta[] {
  const raw = ev.payload["attachments"];
  return Array.isArray(raw) ? (raw as AttachmentMeta[]) : [];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function downloadAttachment(eventId: string, index: number, filename: string): Promise<void> {
  const blob = await api.inboundAttachment(eventId, index);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function InboundPage() {
  const [status, setStatus] = useState<InboundStatus | "">("");
  const [classification, setClassification] = useState<InboundClassification | "">("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const { data, loading, error } = useApi(
    () => api.listInbound({ status: status || undefined, classification: classification || undefined, limit: 100 }),
    [status, classification],
    ["inbound.received", "inbound.routed"],
  );

  const events = data?.events ?? [];
  const selected = events.find((e) => e.id === selectedId) ?? events[0] ?? null;

  return (
    <div>
      <h1>Inbound</h1>
      <div className="filter-bar">
        <select value={status} onChange={(e) => setStatus(e.target.value as InboundStatus | "")} aria-label="Filter by status">
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={classification}
          onChange={(e) => setClassification(e.target.value as InboundClassification | "")}
          aria-label="Filter by classification"
        >
          <option value="">All classifications</option>
          {CLASSIFICATIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="inbox-layout">
        <div className="inbox-list">
          {!loading && events.length === 0 && <p className="empty-state">No inbound events.</p>}
          {events.map((ev) => (
            <button
              key={ev.id}
              type="button"
              className={`inbox-row ${selected?.id === ev.id ? "selected" : ""}`}
              onClick={() => setSelectedId(ev.id)}
            >
              <div className="inbox-row-top">
                <span>{ev.fromName ?? ev.fromAddress ?? "unknown sender"}</span>
                <span className="faint">{relativeAge(ev.receivedAt)}</span>
              </div>
              <div className="inbox-row-subject">{ev.subject ?? "(no subject)"}</div>
              <div className="inbox-row-meta">
                <span className="chip">{ev.classification}</span>
                <span className="chip">{ev.status}</span>
                {attachmentsOf(ev).length > 0 && <span className="chip">📎 {attachmentsOf(ev).length}</span>}
              </div>
            </button>
          ))}
        </div>

        <div className="inbox-detail">
          {!selected ? (
            <p className="empty-state">Select an event.</p>
          ) : (
            <>
              <h2>{selected.subject ?? "(no subject)"}</h2>
              <p className="muted">
                From {selected.fromName ?? "unknown"} &lt;{selected.fromAddress ?? "—"}&gt; · {formatDateTime(selected.receivedAt)}
              </p>
              <p>
                <span className="chip">{selected.classification}</span> <span className="chip">{selected.status}</span>
              </p>
              {selected.statusReason && <p className="muted">{selected.statusReason}</p>}
              {selected.routedTaskId && (
                <p>
                  Routed to <Link to={`/tasks/${selected.routedTaskId}`}>task {selected.routedTaskId}</Link>
                </p>
              )}
              <pre style={{ whiteSpace: "pre-wrap" }}>{selected.bodyText}</pre>
              {attachmentsOf(selected).length > 0 && (
                <>
                  <h3>Attachments</h3>
                  <ul>
                    {attachmentsOf(selected).map((a, i) => (
                      <li key={i}>
                        {a.file ? (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => {
                              setDownloadError(null);
                              downloadAttachment(selected.id, i, a.filename ?? `attachment-${i + 1}`).catch((e: unknown) =>
                                setDownloadError(e instanceof Error ? e.message : String(e)),
                              );
                            }}
                          >
                            {a.filename ?? "(unnamed)"}
                          </button>
                        ) : (
                          <span>{a.filename ?? "(unnamed)"}</span>
                        )}{" "}
                        <span className="muted">
                          · {a.contentType} · {formatSize(a.size)}
                          {!a.file && ` · not saved${a.error ? `: ${a.error}` : ""}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {downloadError && <p className="form-error">{downloadError}</p>}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
