import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../api/client.ts";
import { useApi } from "../../hooks/useApi.ts";
import { useToast } from "../../components/Toast.tsx";
import { relativeAge } from "../../lib/time.ts";
import type { Task, TaskStatus } from "../../api/types.ts";
import { NewTaskForm } from "./NewTaskForm.tsx";

const STATUSES: TaskStatus[] = ["queued", "running", "waiting_approval", "waiting_external", "done", "failed", "cancelled"];

export function TasksPage() {
  const { notify } = useToast();
  const [agentId, setAgentId] = useState("");
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "">("");
  const [showNewTask, setShowNewTask] = useState(false);

  const { data: agentsData } = useApi(() => api.listAgents(), []);
  const { data, loading, error, refresh } = useApi(
    () => api.listTasks({ agentId: agentId || undefined, status: statusFilter ? [statusFilter] : undefined, limit: 100 }),
    [agentId, statusFilter],
    ["task.transition", "task.created"],
  );

  async function handleCancel(id: string) {
    try {
      await api.cancelTask(id);
      notify("Task cancelled.", "success");
      refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    }
  }

  async function handleRetry(id: string) {
    try {
      await api.retryTask(id);
      notify("Task queued for retry.", "success");
      refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Tasks</h1>
        <button type="button" className="btn btn-primary" onClick={() => setShowNewTask(true)}>
          New task
        </button>
      </div>

      <div className="filter-bar">
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Filter by agent">
          <option value="">All agents</option>
          {agentsData?.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName}
            </option>
          ))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as TaskStatus | "")} aria-label="Filter by status">
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="form-error">{error}</p>}

      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Agent</th>
            <th>Kind</th>
            <th>Status</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {data?.tasks.map((t) => (
            <TaskRow key={t.id} task={t} onCancel={handleCancel} onRetry={handleRetry} />
          ))}
          {!loading && data?.tasks.length === 0 && (
            <tr>
              <td colSpan={6} className="empty-state">
                No tasks match these filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {showNewTask && (
        <NewTaskForm
          agents={agentsData?.agents ?? []}
          onClose={() => setShowNewTask(false)}
          onCreated={() => {
            setShowNewTask(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function TaskRow({ task, onCancel, onRetry }: { task: Task; onCancel: (id: string) => void; onRetry: (id: string) => void }) {
  return (
    <tr>
      <td>
        <Link to={`/tasks/${task.id}`}>{task.title}</Link>
      </td>
      <td>{task.agentId}</td>
      <td>
        <code>{task.kind}</code>
      </td>
      <td>
        <span className="chip">{task.status}</span>
      </td>
      <td className="faint">{relativeAge(task.createdAt)}</td>
      <td>
        {(task.status === "queued" || task.status === "running") && (
          <button type="button" className="btn btn-sm" onClick={() => onCancel(task.id)}>
            Cancel
          </button>
        )}
        {task.status === "failed" && (
          <button type="button" className="btn btn-sm" onClick={() => onRetry(task.id)}>
            Retry
          </button>
        )}
      </td>
    </tr>
  );
}
