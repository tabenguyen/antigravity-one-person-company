import { useMemo, useState, type FormEvent } from "react";
import { ApiError } from "../../api/client.ts";
import { routinesApi, type Routine, type RoutineKind } from "../../api/routines.ts";
import type { Agent, AgentRole, LeadStage } from "../../api/types.ts";
import { roleLabel } from "../../lib/roles.ts";
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
  account_review: "Account review — check customer accounts, flag at-risk ones, schedule check-ins",
  daily_digest: "Daily digest — write a briefing for the owner",
  content_calendar: "Content calendar — plan the week's Facebook posts as drafts",
  comment_poll: "Comment sweep — turn stored Facebook comments into reply tasks",
  custom_task: "Custom task — create a task each run",
};

/** Role an agent needs for each routine kind (the daemon rejects kinds the agent's template doesn't define). null = any role. */
export const KIND_ROLE: Record<RoutineKind, AgentRole | null> = {
  prospecting: "sales-sdr",
  pipeline_review: "sales-sdr",
  account_review: "account-manager",
  daily_digest: "chief-of-staff",
  content_calendar: "fanpage-manager",
  comment_poll: "fanpage-manager",
  custom_task: null,
};

const KIND_ORDER: RoutineKind[] = ["prospecting", "pipeline_review", "account_review", "daily_digest", "content_calendar", "comment_poll", "custom_task"];

