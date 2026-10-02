import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../api/client.ts";
import { useToast } from "../../components/Toast.tsx";
import type { Agent } from "../../api/types.ts";

const KNOWN_KINDS = ["sdr.research_lead", "sdr.first_touch", "sdr.follow_up", "sdr.handle_reply"];

export function NewTaskForm({ agents, onClose, onCreated }: { agents: Agent[]; onClose: () => void; onCreated: () => void }) {
  const { notify } = useToast();
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [kind, setKind] = useState(KNOWN_KINDS[0]!);
  const [customKind, setCustomKind] = useState("");
  const [title, setTitle] = useState("");
  const [input, setInput] = useState("{}");
  const [threadKey, setThreadKey] = useState("");
  const [priority, setPriority] = useState("0");
  const [inputError, setInputError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const effectiveKind = kind === "__custom__" ? customKind.trim() : kind;

  function validateInput(): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(input || "{}");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setInputError("Input must be a JSON object.");
        return null;
      }
      setInputError(null);
      return parsed as Record<string, unknown>;
    } catch {
      setInputError("Input is not valid JSON.");
      return null;
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const parsedInput = validateInput();
    if (parsedInput === null) return;
    if (!agentId || !effectiveKind.trim() || !title.trim()) {
      setSubmitError("Agent, kind and title are required.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.createTask({
        agentId,
        kind: effectiveKind.trim(),
        title: title.trim(),
        input: parsedInput,
        threadKey: threadKey.trim() || undefined,
        priority: priority ? Number(priority) : undefined,
      });
      notify("Task created.", "success");
      onCreated();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <h2>New task</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-row">
            <div className="field">
              <label htmlFor="task-agent">Agent</label>
              <select id="task-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} required>
                <option value="" disabled>
                  Choose an agent
                </option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName} ({a.id})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="task-kind">Kind</label>
              <select id="task-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                {KNOWN_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
                <option value="__custom__">custom…</option>
              </select>
            </div>
          </div>
          {kind === "__custom__" && (
            <div className="field">
              <label htmlFor="task-custom-kind">Custom kind</label>
              <input id="task-custom-kind" value={customKind} onChange={(e) => setCustomKind(e.target.value)} placeholder="e.g. sdr.custom_thing" />
            </div>
          )}
          <div className="field">
            <label htmlFor="task-title">Title</label>
            <input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
          </div>
          <div className="form-row">
            <div className="field">
              <label htmlFor="task-thread-key">Thread key</label>
              <input id="task-thread-key" value={threadKey} onChange={(e) => setThreadKey(e.target.value)} placeholder="contact:jane@acme.com" />
            </div>
            <div className="field">
              <label htmlFor="task-priority">Priority</label>
              <input id="task-priority" type="number" value={priority} onChange={(e) => setPriority(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="task-input">Input (JSON)</label>
            <textarea id="task-input" value={input} onChange={(e) => setInput(e.target.value)} rows={6} onBlur={validateInput} />
            {inputError && <p className="form-error">{inputError}</p>}
          </div>
          {submitError && <p className="form-error">{submitError}</p>}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? "Creating…" : "Create task"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
