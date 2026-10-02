import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../../api/client.ts";
import { coordinationApi } from "../../api/coordination.ts";
import { useApi } from "../../hooks/useApi.ts";
import { useToast } from "../../components/Toast.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { StageBadge } from "../../components/StageBadge.tsx";
import { formatDateTime } from "../../lib/time.ts";
import { roleLabel } from "../../lib/roles.ts";
import type { Agent, ContactView, Note, TimelineEntry } from "../../api/types.ts";

interface HandoffEntry {
  key: string;
  at: string;
  fromAgentId: string | null;
  toAgentId: string;
  summary: string;
  by: string | null;
}

const HANDOFF_NOTE = /^Handed off from (\S+) to (\S+?)(?:: ([\s\S]*)|\.)$/;

/** Handoff history: the structured audit rows when the API returns them, otherwise the notes the handoff wrote. */
function buildHandoffs(contactId: string, audit: { id: string; at: string; data: Record<string, unknown> }[] | undefined, notes: Note[]): HandoffEntry[] {
  const fromAudit = (audit ?? [])
    .filter((e) => e.data["contactId"] === contactId)
    .map((e) => ({
      key: e.id,
      at: e.at,
      fromAgentId: typeof e.data["fromAgentId"] === "string" ? (e.data["fromAgentId"] as string) : null,
      toAgentId: String(e.data["toAgentId"] ?? ""),
      summary: typeof e.data["summary"] === "string" ? (e.data["summary"] as string) : "",
      by: typeof e.data["by"] === "string" ? (e.data["by"] as string) : null,
    }));
  if (fromAudit.length > 0) return fromAudit;
  const out: HandoffEntry[] = [];
  for (const n of notes) {
    const m = HANDOFF_NOTE.exec(n.body);
    if (!m) continue;
    out.push({ key: n.id, at: n.createdAt, fromAgentId: m[1] === "(unassigned)" ? null : m[1]!, toAgentId: m[2]!, summary: m[3] ?? "", by: null });
  }
  return out;
}

/** Why the handoff button is unavailable, or null when it can be used. */
function handoffBlocker(contact: ContactView, agents: Agent[], defaultAmId: string | null | undefined): string | null {
  const owner = contact.ownerAgentId ? agents.find((a) => a.id === contact.ownerAgentId) : undefined;
  if (owner?.role === "account-manager") return `Already owned by an Account Manager (${owner.displayName}).`;
  if (!contact.email) return "This contact has no email address, so there is nothing to onboard.";
  if (!defaultAmId) return "No default Account Manager is set. Choose one in Settings first.";
  const am = agents.find((a) => a.id === defaultAmId);
  if (!am || am.status !== "active" || am.role !== "account-manager") {
    return `The default Account Manager (${defaultAmId}) is not an active account-manager agent. Update it in Settings.`;
  }
  return null;
}

