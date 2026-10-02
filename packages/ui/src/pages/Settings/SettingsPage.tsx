import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../api/client.ts";
import { useApi } from "../../hooks/useApi.ts";
import { useToast } from "../../components/Toast.tsx";
import type { Agent, AgentRole } from "../../api/types.ts";
import { roleLabel } from "../../lib/roles.ts";

export function SettingsPage() {
  const { notify } = useToast();
  const { data, error, refresh } = useApi(() => api.getSettings(), [], ["settings.changed"]);
  const { data: agentsData } = useApi(() => api.listAgents(), []);

  const [timezone, setTimezone] = useState("");
  const [quietStart, setQuietStart] = useState("21");
  const [quietEnd, setQuietEnd] = useState("8");
  const [quietEnabled, setQuietEnabled] = useState(true);
  const [sendRate, setSendRate] = useState("30");
  const [windowSize, setWindowSize] = useState("50");
  const [maxBounceRate, setMaxBounceRate] = useState("5");
  const [defaultSdrAgentId, setDefaultSdrAgentId] = useState("");
  const [defaultAmAgentId, setDefaultAmAgentId] = useState("");
  const [defaultCosAgentId, setDefaultCosAgentId] = useState("");
  const [autonomousRequiresPriorApproval, setAutonomousRequiresPriorApproval] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The form renders only once its fields hold the loaded settings, so an early Save can't submit the defaults.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!data) return;
    const s = data.settings;
    setTimezone(s.quietHours?.timezone ?? "UTC");
    setQuietStart(String(s.quietHours?.startHour ?? 21));
    setQuietEnd(String(s.quietHours?.endHour ?? 8));
    setQuietEnabled(s.quietHours !== null);
    setSendRate(String(s.sendRatePerHour));
    setWindowSize(String(s.autoTrip.windowSize));
    setMaxBounceRate(String(Math.round(s.autoTrip.maxBounceRate * 100)));
    setDefaultSdrAgentId(s.defaultSdrAgentId ?? "");
    setDefaultAmAgentId(s.defaultAmAgentId ?? "");
    setDefaultCosAgentId(s.defaultCosAgentId ?? "");
    setAutonomousRequiresPriorApproval(s.autonomousRequiresPriorApproval);
    setLoaded(true);
  }, [data]);

  function validate(): string | null {
    const startN = Number(quietStart);
    const endN = Number(quietEnd);
    if (quietEnabled && (!Number.isInteger(startN) || startN < 0 || startN > 23)) return "Quiet-hours start must be 0-23.";
    if (quietEnabled && (!Number.isInteger(endN) || endN < 0 || endN > 23)) return "Quiet-hours end must be 0-23.";
    if (quietEnabled && !timezone.trim()) return "Timezone is required when quiet hours are enabled.";
    const rate = Number(sendRate);
    if (!Number.isInteger(rate) || rate <= 0) return "Send rate must be a positive integer.";
    const window = Number(windowSize);
    if (!Number.isInteger(window) || window <= 0) return "Auto-trip window size must be a positive integer.";
    const bounce = Number(maxBounceRate);
    if (Number.isNaN(bounce) || bounce < 0 || bounce > 100) return "Max bounce rate must be between 0 and 100.";
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const err = validate();
    if (err) {
      setFormError(err);
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      await api.updateSettings({
        quietHours: quietEnabled ? { startHour: Number(quietStart), endHour: Number(quietEnd), timezone: timezone.trim() } : null,
        sendRatePerHour: Number(sendRate),
        autoTrip: { windowSize: Number(windowSize), maxBounceRate: Number(maxBounceRate) / 100 },
        defaultSdrAgentId: defaultSdrAgentId || null,
        defaultAmAgentId: defaultAmAgentId || null,
        defaultCosAgentId: defaultCosAgentId || null,
        autonomousRequiresPriorApproval,
      });
      notify("Settings saved.", "success");
      refresh();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (error) return <p className="form-error">{error}</p>;
  if (!data || !loaded) return <p className="empty-state">Loading…</p>;

  return (
    <div>
      <h1>Settings</h1>
      <p className="muted">
        The outbound kill switch itself lives on the <Link to="/dashboard">Dashboard</Link>, since it needs a confirm step.
      </p>

      <form onSubmit={handleSubmit} className="card" style={{ maxWidth: 560 }}>
        <h2>Quiet hours</h2>
        <div className="field">
          <label>
            <input type="checkbox" checked={quietEnabled} onChange={(e) => setQuietEnabled(e.target.checked)} /> Enable quiet hours
          </label>
        </div>
        {quietEnabled && (
          <>
            <div className="form-row">
              <div className="field">
                <label htmlFor="quiet-start">Start hour (local)</label>
                <input id="quiet-start" type="number" min={0} max={23} value={quietStart} onChange={(e) => setQuietStart(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="quiet-end">End hour (local)</label>
                <input id="quiet-end" type="number" min={0} max={23} value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="quiet-tz">Timezone</label>
              <input id="quiet-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Asia/Ho_Chi_Minh" />
            </div>
          </>
        )}

        <h2>Rate limits</h2>
        <div className="field">
          <label htmlFor="send-rate">Max sends per hour (all agents)</label>
          <input id="send-rate" type="number" min={1} value={sendRate} onChange={(e) => setSendRate(e.target.value)} />
        </div>

        <h2>Auto-trip kill switch</h2>
        <div className="form-row">
          <div className="field">
            <label htmlFor="window-size">Window size (sends)</label>
            <input id="window-size" type="number" min={1} value={windowSize} onChange={(e) => setWindowSize(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="max-bounce">Max bounce/complaint rate (%)</label>
            <input id="max-bounce" type="number" min={0} max={100} value={maxBounceRate} onChange={(e) => setMaxBounceRate(e.target.value)} />
          </div>
        </div>

        <h2>Routing &amp; autonomy</h2>
        <div className="field">
          <label htmlFor="default-sdr">Default SDR agent (new inbound leads)</label>
          <select id="default-sdr" value={defaultSdrAgentId} onChange={(e) => setDefaultSdrAgentId(e.target.value)}>
            <option value="">(none)</option>
            {agentsData?.agents
              .filter((a) => a.role === "sales-sdr")
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
          </select>
        </div>
        <RoleAgentSelect
          id="default-am"
          label="Default Account Manager (customers after a handoff)"
          hint="Receives contacts handed off from the SDR and answers customer messages. Required for the “Hand off to Account Manager” button."
          role="account-manager"
          value={defaultAmAgentId}
          onChange={setDefaultAmAgentId}
          agents={agentsData?.agents}
        />
        <RoleAgentSelect
          id="default-cos"
          label="Default Chief of Staff (triage + daily briefing)"
          hint="Triages inbound mail no other agent owns. Without one, unroutable mail stays in Inbound."
          role="chief-of-staff"
          value={defaultCosAgentId}
          onChange={setDefaultCosAgentId}
          agents={agentsData?.agents}
        />
        <div className="field">
          <label>
            <input
              type="checkbox"
              checked={autonomousRequiresPriorApproval}
              onChange={(e) => setAutonomousRequiresPriorApproval(e.target.checked)}
            />{" "}
            Autonomous agents may only auto-send to contacts who already received a human-approved email
          </label>
        </div>

        {formError && <p className="form-error">{formError}</p>}
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </button>
      </form>
    </div>
  );
}

/** Select limited to active agents of one role, plus "(none)". A saved value that is no longer eligible stays visible so it can be fixed. */
function RoleAgentSelect({
  id,
  label,
  hint,
  role,
  value,
  onChange,
  agents,
}: {
  id: string;
  label: string;
  hint: string;
  role: AgentRole;
  value: string;
  onChange: (v: string) => void;
  agents: Agent[] | undefined;
}) {
  const eligible = (agents ?? []).filter((a) => a.role === role && a.status === "active");
  const stale = value && !eligible.some((a) => a.id === value);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">(none)</option>
        {stale && <option value={value}>{value} (not an active {roleLabel(role)})</option>}
        {eligible.map((a) => (
          <option key={a.id} value={a.id}>
            {a.displayName} ({a.id})
          </option>
        ))}
      </select>
      {eligible.length === 0 && !stale && <span className="faint">No active {roleLabel(role)} agent yet — create one on the Agents page.</span>}
      <span className="faint">{hint}</span>
    </div>
  );
}
