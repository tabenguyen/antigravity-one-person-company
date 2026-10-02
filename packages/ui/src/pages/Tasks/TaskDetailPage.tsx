import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../../api/client.ts";
import { useApi } from "../../hooks/useApi.ts";
import { summarizeRunEvents } from "../../lib/runEvents.ts";
import { useToast } from "../../components/Toast.tsx";
import { formatDateTime } from "../../lib/time.ts";
import { eventHub, type HubEvent } from "../../api/sse.ts";
import type { Task, TaskStatus } from "../../api/types.ts";

const FINISHED: TaskStatus[] = ["done", "failed", "cancelled"];

export function TaskDetailPage() {
  const { id = "" } = useParams();
  const { notify } = useToast();
  const { data, loading, error, refresh } = useApi(() => api.getTask(id), [id], ["task.transition"]);
  const { data: transcript } = useApi(() => api.taskTranscript(id), [id, data?.task.status]);
  const [liveEvents, setLiveEvents] = useState<HubEvent[]>([]);

  const task = data?.task;

  useEffect(() => {
    setLiveEvents([]);
    return eventHub.subscribe("run.event", (e) => {
      if (e.taskId === id) setLiveEvents((prev) => [...prev, e]);
    });
  }, [id]);

  async function handleCancel() {
    try {
      await api.cancelTask(id);
      notify("Task cancelled.", "success");
      refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    }
  }

  async function handleRetry() {
    try {
      await api.retryTask(id);
      notify("Task queued for retry.", "success");
      refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    }
  }

  if (loading && !task) return <p className="empty-state">Loading…</p>;
  if (error) return <p className="form-error">{error}</p>;
  if (!task) return <p className="empty-state">Task not found.</p>;

  return (
    <div>
      <p>
        <Link to="/tasks">&larr; Tasks</Link>
      </p>
      <div className="page-header">
        <div>
          <h1>{task.title}</h1>
          <p className="muted">
            {task.agentId} · <code>{task.kind}</code> · <span className="chip">{task.status}</span>
            {task.parentTaskId && (
              <>
                {" "}
                · follow-up of <Link to={`/tasks/${encodeURIComponent(task.parentTaskId)}`}>parent task</Link>
              </>
            )}
          </p>
        </div>
        <div className="inbox-detail-actions">
          {(task.status === "queued" || task.status === "running") && (
            <button type="button" className="btn" onClick={handleCancel}>
              Cancel
            </button>
          )}
          {task.status === "failed" && (
            <button type="button" className="btn btn-primary" onClick={handleRetry}>
              Retry
            </button>
          )}
        </div>
      </div>

      {task.error && <div className="banner banner-danger">{task.error}</div>}

      {task.status === "waiting_approval" && <DecisionPanel task={task} onResolved={refresh} />}
      {FINISHED.includes(task.status) && <FollowUpPanel task={task} />}

      <div className="two-col">
        <div className="card">
          <h3>Input</h3>
          <pre>{JSON.stringify(task.input, null, 2)}</pre>
        </div>
        <div className="card">
          <h3>Result</h3>
          <pre>{task.result ? JSON.stringify(task.result, null, 2) : "(none yet)"}</pre>
        </div>
      </div>

      <p className="faint" style={{ marginTop: 12 }}>
        created {formatDateTime(task.createdAt)} · updated {formatDateTime(task.updatedAt)} · attempts {task.attempts}/{task.maxAttempts}
      </p>

      {task.status === "running" && (
        <>
          <h2>Live run events</h2>
          <div className="card" style={{ maxHeight: 240, overflowY: "auto" }}>
            {liveEvents.length === 0 && <p className="empty-state">Waiting for events…</p>}
            {summarizeRunEvents(liveEvents).map((s) => (
              <div key={s.index} className="timeline-item">
                <span className="muted">{s.kind === "agent_response" ? "agent" : s.kind}</span>{" "}
                {s.state === "ACTIVE" ? "… " : s.state === "ERROR" ? "✗ " : ""}
                {s.label}
              </div>
            ))}
          </div>
        </>
      )}

      <h2>Transcript</h2>
      <div className="card" style={{ maxHeight: 400, overflowY: "auto" }}>
        {!transcript || transcript.steps.length === 0 ? (
          <p className="empty-state">No transcript available.</p>
        ) : (
          transcript.steps.map((step) => (
            <div className="timeline-item" key={step.index}>
              <strong>
                {step.source} · {step.type}
              </strong>
              <pre style={{ whiteSpace: "pre-wrap" }}>{step.text}</pre>
            </div>
          ))
        )}
      </div>

      <h2>Audit trail</h2>
      <table>
        <thead>
          <tr>
            <th>At</th>
            <th>Kind</th>
            <th>Data</th>
          </tr>
        </thead>
        <tbody>
          {data?.audit.map((ev) => (
            <tr key={ev.id}>
              <td className="faint">{formatDateTime(ev.at)}</td>
              <td>
                <code>{ev.kind}</code>
              </td>
              <td>
                <pre style={{ margin: 0 }}>{JSON.stringify(ev.data)}</pre>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The agent finished with needs_human, so the task sits in waiting_approval until a human
 * decides: resume it with guidance (the agent runs again with the note in its prompt),
 * mark it done (the human handled it), or cancel it.
 */
function DecisionPanel({ task, onResolved }: { task: Task; onResolved: () => void }) {
  const { notify } = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await action();
      notify(message, "success");
      setNote("");
      onResolved();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  const trimmed = note.trim();
  return (
    <div className="card decision-panel">
      <h3>The agent needs your decision</h3>
      {task.result?.summary && <p>{task.result.summary}</p>}
      <div className="field">
        <label htmlFor="decision-note">Guidance for the agent / resolution note</label>
        <textarea
          id="decision-note"
          rows={4}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. This is an individual asking how to retrieve invoices — treat as a fit and send a first touch."
        />
      </div>
      <div className="inbox-detail-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !trimmed}
          title={trimmed ? undefined : "Write guidance for the agent first"}
          onClick={() => run(() => api.resumeTask(task.id, trimmed), "Task resumed with your guidance.")}
        >
          Resume with guidance
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => run(() => api.completeTask(task.id, trimmed || undefined), "Task marked done.")}
        >
          Mark done
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy}
          onClick={() => run(() => api.cancelTask(task.id), "Task cancelled.")}
        >
          Cancel task
        </button>
      </div>
    </div>
  );
}

/**
 * A finished task can't be reopened, so continuing it creates a child task (same agent and kind,
 * original input) whose prompt carries the reviewer's instruction — e.g. "reply to them with how
 * to download the XML"; any email the agent drafts still lands in the Inbox for approval.
 */
function FollowUpPanel({ task }: { task: Task }) {
  const { notify } = useToast();
  const navigate = useNavigate();
  const [guidance, setGuidance] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmed = guidance.trim();

  async function handleSubmit() {
    setBusy(true);
    try {
      const { task: child } = await api.followUpTask(task.id, trimmed);
      notify("Follow-up task queued.", "success");
      navigate(`/tasks/${encodeURIComponent(child.id)}`);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h3>Continue this task</h3>
      <p className="muted">
        Give the agent a follow-up instruction. It runs as a new task with this task&apos;s input and your note.
      </p>
      <div className="field">
        <label htmlFor="follow-up-guidance">Instruction for the agent</label>
        <textarea
          id="follow-up-guidance"
          rows={3}
          style={{ width: "100%", fontFamily: "inherit" }}
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
          placeholder="e.g. Reply to them with how to download the invoice XML using the free tool."
        />
      </div>
      <button type="button" className="btn btn-primary" disabled={busy || !trimmed} onClick={handleSubmit}>
        Create follow-up task
      </button>
    </div>
  );
}
