import { useMemo, useState } from "react";
import { api, ApiError } from "../../api/client.ts";
import { routinesApi, type Routine } from "../../api/routines.ts";
import { useApi } from "../../hooks/useApi.ts";
import { useToast } from "../../components/Toast.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { formatDateTime, relativeAge } from "../../lib/time.ts";
import { describeSchedule } from "./cron.ts";
import { RoutineForm } from "./RoutineForm.tsx";

function relativeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(diff)) return "";
  if (diff <= 0) return "due now";
  const min = Math.round(diff / 60_000);
  if (min < 60) return `in ${Math.max(min, 1)}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `in ${hr}h`;
  return `in ${Math.round(hr / 24)}d`;
}

export function RoutinesSection() {
  const { notify } = useToast();
  const { data, error, refresh } = useApi(() => routinesApi.list(), [], ["routine.ran", "routine.updated"]);
  const { data: agentsData } = useApi(() => api.listAgents(), []);
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const [deleting, setDeleting] = useState<Routine | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const agents = agentsData?.agents ?? [];
  const agentName = useMemo(() => new Map(agents.map((a) => [a.id, a.displayName])), [agents]);

  async function act(id: string, fn: () => Promise<unknown>, success?: string) {
    setBusy(id);
    try {
      await fn();
      if (success) notify(success, "success");
      refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    } finally {
      setBusy(null);
    }
  }

  async function runNow(r: Routine) {
    setBusy(r.id);
    try {
      const { routine } = await routinesApi.run(r.id);
      notify(routine.lastResult ?? "Routine ran.", "success");
      refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rt-section" aria-labelledby="routines-heading">
      <div className="rt-section-head">
        <div>
          <h2 id="routines-heading">Routines</h2>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Recurring work for your agents — e.g. research new leads every weekday morning.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setEditing("new")} disabled={agents.length === 0}>
          New routine
        </button>
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="rt-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Routine</th>
              <th>Agent</th>
              <th>Schedule</th>
              <th>Next run</th>
              <th>Last run</th>
              <th>Enabled</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {data?.routines.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.name}</strong>
                  <span className="rt-sub">{r.kind}</span>
                </td>
                <td>{agentName.get(r.agentId) ?? r.agentId}</td>
                <td title={`${r.schedule} (${r.timezone})`}>
                  {describeSchedule(r.schedule)}
                  <span className="rt-sub">{r.timezone}</span>
                </td>
                <td>
                  {r.enabled && r.nextRunAt ? (
                    <>
                      {formatDateTime(r.nextRunAt)}
                      <span className="rt-sub">{relativeUntil(r.nextRunAt)}</span>
                    </>
                  ) : (
                    <span className="faint">—</span>
                  )}
                </td>
                <td>
                  {r.lastRunAt ? (
                    <>
                      {relativeAge(r.lastRunAt)}
                      <span className="rt-sub rt-result">{r.lastResult}</span>
                    </>
                  ) : r.lastResult ? (
                    <span className="rt-sub rt-result">{r.lastResult}</span>
                  ) : (
                    <span className="faint">never</span>
                  )}
                </td>
                <td>
                  <label className="rt-toggle">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      disabled={busy === r.id}
                      aria-label={`Enable ${r.name}`}
                      onChange={(e) => act(r.id, () => routinesApi.patch(r.id, { enabled: e.target.checked }))}
                    />
                  </label>
                </td>
                <td>
                  <div className="rt-actions">
                    <button type="button" className="btn btn-sm" disabled={busy === r.id} onClick={() => runNow(r)} aria-label={`Run ${r.name} now`}>
                      Run now
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`}>
                      Edit
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => setDeleting(r)} aria-label={`Delete ${r.name}`}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {data && data.routines.length === 0 && (
              <tr>
                <td colSpan={7} className="empty-state">
                  No routines yet. Create one so your SDR prospects automatically.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <RoutineForm
          agents={agents}
          routine={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete routine?"
          description={
            <>
              <strong>{deleting.name}</strong> will stop running. Tasks it already created are not affected.
            </>
          }
          confirmLabel="Delete routine"
          destructive
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const r = deleting;
            setDeleting(null);
            void act(r.id, () => routinesApi.remove(r.id), "Routine deleted.");
          }}
        />
      )}
    </section>
  );
}
