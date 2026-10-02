import { useState } from "react";
import { api, ApiError } from "../../api/client.ts";
import { useApi } from "../../hooks/useApi.ts";
import { useToast } from "../../components/Toast.tsx";
import { formatDateTime } from "../../lib/time.ts";
import type { MemoryStatus } from "../../api/types.ts";

const TABS: { key: MemoryStatus; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "accepted", label: "Accepted" },
  { key: "rejected", label: "Rejected" },
];

export function MemoryPage() {
  const { notify } = useToast();
  const [tab, setTab] = useState<MemoryStatus>("pending");
  const { data, loading, error, refresh } = useApi(() => api.listMemory({ status: tab }), [tab], ["memory.proposed", "memory.updated"]);

  async function accept(id: string) {
    try {
      await api.acceptMemory(id);
      notify("Memory accepted.", "success");
      refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    }
  }

  async function reject(id: string) {
    try {
      await api.rejectMemory(id);
      notify("Memory rejected.", "success");
      refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    }
  }

  return (
    <div>
      <h1>Memory</h1>
      <p className="muted">Agent-proposed facts and preferences. Accepting makes them available via memory_list to the agent.</p>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={`tab ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {error && <p className="form-error">{error}</p>}

      {!loading && data?.items.length === 0 && <p className="empty-state">Nothing here.</p>}

      <div className="timeline">
        {data?.items.map((item) => (
          <div className="card" key={item.id} style={{ marginBottom: 8 }}>
            <p>{item.content}</p>
            <p className="faint">
              {item.agentId} {item.subject ? `· ${item.subject}` : ""} · {formatDateTime(item.createdAt)}
            </p>
            {tab === "pending" && (
              <div className="inbox-detail-actions">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => accept(item.id)}>
                  Accept
                </button>
                <button type="button" className="btn btn-danger btn-sm" onClick={() => reject(item.id)}>
                  Reject
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
