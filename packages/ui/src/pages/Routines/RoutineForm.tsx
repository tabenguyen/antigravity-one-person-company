import { useMemo, useState, type FormEvent } from "react";
import { ApiError } from "../../api/client.ts";
import { routinesApi, type Routine, type RoutineKind } from "../../api/routines.ts";
import type { Agent, LeadStage } from "../../api/types.ts";
import { useToast } from "../../components/Toast.tsx";
import { nextRuns, validateSchedule } from "./cron.ts";

export const DEFAULT_TIMEZONE = "Asia/Ho_Chi_Minh";

export const SCHEDULE_PRESETS: { id: string; label: string; cron: string }[] = [
  { id: "weekdays-9", label: "Weekdays at 09:00", cron: "0 9 * * 1-5" },
  { id: "daily-830", label: "Daily at 08:30", cron: "30 8 * * *" },
  { id: "mondays-9", label: "Mondays at 09:00", cron: "0 9 * * 1" },
  { id: "custom", label: "Custom…", cron: "" },
];

export const KIND_LABELS: Record<RoutineKind, string> = {
  prospecting: "Prospecting — research the next uncontacted leads",
  pipeline_review: "Pipeline review — flag stale leads, schedule follow-ups",
  custom_task: "Custom task — create a task each run",
};

const STAGES: LeadStage[] = ["new", "researching", "contacted", "replied", "qualified", "meeting_booked", "disqualified", "nurture"];

function presetFor(cron: string): string {
  return SCHEDULE_PRESETS.find((p) => p.cron === cron && p.id !== "custom")?.id ?? "custom";
}