export function ContactDetailPage() {
  const { id = "" } = useParams();
  const { notify } = useToast();
  const { data, loading, error, refresh } = useApi(() => api.getContact(id), [id], ["contact.handoff", "contact.upserted"]);
  const { data: settingsData } = useApi(() => api.getSettings(), [], ["settings.changed"]);
  const { data: agentsData } = useApi(() => api.listAgents(), [], ["agent.created", "agent.updated"]);
  const { data: auditData, refresh: refreshAudit } = useApi(() => coordinationApi.listHandoffAudit(), [id], ["contact.handoff"]);
  const [confirming, setConfirming] = useState(false);
  const [summary, setSummary] = useState("");
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const agents = agentsData?.agents ?? [];
  const agentName = useMemo(() => new Map(agents.map((a) => [a.id, a.displayName])), [agents]);
  const nameOf = (agentId: string) => {
    const n = agentName.get(agentId);
    return n ? `${n} (${agentId})` : agentId;
  };

  if (loading && !data) return <p className="empty-state">Loading…</p>;
  if (error) return <p className="form-error">{error}</p>;
  if (!data) return <p className="empty-state">Contact not found.</p>;

  const { contact, timeline } = data;
  const owner = contact.ownerAgentId ? agents.find((a) => a.id === contact.ownerAgentId) : undefined;
  const blocker = handoffBlocker(contact, agents, settingsData?.settings.defaultAmAgentId);
  const settingsReady = settingsData !== null && agentsData !== null;
  const defaultAm = settingsData?.settings.defaultAmAgentId ?? null;
  const handoffs = buildHandoffs(
    contact.id,
    auditData?.events,
    timeline.flatMap((t) => (t.type === "note" ? [t.note] : [])),
  );

  // Handoff notes are shown under "Handoff history" instead.
  const notes = contact.recentNotes.filter((n) => !HANDOFF_NOTE.test(n.body));

  async function doHandoff() {
    setBusy(true);
    setHandoffError(null);
    try {
      const res = await coordinationApi.handoff(contact.id, summary.trim() ? { summary: summary.trim() } : {});
      notify(`Handed off to ${nameOf(res.toAgentId)}. An onboarding task was queued.`, "success");
      setConfirming(false);
      setSummary("");
      refresh();
      refreshAudit();
    } catch (err) {
      setHandoffError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p>
        <Link to="/contacts">&larr; Contacts</Link>
      </p>
      <div className="page-header">
        <h1>{contact.name ?? contact.email}</h1>
        <div className="inbox-detail-actions">
          <span title={blocker ?? (settingsReady ? undefined : "Loading…")}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!settingsReady || blocker !== null}
              onClick={() => {
                setHandoffError(null);
                setConfirming(true);
              }}
            >
              Hand off to Account Manager
            </button>
          </span>
        </div>
      </div>
      {settingsReady && blocker && <p className="muted handoff-blocker">{blocker}</p>}
      <div className="two-col">
        <div className="card">
          <h3>Details</h3>
          <p>Email: {contact.email ?? "—"}</p>
          <p>Title: {contact.title ?? "—"}</p>
          <p>Phone: {contact.phone ?? "—"}</p>
          <p>Company: {contact.company?.name ?? "—"}</p>
          <p>
            Stage: <StageBadge stage={contact.stage} />
          </p>
          <p>
            Owner:{" "}
            {contact.ownerAgentId ? (
              <>
                {owner?.displayName ?? contact.ownerAgentId} <span className="faint">({contact.ownerAgentId}</span>
                {owner && <span className="faint"> · {roleLabel(owner.role)}</span>}
                <span className="faint">)</span>
              </>
            ) : (
              "—"
            )}
          </p>
          <p>Language: {contact.language ?? "—"}</p>
          <h3>Handoff history</h3>
          {handoffs.length === 0 && <p className="faint">Never handed off.</p>}
          {handoffs.map((h) => (
            <div key={h.key} className="handoff-item">
              <div>
                {h.fromAgentId ? nameOf(h.fromAgentId) : "(unassigned)"} &rarr; <strong>{nameOf(h.toAgentId)}</strong>
              </div>
              <div className="faint">
                {formatDateTime(h.at)}
                {h.by ? ` · by ${h.by === "human" ? "a human" : h.by}` : ""}
              </div>
              {h.summary && <p className="muted">{h.summary}</p>}
            </div>
          ))}
          {notes.length > 0 && (
            <>
              <h3>Notes</h3>
              {notes.map((n) => (
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

      {confirming && (
        <ConfirmDialog
          title="Hand off to Account Manager?"
          description={
            <>
              <p>
                <strong>{contact.name ?? contact.email}</strong> becomes a <strong>customer</strong> owned by{" "}
                <strong>{defaultAm ? nameOf(defaultAm) : "the default Account Manager"}</strong>. Pending follow-ups from
                the current owner are cancelled and an onboarding task is queued. Nothing is sent until you approve the draft.
              </p>
            </>
          }
          confirmLabel={busy ? "Handing off…" : "Hand off"}
          onConfirm={() => {
            if (!busy) void doHandoff();
          }}
          onCancel={() => {
            if (!busy) setConfirming(false);
          }}
        >
          <div className="field">
            <label htmlFor="handoff-summary">Summary for the Account Manager (optional)</label>
            <textarea
              id="handoff-summary"
              rows={4}
              maxLength={2000}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="What was agreed, plan and expectations, anything the AM should not promise…"
              style={{ width: "100%", fontFamily: "inherit" }}
            />
          </div>
          {handoffError && (
            <p className="form-error" role="alert">
              {handoffError}
            </p>
          )}
        </ConfirmDialog>
      )}
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
