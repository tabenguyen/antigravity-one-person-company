import { StageBadge } from "../../components/StageBadge.tsx";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../api/client.ts";
import { useApi } from "../../hooks/useApi.ts";
import { useHotkeys } from "../../hooks/useHotkeys.ts";
import { useAuth } from "../../auth/AuthContext.tsx";
import { useToast } from "../../components/Toast.tsx";
import { relativeAge, formatDateTime } from "../../lib/time.ts";
import type { Agent, ContactView, OutboxItem, OutboxStatus, TimelineEntry } from "../../api/types.ts";
import { qualityApi, REJECTION_CATEGORY_OPTIONS, type RejectionCategory } from "../../api/quality.ts";
import { shadowApi } from "../../api/shadow.ts";
import { LintBadge, LintFindings, RejectCategoryChips } from "../Scorecards/LintFindings.tsx";

const HISTORY_TABS: { key: OutboxStatus; label: string }[] = [
  { key: "pending_approval", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "held", label: "Held" },
  { key: "sending", label: "Sending" },
  { key: "sent", label: "Sent" },
  { key: "failed", label: "Failed" },
  { key: "rejected", label: "Rejected" },
  { key: "blocked", label: "Blocked" },
];

export function InboxPage() {
  const { status } = useAuth();
  const { notify } = useToast();
  const [tab, setTab] = useState<OutboxStatus>("pending_approval");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [localItems, setLocalItems] = useState<OutboxItem[] | null>(null);
  const [agentFilter, setAgentFilter] = useState<string>("");
  const [showAllWaiting, setShowAllWaiting] = useState(false);

  // On a phone the detail sits below the list: bring it into view when a row is tapped.
  function pick(id: string) {
    setSelectedId(id);
    if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 900px)").matches) {
      document.getElementById("inbox-detail")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    }
  }

  const { data, loading, error, refresh } = useApi(
    () => api.listOutbox({ status: [tab], limit: 100, ...(agentFilter ? { agentId: agentFilter } : {}) }),
    [tab, agentFilter],
    ["outbox.drafted", "outbox.updated"],
  );
  const { data: agentsData } = useApi(() => api.listAgents(), []);
  const { data: shadow } = useApi(() => shadowApi.overview(), [], ["shadow.updated", "outbox.updated"]);
  const { data: waitingData } = useApi(
    () => api.listTasks({ status: ["waiting_approval"], limit: 50 }),
    [],
    ["task.transition"],
  );
  const waitingTasks = waitingData?.tasks ?? [];
  const agentsById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agentsData?.agents ?? []) map.set(a.id, a);
    return map;
  }, [agentsData]);

  // Server data wins whenever it changes; localItems lets us optimistically
  // remove an item the instant it's decided, without waiting for the SSE
  // refresh round-trip.
  useEffect(() => {
    // The review queue is worked oldest-first so nothing starves; every other tab is a newest-first history.
    const list = data?.items ?? null;
    setLocalItems(list && tab === "pending_approval" ? [...list].reverse() : list);
  }, [data, tab]);

  const items = localItems ?? [];

  useEffect(() => {
    if (items.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!items.some((i) => i.id === selectedId)) {
      setSelectedId(items[0]!.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const selectedIndex = items.findIndex((i) => i.id === selectedId);

  function selectDelta(delta: number) {
    if (items.length === 0) return;
    const idx = selectedIndex < 0 ? 0 : (selectedIndex + delta + items.length) % items.length;
    setSelectedId(items[idx]!.id);
  }

  function removeLocally(id: string) {
    // After deciding an item, move on to the one that followed it (not back to the top of the queue).
    const idx = items.findIndex((i) => i.id === id);
    if (idx >= 0 && id === selectedId) {
      const next = items[idx + 1] ?? items[idx - 1];
      if (next) setSelectedId(next.id);
    }
    setLocalItems((prev) => (prev ? prev.filter((i) => i.id !== id) : prev));
  }

  function replaceLocally(item: OutboxItem) {
    setLocalItems((prev) => (prev ? prev.map((i) => (i.id === item.id ? item : i)) : prev));
  }

  async function handleRetry(id: string) {
    try {
      const { item } = await api.retryOutbox(id);
      notify("Queued for retry.", "success");
      removeLocally(item.id);
      refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Inbox</h1>
        <span className="key-hint">
          <span className="kbd">J</span>/<span className="kbd">K</span> navigate · <span className="kbd">A</span> approve ·{" "}
          <span className="kbd">R</span> reject · <span className="kbd">⌘S</span> save
        </span>
      </div>

      {shadow?.active && (
        <div className="banner banner-shadow" role="status">
          Shadow run — day {shadow.active.day} of {shadow.active.plannedDays}: approving records your verdict, nothing is sent.{" "}
          <Link to="/shadow">See progress</Link>
        </div>
      )}

      {waitingTasks.length > 0 && (
        <div className="card decision-panel" aria-label="Tasks waiting for your decision">
          <h3>Tasks waiting for your decision ({waitingTasks.length})</h3>
          {(showAllWaiting ? waitingTasks : waitingTasks.slice(0, 2)).map((t) => (
            <div key={t.id} className="timeline-item">
              <Link to={`/tasks/${encodeURIComponent(t.id)}`}>{t.title}</Link>{" "}
              <span className="faint">
                {t.agentId} · {relativeAge(t.updatedAt)}
              </span>
              {t.result?.summary && <p className="muted" style={{ margin: "2px 0 0" }}>{t.result.summary}</p>}
            </div>
          ))}
          {waitingTasks.length > 2 && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowAllWaiting((v) => !v)}>
              {showAllWaiting ? "Show fewer" : `Show all ${waitingTasks.length}`}
            </button>
          )}
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="Outbox status">
        {HISTORY_TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`tab ${tab === t.key ? "active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.key === "pending_approval" && tab === t.key && localItems ? ` (${localItems.length})` : ""}
          </button>
        ))}
        {(agentsData?.agents.length ?? 0) > 1 && (
          <select
            className="inbox-agent-filter"
            aria-label="Filter by agent"
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
          >
            <option value="">All agents</option>
            {agentsData!.agents
              .filter((a) => a.status !== "archived")
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
          </select>
        )}
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="inbox-layout">
        <div className="inbox-list" aria-label="Outbox items">
          {loading && !localItems && <p className="empty-state">Loading…</p>}
          {!loading && items.length === 0 && <p className="empty-state">Nothing here.</p>}
          {items.map((item) => {
            const agent = agentsById.get(item.agentId);
            return (
              <button
                key={item.id}
                type="button"
                className={`inbox-row ${item.id === selectedId ? "selected" : ""}`}
                onClick={() => pick(item.id)}
              >
                <div className="inbox-row-top">
                  <span>
                    {agent?.displayName ?? item.agentId}
                    <LintBadge findings={item.lint} />
                  </span>
                  <span className="faint">{relativeAge(item.createdAt)}</span>
                </div>
                <div className="inbox-row-subject">{item.subject ?? "(no subject)"}</div>
                <div className="inbox-row-meta">
                  <span>{item.to}</span>
                  {item.statusReason && <span className="faint">{item.statusReason}</span>}
                </div>
              </button>
            );
          })}
        </div>

        {selected ? (
          <InboxDetail
            key={selected.id}
            item={selected}
            agent={agentsById.get(selected.agentId) ?? null}
            outboundEnabled={status?.outboundEnabled ?? false}
            onNext={() => selectDelta(1)}
            onPrev={() => selectDelta(-1)}
            onDecided={(id) => {
              removeLocally(id);
              refresh();
            }}
            onSaved={replaceLocally}
            onRetry={tab === "failed" ? handleRetry : undefined}
          />
        ) : (
          <div className="inbox-detail">
            <p className="empty-state">Select an item to review it.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function InboxDetail({
  item,
  agent,
  outboundEnabled,
  onNext,
  onPrev,
  onDecided,
  onSaved,
  onRetry,
}: {
  item: OutboxItem;
  agent: Agent | null;
  outboundEnabled: boolean;
  onNext: () => void;
  onPrev: () => void;
  onDecided: (id: string) => void;
  onSaved: (item: OutboxItem) => void;
  onRetry?: (id: string) => void;
}) {
  const { notify } = useToast();
  const [subject, setSubject] = useState(item.subject ?? "");
  const [body, setBody] = useState(item.body);
  const [saving, setSaving] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectCategory, setRejectCategory] = useState<RejectionCategory | null>(null);
  const [contact, setContact] = useState<ContactView | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);

  const isPending = item.status === "pending_approval";
  const dirty = isPending && (subject !== (item.subject ?? "") || body !== item.body);
  // Mirrors the server: lint errors (placeholders, ungrounded prices, ...) block approval.
  const blockingLint = (item.lint ?? []).filter((f) => f.severity === "error").length;
  const isShadow = agent?.trustTier === "shadow";

  useEffect(() => {
    setSubject(item.subject ?? "");
    setBody(item.body);
    setRejecting(false);
    setRejectReason("");
    setRejectCategory(null);
  }, [item.id, item.subject, item.body]);

  useEffect(() => {
    let cancelled = false;
    setContact(null);
    setTimeline([]);
    api
      .listContacts({ email: item.to, limit: 1 })
      .then(({ contacts }) => {
        if (cancelled || contacts.length === 0) return;
        setContact(contacts[0]!);
        return api.getContact(contacts[0]!.id).then(({ timeline }) => {
          if (!cancelled) setTimeline(timeline.slice(0, 5));
        });
      })
      .catch(() => {
        /* best-effort context panel */
      });
    return () => {
      cancelled = true;
    };
  }, [item.to]);

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const { item: updated } = await api.editOutbox(item.id, { subject, body });
      onSaved(updated);
      notify("Draft saved.", "success");
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    } finally {
      setSaving(false);
    }
  }

  async function approve() {
    if (blockingLint > 0) {
      notify("Fix the blocking issues listed below (edit + save), or reject the draft.", "error");
      return;
    }
    if (deciding || saving) return;
    setDeciding(true);
    try {
      if (dirty) {
        // "Edited then approved" is one step: save the edit (recorded for the edit-rate) and approve the saved version.
        const { item: saved } = await api.editOutbox(item.id, { subject, body });
        onSaved(saved);
        const stillBlocking = (saved.lint ?? []).filter((f) => f.severity === "error").length;
        if (stillBlocking > 0) {
          notify("Your edit was saved, but the draft now has blocking issues — fix them or reject.", "error");
          return;
        }
      }
      await api.approveOutbox(item.id);
      notify(isShadow ? "Recorded as a practice approval (not sent)." : "Approved.", "success");
      onDecided(item.id);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    } finally {
      setDeciding(false);
    }
  }

  async function reject() {
    if (!rejectCategory || deciding) return;
    setDeciding(true);
    try {
      // Feedback is optional (the category is the required, structured part); when given it becomes agent memory.
      await qualityApi.rejectWithCategory(item.id, { category: rejectCategory, ...(rejectReason.trim() ? { reason: rejectReason.trim() } : {}) });
      notify("Rejected.", "success");
      onDecided(item.id);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    } finally {
      setDeciding(false);
    }
  }

  const categoryKeys = REJECTION_CATEGORY_OPTIONS.map((o, i) => ({ key: String(i + 1), handler: () => setRejectCategory(o.value) }));
  useHotkeys(
    [
      { key: "j", handler: onNext },
      { key: "k", handler: onPrev },
      { key: "a", handler: () => void approve() },
      { key: "r", handler: () => setRejecting(true) },
      { key: "s", mod: true, handler: () => void save() },
      // Rejecting without the mouse: R, then 1-8 picks the category, then Ctrl/Cmd+Enter confirms (works inside the feedback box too).
      ...(rejecting ? [...categoryKeys, { key: "escape", handler: () => setRejecting(false) }] : []),
      ...(rejecting && rejectCategory ? [{ key: "enter", mod: true, handler: () => void reject() }] : []),
    ],
    true,
  );

  return (
    <div className="inbox-detail" id="inbox-detail">
      {isShadow && (
        <div className="banner banner-shadow" role="status">
          Practice draft — approving records your verdict; it will NOT be sent.
        </div>
      )}
      {!outboundEnabled && isPending && (
        <div className="banner banner-warning" role="status">
          Approved emails will queue until outbound is enabled.
        </div>
      )}
      {item.status === "blocked" && item.statusReason && (
        <div className="banner banner-danger">Blocked: {item.statusReason}</div>
      )}
      {item.status === "failed" && item.statusReason && (
        <div className="banner banner-danger">
          Failed: {item.statusReason}
          {onRetry && (
            <>
              {" "}
              <button type="button" className="btn btn-sm" onClick={() => onRetry(item.id)}>
                Retry
              </button>
            </>
          )}
        </div>
      )}

      <div className="inbox-detail-header">
        <div>
          <h2>
            {item.to}
            {dirty && <span className="dirty-dot" title="Unsaved changes" />}
          </h2>
          <p className="muted">
            {agent?.displayName ?? item.agentId} · {formatDateTime(item.createdAt)}
            {item.taskId && (
              <>
                {" "}
                · <Link to={`/tasks/${item.taskId}`}>view task</Link>
              </>
            )}
          </p>
        </div>
        {isPending && (
          <div className="inbox-detail-actions">
            {dirty && <span className="muted inbox-unsaved-hint">Unsaved edits — approving saves them</span>}
            {!dirty && blockingLint > 0 && (
              <span className="muted inbox-unsaved-hint">Fix {blockingLint} blocking issue(s) to approve</span>
            )}
            <button type="button" className="btn btn-sm" onClick={save} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={approve}
              disabled={deciding || saving || blockingLint > 0}
              title={blockingLint > 0 ? "Fix blocking issues before approving" : dirty ? "Saves your edits, then approves" : undefined}
            >
              {dirty ? "Save & approve" : "Approve"}
            </button>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => setRejecting(true)} disabled={deciding}>
              Reject
            </button>
          </div>
        )}
      </div>

      <div className="context-panel">
        <strong>Agent's reason:</strong> {item.reason}
      </div>

      <LintFindings findings={item.lint} />

      {isPending ? (
        <>
          <div className="field compose-field">
            <label htmlFor="outbox-subject">Subject</label>
            <input id="outbox-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="field compose-field">
            <label htmlFor="outbox-body">Body</label>
            <textarea id="outbox-body" value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          {item.editedByHuman && <p className="faint">Previously edited by a human.</p>}
        </>
      ) : (
        <>
          <h3>{item.subject}</h3>
          <pre style={{ whiteSpace: "pre-wrap" }}>{item.body}</pre>
          {item.decidedBy && (
            <p className="muted">
              Decided by {item.decidedBy} at {formatDateTime(item.decidedAt)}
              {item.decisionNote ? ` — ${item.decisionNote}` : ""}
            </p>
          )}
        </>
      )}

      {rejecting && (
        <div className="card" role="group" aria-label="Reject reason">
          <h3>Reject this draft</h3>
          <p className="muted">
            Pick a category (<span className="kbd">1</span>–<span className="kbd">8</span>) and confirm with <span className="kbd">⌘/Ctrl</span>+<span className="kbd">Enter</span>.
            Written feedback is optional but is what the agent learns from.
          </p>
          <RejectCategoryChips value={rejectCategory} onChange={setRejectCategory} showKeys />
          <div className="field">
            <label htmlFor="reject-reason">Feedback for the agent (optional)</label>
            <textarea
              id="reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={2}
              placeholder="What should it do differently next time?"
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setRejecting(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger" onClick={reject} disabled={!rejectCategory || deciding}>
              Confirm reject
            </button>
          </div>
        </div>
      )}

      {contact && (
        <div className="context-panel">
          <strong>Contact:</strong> {contact.name ?? contact.email} · stage: <StageBadge stage={contact.stage} />
          {contact.company && <> · {contact.company.name}</>}
          {timeline.length > 0 && (
            <div className="timeline" style={{ marginTop: 8 }}>
              {timeline.map((entry, i) => (
                <div className="timeline-item" key={i}>
                  {timelineLabel(entry)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function timelineLabel(entry: TimelineEntry): string {
  switch (entry.type) {
    case "note":
      return `Note: ${entry.note.body}`;
    case "outbox":
      return `Outbox (${entry.item.status}): ${entry.item.subject ?? ""}`;
    case "inbound":
      return `Inbound (${entry.event.classification}): ${entry.event.subject ?? entry.event.bodyText.slice(0, 60)}`;
    case "task":
      return `Task (${entry.task.status}): ${entry.task.title}`;
    default:
      return "";
  }
}
