import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../api/client.ts";
import { useToast } from "../../components/Toast.tsx";
import type { AgentRole } from "../../api/types.ts";

export function CreateAgentForm({ roles, onClose, onCreated }: { roles: AgentRole[]; onClose: () => void; onCreated: () => void }) {
  const { notify } = useToast();
  const [id, setId] = useState("");
  const [role, setRole] = useState<AgentRole>(roles[0] ?? "sales-sdr");
  const [displayName, setDisplayName] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      setError("Id must be lowercase letters, numbers and hyphens (e.g. sdr-01).");
      return;
    }
    if (!displayName.trim()) {
      setError("Display name is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.createAgent({ id, role, displayName: displayName.trim(), model: model.trim() || undefined });
      notify("Agent created.", "success");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New agent</h2>
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="agent-id">Id (slug)</label>
            <input id="agent-id" value={id} onChange={(e) => setId(e.target.value)} placeholder="sdr-02" required />
          </div>
          <div className="field">
            <label htmlFor="agent-role">Role</label>
            <select id="agent-role" value={role} onChange={(e) => setRole(e.target.value as AgentRole)}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="agent-display-name">Display name</label>
            <input id="agent-display-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="agent-model">Model (optional, uses role default if blank)</label>
            <input id="agent-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gemini-3.8-flash-medium" />
          </div>
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? "Creating…" : "Create agent"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