/** Next runs formatted in the routine's own timezone. */
export function formatInZone(d: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

export interface RoutineFormProps {
  agents: Agent[];
  /** Present when editing. */
  routine?: Routine;
  onClose: () => void;
  onSaved: () => void;
}

export function RoutineForm({ agents, routine, onClose, onSaved }: RoutineFormProps) {
  const { notify } = useToast();
  const editing = Boolean(routine);
  const cfg = routine?.config ?? {};

  const [agentId, setAgentId] = useState(routine?.agentId ?? agents.find((a) => a.role === "sales-sdr")?.id ?? agents[0]?.id ?? "");
  const [kind, setKind] = useState<RoutineKind>(routine?.kind ?? "prospecting");
  const [name, setName] = useState(routine?.name ?? "");
  const [preset, setPreset] = useState(routine ? presetFor(routine.schedule) : "weekdays-9");
  const [customCron, setCustomCron] = useState(routine?.schedule ?? "0 9 * * 1-5");
  const [timezone, setTimezone] = useState(routine?.timezone ?? DEFAULT_TIMEZONE);
  const [enabled, setEnabled] = useState(routine?.enabled ?? true);

  // kind-specific config
  const [batchSize, setBatchSize] = useState(String(cfg["batchSize"] ?? 5));
  const [stages, setStages] = useState<LeadStage[]>(Array.isArray(cfg["stages"]) ? (cfg["stages"] as LeadStage[]) : ["new"]);
  const [staleAfterDays, setStaleAfterDays] = useState(String(cfg["staleAfterDays"] ?? 7));
  const [taskKind, setTaskKind] = useState(String(cfg["kind"] ?? "sdr.follow_up"));
  const [taskTitle, setTaskTitle] = useState(String(cfg["title"] ?? ""));
  const [taskInput, setTaskInput] = useState(JSON.stringify(cfg["input"] ?? {}, null, 2));

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const schedule = preset === "custom" ? customCron.trim().replace(/\s+/g, " ") : SCHEDULE_PRESETS.find((p) => p.id === preset)!.cron;
  const scheduleCheck = useMemo(() => validateSchedule(schedule, timezone), [schedule, timezone]);
  const upcoming = useMemo(() => (scheduleCheck.ok ? nextRuns(schedule, timezone, new Date(), 3) : []), [scheduleCheck, schedule, timezone]);

  function toggleStage(stage: LeadStage) {
    setStages((prev) => (prev.includes(stage) ? prev.filter((s) => s !== stage) : [...prev, stage]));
  }

  function buildConfig(): Record<string, unknown> {
    if (kind === "prospecting") {
      const n = Number(batchSize);
      if (!Number.isInteger(n) || n < 1 || n > 25) throw new Error("Batch size must be a whole number from 1 to 25.");
      if (stages.length === 0) throw new Error("Pick at least one lead stage to prospect.");
      return { batchSize: n, stages };
    }
    if (kind === "pipeline_review") {
      const d = Number(staleAfterDays);
      if (!Number.isInteger(d) || d < 1 || d > 90) throw new Error("Stale after must be a whole number of days from 1 to 90.");
      return { staleAfterDays: d };
    }
    if (!taskKind.trim()) throw new Error("Task kind is required (e.g. sdr.follow_up).");
    if (!taskTitle.trim()) throw new Error("Task title is required.");
    let input: unknown;
    try {
      input = taskInput.trim() ? JSON.parse(taskInput) : {};
    } catch (err) {
      throw new Error(`Task input must be valid JSON: ${(err as Error).message}`);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Task input must be a JSON object.");
    return { kind: taskKind.trim(), title: taskTitle.trim(), input };
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!agentId) return setError("Pick an agent.");
    if (!name.trim()) return setError("Name is required.");
    if (!scheduleCheck.ok) return setError(scheduleCheck.error);
    let config: Record<string, unknown>;
    try {
      config = buildConfig();
    } catch (err) {
      return setError((err as Error).message);
    }
    setSaving(true);
    try {
      if (routine) {
        await routinesApi.patch(routine.id, { kind, name: name.trim(), schedule, timezone: timezone.trim(), config, enabled });
        notify("Routine updated.", "success");
      } else {
        await routinesApi.create({ agentId, kind, name: name.trim(), schedule, timezone: timezone.trim(), config, enabled });
        notify("Routine created.", "success");
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal rt-modal" role="dialog" aria-modal="true" aria-labelledby="routine-form-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="routine-form-title">{editing ? "Edit routine" : "New routine"}</h2>
        <form onSubmit={handleSubmit}>
          <div className="rt-form-grid">
            <div className="field">
              <label htmlFor="rt-agent">Agent</label>
              <select id="rt-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={editing}>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName} ({a.id})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="rt-kind">Kind</label>
              <select id="rt-kind" value={kind} onChange={(e) => setKind(e.target.value as RoutineKind)}>
                {(Object.keys(KIND_LABELS) as RoutineKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field rt-wide">
              <label htmlFor="rt-name">Name</label>
              <input id="rt-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning prospecting" />
            </div>
            <div className="field">
              <label htmlFor="rt-preset">Schedule</label>
              <select id="rt-preset" value={preset} onChange={(e) => setPreset(e.target.value)}>
                {SCHEDULE_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="rt-tz">Timezone</label>
              <input id="rt-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder={DEFAULT_TIMEZONE} />
            </div>
            {preset === "custom" && (
              <div className="field rt-wide">
                <label htmlFor="rt-cron">Cron expression (minute hour day-of-month month day-of-week)</label>
                <input id="rt-cron" value={customCron} onChange={(e) => setCustomCron(e.target.value)} placeholder="0 9 * * 1-5" spellCheck={false} />
              </div>
            )}
          </div>

          <div className="rt-preview" aria-live="polite">
            {scheduleCheck.ok ? (
              <>
                <strong>Next 3 runs</strong> <span className="faint">({timezone})</span>
                <ol aria-label="Next runs">
                  {upcoming.map((d) => (
                    <li key={d.toISOString()}>{formatInZone(d, timezone)}</li>
                  ))}
                </ol>
              </>
            ) : (
              <span className="form-error" role="alert">
                {scheduleCheck.error}
              </span>
            )}
          </div>

          {kind === "prospecting" && (
            <>
              <div className="field">
                <label htmlFor="rt-batch">Batch size (leads per run, max 25)</label>
                <input id="rt-batch" type="number" min={1} max={25} value={batchSize} onChange={(e) => setBatchSize(e.target.value)} />
              </div>
              <div className="field">
                <label id="rt-stages-label">Lead stages to pick from</label>
                <div className="rt-checks" role="group" aria-labelledby="rt-stages-label">
                  {STAGES.map((s) => (
                    <label key={s}>
                      <input type="checkbox" checked={stages.includes(s)} onChange={() => toggleStage(s)} /> {s}
                    </label>
                  ))}
                </div>
                <span className="faint">Leads already being worked on, opted out, or bounced are always skipped.</span>
              </div>
            </>
          )}

          {kind === "pipeline_review" && (
            <div className="field">
              <label htmlFor="rt-stale">Stale after (days without a reply or scheduled follow-up)</label>
              <input id="rt-stale" type="number" min={1} max={90} value={staleAfterDays} onChange={(e) => setStaleAfterDays(e.target.value)} />
            </div>
          )}

          {kind === "custom_task" && (
            <>
              <div className="rt-form-grid">
                <div className="field">
                  <label htmlFor="rt-task-kind">Task kind</label>
                  <input id="rt-task-kind" value={taskKind} onChange={(e) => setTaskKind(e.target.value)} placeholder="sdr.follow_up" />
                </div>
                <div className="field">
                  <label htmlFor="rt-task-title">Task title</label>
                  <input id="rt-task-title" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} />
                </div>
              </div>
              <div className="field">
                <label htmlFor="rt-task-input">Task input (JSON)</label>
                <textarea id="rt-task-input" rows={4} value={taskInput} onChange={(e) => setTaskInput(e.target.value)} spellCheck={false} />
              </div>
            </>
          )}

          <div className="field">
            <label className="rt-toggle">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
            </label>
          </div>

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Saving…" : editing ? "Save routine" : "Create routine"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
