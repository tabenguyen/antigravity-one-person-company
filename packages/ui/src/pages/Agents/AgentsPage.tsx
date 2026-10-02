import { useState } from "react";
import { api, ApiError } from "../../api/client.ts";
import { useApi } from "../../hooks/useApi.ts";
import { useToast } from "../../components/Toast.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import type { Agent, AgentRole, TrustTier } from "../../api/types.ts";
import { CreateAgentForm } from "./CreateAgentForm.tsx";

const ROLES: AgentRole[] = ["sales-sdr", "account-manager", "chief-of-staff"];
const TIERS: TrustTier[] = ["shadow", "assisted", "autonomous"];

export function AgentsPage() {
  const { notify } = useToast();
  const { data, error, refresh } = useApi(() => api.listAgents(), [], ["agent.created", "agent.updated"]);
  const [showCreate, setShowCreate] = useState(false);
  const [tierChange, setTierChange] = useState<{ agent: Agent; next: TrustTier } | null>(null);

  async function togglePause(agent: Agent) {
    try {
      await api.patchAgent(agent.id, { status: agent.status === "paused" ? "active" : "paused" });
      notify(agent.status === "paused" ? "Agent resumed." : "Agent paused.", "success");
      refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    }
  }

  async function changeModel(agent: Agent, model: string) {
    if (!model || model === agent.model) return;
    try {
      await api.patchAgent(agent.id, { model });
      notify("Model updated.", "success");
      refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    }
  }

  function requestTierChange(agent: Agent, next: TrustTier) {
    if (next === agent.trustTier) return;
    if (next === "autonomous") {
      setTierChange({ agent, next });
      return;
    }
    void applyTierChange(agent, next);
  }

  async function applyTierChange(agent: Agent, next: TrustTier) {
    try {
      await api.patchAgent(agent.id, { trustTier: next });
      notify(`Trust tier set to ${next}.`, "success");
      refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    } finally {
      setTierChange(null);
    }
  }

  async function rerender(agent: Agent) {
    try {
      const { files } = await api.rerenderAgent(agent.id);
      notify(`Re-rendered ${files.length} file(s).`, "success");
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Agents</h1>
        <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
          New agent
        </button>
      </div>

      {error && <p className="form-error">{error}</p>}

      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Role</th>
            <th>Status</th>
            <th>Trust tier</th>
            <th>Model</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {data?.agents.map((agent) => (
            <tr key={agent.id}>
              <td>
                <strong>{agent.displayName}</strong>
                <br />
                <span className="faint">{agent.id}</span>
              </td>
              <td>{agent.role}</td>
              <td>
                <span className={`chip ${agent.status === "active" ? "" : "faint"}`}>{agent.status}</span>
              </td>
              <td>
                <select value={agent.trustTier} onChange={(e) => requestTierChange(agent, e.target.value as TrustTier)}>
                  {TIERS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  defaultValue={agent.model}
                  onBlur={(e) => changeModel(agent, e.target.value.trim())}
                  style={{ width: 180 }}
                  aria-label={`Model for ${agent.displayName}`}
                />
              </td>
              <td style={{ whiteSpace: "nowrap" }}>
                <button type="button" className="btn btn-sm" onClick={() => togglePause(agent)}>
                  {agent.status === "paused" ? "Resume" : "Pause"}
                </button>{" "}
                <button type="button" className="btn btn-sm" onClick={() => rerender(agent)}>
                  Rerender
                </button>
              </td>
            </tr>
          ))}
          {data && data.agents.length === 0 && (
            <tr>
              <td colSpan={6} className="empty-state">
                No agents yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {showCreate && (
        <CreateAgentForm
          roles={ROLES}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            refresh();
          }}
        />
      )}

      {tierChange && (
        <ConfirmDialog
          title="Promote to autonomous?"
          description={
            <>
              <strong>{tierChange.agent.displayName}</strong> will be able to send outbound email without a human
              approving each draft first, within outbox policy limits (rate limits, quiet hours, new-recipient and
              money-related actions still require approval). Make sure its approval/edit rate has been good in shadow
              and assisted tiers before doing this.
            </>
          }
          confirmLabel="Promote to autonomous"
          onConfirm={() => applyTierChange(tierChange.agent, tierChange.next)}
          onCancel={() => setTierChange(null)}
        />
      )}
    </div>
  );
}