/** Agents that can run a routine of this kind (archived agents never). */
export function eligibleAgents(agents: Agent[], kind: RoutineKind): Agent[] {
  const role = KIND_ROLE[kind];
  return agents.filter((a) => a.status !== "archived" && (role === null || a.role === role));
}

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
  const editedAgent = routine ? agents.find((a) => a.id === routine.agentId) : undefined;
  // Creating: the kind picks the agent list. Editing: the agent is fixed, so only kinds its role can run are offered.
  const kindOptions = editedAgent ? KIND_ORDER.filter((k) => KIND_ROLE[k] === null || KIND_ROLE[k] === editedAgent.role) : KIND_ORDER;
  const agentOptions = editing ? agents.filter((a) => a.id === agentId) : eligibleAgents(agents, kind);
  const [name, setName] = useState(routine?.name ?? "");
  const [preset, setPreset] = useState(routine ? presetFor(routine.schedule) : "weekdays-9");
  const [customCron, setCustomCron] = useState(routine?.schedule ?? "0 9 * * 1-5");
  const [timezone, setTimezone] = useState(routine?.timezone ?? DEFAULT_TIMEZONE);
  const [enabled, setEnabled] = useState(routine?.enabled ?? true);

  // kind-specific config
  const [batchSize, setBatchSize] = useState(String(cfg["batchSize"] ?? 5));
  const [stages, setStages] = useState<LeadStage[]>(Array.isArray(cfg["stages"]) ? (cfg["stages"] as LeadStage[]) : ["new"]);
  const [staleAfterDays, setStaleAfterDays] = useState(String(cfg["staleAfterDays"] ?? 7));
  const [maxAccounts, setMaxAccounts] = useState(String(cfg["maxAccounts"] ?? 40));
  const [reviewStaleDays, setReviewStaleDays] = useState(String(cfg["staleAfterDays"] ?? 14));
  const [lookbackHours, setLookbackHours] = useState(String(cfg["lookbackHours"] ?? 24));
  const [postsPerWeek, setPostsPerWeek] = useState(String(cfg["postsPerWeek"] ?? 3));
  const [daysAhead, setDaysAhead] = useState(String(cfg["daysAhead"] ?? 7));
  const [maxPerRun, setMaxPerRun] = useState(String(cfg["maxPerRun"] ?? 20));
  const [taskKind, setTaskKind] = useState(String(cfg["kind"] ?? "sdr.follow_up"));
  const [taskTitle, setTaskTitle] = useState(String(cfg["title"] ?? ""));
  const [taskInput, setTaskInput] = useState(JSON.stringify(cfg["input"] ?? {}, null, 2));

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const schedule = preset === "custom" ? customCron.trim().replace(/\s+/g, " ") : SCHEDULE_PRESETS.find((p) => p.id === preset)!.cron;
  const scheduleCheck = useMemo(() => validateSchedule(schedule, timezone), [schedule, timezone]);
  const upcoming = useMemo(() => (scheduleCheck.ok ? nextRuns(schedule, timezone, new Date(), 3) : []), [scheduleCheck, schedule, timezone]);

  function changeKind(next: RoutineKind) {
    setKind(next);
    if (editing) return;
    const eligible = eligibleAgents(agents, next);
    if (!eligible.some((a) => a.id === agentId)) setAgentId(eligible[0]?.id ?? "");
  }

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
    if (kind === "account_review") {
      const n = Number(maxAccounts);
      if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error("Max accounts must be a whole number from 1 to 200.");
      const d = Number(reviewStaleDays);
      if (!Number.isInteger(d) || d < 1 || d > 180) throw new Error("Stale after must be a whole number of days from 1 to 180.");
      return { maxAccounts: n, staleAfterDays: d };
    }
    if (kind === "daily_digest") {
      const h = Number(lookbackHours);
      if (!Number.isInteger(h) || h < 1 || h > 168) throw new Error("Look-back must be a whole number of hours from 1 to 168.");
      return { lookbackHours: h };
    }
    if (kind === "content_calendar") {
      const n = Number(postsPerWeek);
      if (!Number.isInteger(n) || n < 1 || n > 14) throw new Error("Posts per week must be a whole number from 1 to 14.");
      const d = Number(daysAhead);
      if (!Number.isInteger(d) || d < 1 || d > 30) throw new Error("Planning window must be a whole number of days from 1 to 30.");
      return { postsPerWeek: n, daysAhead: d };
    }
    if (kind === "comment_poll") {
      const n = Number(maxPerRun);
      if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error("Max comments per run must be a whole number from 1 to 100.");
      return { maxPerRun: n };
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
    if (!agentId) {
      const role = KIND_ROLE[kind];
      return setError(role ? `Pick an agent. This kind needs a ${roleLabel(role)} agent — create one on the Agents page first.` : "Pick an agent.");
    }
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
                {agentOptions.length === 0 && <option value="">No eligible agent</option>}
                {agentOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName} ({a.id}){KIND_ROLE[kind] === null ? ` · ${roleLabel(a.role)}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="rt-kind">Kind</label>
              <select id="rt-kind" value={kind} onChange={(e) => changeKind(e.target.value as RoutineKind)}>
                {kindOptions.map((k) => (
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

          {kind === "account_review" && (
            <div className="rt-form-grid">
              <div className="field">
                <label htmlFor="rt-max-accounts">Max accounts per run (1-200)</label>
                <input id="rt-max-accounts" type="number" min={1} max={200} value={maxAccounts} onChange={(e) => setMaxAccounts(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="rt-review-stale">Stale after (days, 1-180)</label>
                <input id="rt-review-stale" type="number" min={1} max={180} value={reviewStaleDays} onChange={(e) => setReviewStaleDays(e.target.value)} />
              </div>
              <span className="faint rt-wide">Reviews customers owned by the chosen Account Manager, quietest first. Nothing is queued when there are no customers.</span>
            </div>
          )}

          {kind === "daily_digest" && (
            <div className="field">
              <label htmlFor="rt-lookback">Look-back window (hours, 1-168)</label>
              <input id="rt-lookback" type="number" min={1} max={168} value={lookbackHours} onChange={(e) => setLookbackHours(e.target.value)} />
              <span className="faint">The Chief of Staff summarizes this much recent activity into a briefing you can read on the Briefings page.</span>
            </div>
          )}

          {kind === "content_calendar" && (
            <div className="rt-form-grid">
              <div className="field">
                <label htmlFor="rt-posts-per-week">Posts to plan (1-14)</label>
                <input id="rt-posts-per-week" type="number" min={1} max={14} value={postsPerWeek} onChange={(e) => setPostsPerWeek(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="rt-days-ahead">Planning window (days, 1-30)</label>
                <input id="rt-days-ahead" type="number" min={1} max={30} value={daysAhead} onChange={(e) => setDaysAhead(e.target.value)} />
              </div>
              <span className="faint rt-wide">
                Creates one draft_post task per planned post (features, releases, tips from the knowledge base); each draft still waits in the Inbox for your approval.
                News posts are never planned automatically: they need an article URL you supply.
              </span>
            </div>
          )}

          {kind === "comment_poll" && (
            <div className="field">
              <label htmlFor="rt-max-per-run">Max comments per run (1-100)</label>
              <input id="rt-max-per-run" type="number" min={1} max={100} value={maxPerRun} onChange={(e) => setMaxPerRun(e.target.value)} />
              <span className="faint">
                The daemon fetches new comments by itself; this sweep gives the chosen Fanpage Manager any stored comment that has no reply task yet.
              </span>
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
