import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../../api/client.ts";
import { useApi } from "../../../hooks/useApi.ts";
import { useToast } from "../../../components/Toast.tsx";
import { useWizard } from "./WizardContext.tsx";

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DEFAULT_MODEL = "gemini-3.8-flash-medium";

const TIER_LABEL: Record<string, string> = {
  shadow: "Chế độ thực hành",
  assisted: "Có hỗ trợ (cần duyệt)",
  autonomous: "Tự chủ",
};

/** Step 5: create the Sales SDR agent (in shadow mode) and pick the default SDR for new leads. */
export function AgentStep() {
  const { refreshReadiness } = useWizard();
  const { notify } = useToast();
  const agents = useApi(() => api.listAgents({ role: "sales-sdr" }), [], ["agent.created", "agent.updated"]);
  const settings = useApi(() => api.getSettings(), [], ["settings.changed"]);

  const list = agents.data?.agents ?? [];
  const defaultId = settings.data?.settings.defaultSdrAgentId ?? null;
  const loaded = !!agents.data && !!settings.data;

  const [showForm, setShowForm] = useState(false);
  const [id, setId] = useState("sdr-01");
  const [displayName, setDisplayName] = useState("SDR");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [errors, setErrors] = useState<{ id?: string; displayName?: string; model?: string }>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingDefault, setSettingDefault] = useState<string | null>(null);

  const formVisible = showForm || (loaded && list.length === 0);

  async function setDefault(agentId: string) {
    setSettingDefault(agentId);
    setError(null);
    try {
      await api.updateSettings({ defaultSdrAgentId: agentId });
      settings.refresh();
      refreshReadiness();
      notify(`Đã đặt ${agentId} làm SDR mặc định.`, "success");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSettingDefault(null);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    const found: typeof errors = {};
    if (!SLUG_RE.test(id.trim()) || id.trim().length > 40) found.id = "Mã agent gồm chữ thường, số và dấu gạch ngang, ví dụ sdr-01.";
    if (!displayName.trim()) found.displayName = "Nhập tên hiển thị.";
    if (!model.trim()) found.model = "Nhập model.";
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setCreating(true);
    setError(null);
    try {
      const { agent } = await api.createAgent({
        id: id.trim(),
        role: "sales-sdr",
        displayName: displayName.trim(),
        model: model.trim(),
        trustTier: "shadow",
      });
      notify(`Đã tạo agent ${agent.id}.`, "success");
      setShowForm(false);
      agents.refresh();
      refreshReadiness();
      // The first SDR becomes the one that receives new leads.
      if (!defaultId) await setDefault(agent.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="wz-step-body">
      <h2 className="wz-title">5. Agent SDR</h2>
      <p className="muted">Agent SDR là nhân viên bán hàng AI: soạn email cho khách tiềm năng và trả lời khi khách phản hồi.</p>

      {(agents.error || settings.error) && (
        <p className="form-error" role="alert">
          {agents.error ?? settings.error}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {list.length > 0 && (
        <section className="card wz-card" aria-labelledby="ag-list-h">
          <h3 id="ag-list-h">Agent SDR hiện có</h3>
          <p className="setup-hint">Chọn agent nhận khách tiềm năng mới (SDR mặc định).</p>
          <ul className="wz-agents" role="radiogroup" aria-labelledby="ag-list-h">
            {list.map((a) => (
              <li key={a.id}>
                <label className="wz-agent">
                  <input
                    type="radio"
                    name="default-sdr"
                    checked={defaultId === a.id}
                    disabled={settingDefault !== null}
                    onChange={() => void setDefault(a.id)}
                  />
                  <span>
                    <strong>{a.displayName}</strong> <span className="faint">({a.id})</span>
                    <br />
                    <span className={a.trustTier === "shadow" ? "pill pill-shadow" : "pill pill-neutral"}>{TIER_LABEL[a.trustTier] ?? a.trustTier}</span>{" "}
                    <span className="faint">
                      {a.model} · {a.status}
                    </span>
                    {defaultId === a.id && <span className="pill pill-success wz-suggest">SDR mặc định</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {!formVisible && (
            <button type="button" className="btn btn-sm" onClick={() => setShowForm(true)}>
              Tạo thêm agent SDR
            </button>
          )}
        </section>
      )}

      {formVisible && (
        <section className="card wz-card" aria-labelledby="ag-new-h">
          <h3 id="ag-new-h">Tạo agent SDR</h3>
          <p className="setup-hint wz-note">
            Agent mới chạy ở <strong>chế độ thực hành</strong>: mọi email chỉ là bản nháp để bạn xem, không gửi đi. Khi thấy chất lượng tốt, bạn mới nâng quyền sau.
          </p>
          <form onSubmit={create} noValidate aria-busy={creating}>
            <div className="field">
              <label htmlFor="ag-id">Mã agent</label>
              <input id="ag-id" type="text" value={id} aria-invalid={errors.id ? true : undefined} onChange={(e) => setId(e.target.value)} />
              {errors.id && <p className="form-error">{errors.id}</p>}
            </div>
            <div className="field">
              <label htmlFor="ag-name">Tên hiển thị</label>
              <input id="ag-name" type="text" value={displayName} aria-invalid={errors.displayName ? true : undefined} onChange={(e) => setDisplayName(e.target.value)} />
              {errors.displayName && <p className="form-error">{errors.displayName}</p>}
            </div>
            <div className="field">
              <label htmlFor="ag-model">Model AI</label>
              <input id="ag-model" type="text" value={model} aria-invalid={errors.model ? true : undefined} onChange={(e) => setModel(e.target.value)} />
              {errors.model && <p className="form-error">{errors.model}</p>}
            </div>
            <div className="wz-actions">
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? "Đang tạo…" : "Tạo agent"}
              </button>
              {list.length > 0 && (
                <button type="button" className="btn btn-ghost" onClick={() => setShowForm(false)}>
                  Huỷ
                </button>
              )}
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
