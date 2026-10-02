import { Link } from "react-router-dom";
import { useApi } from "../../hooks/useApi.ts";
import { shadowApi, VERDICT_LABEL, VERDICT_PILL } from "../../api/shadow.ts";
import { ageOf } from "./format.ts";
import "./shadow.css";

/** Dashboard card: day N of M and a verdict per agent for the active shadow run (or how to start one). */
export function ShadowCard() {
  const { data, error } = useApi(() => shadowApi.overview(), [], ["shadow.updated", "outbox.updated"]);
  const active = data?.active ?? null;
  const last = data?.last ?? null;

  if (error && !data) {
    return (
      <div className="card shadow-card" aria-label="Shadow run">
        <div className="stat-label">Shadow run</div>
        <p className="muted">Could not load: {error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="card shadow-card" aria-label="Shadow run">
        <div className="stat-label">Shadow run</div>
        <div className="stat-value">…</div>
      </div>
    );
  }

  if (!active) {
    return (
      <div className="card shadow-card" aria-label="Shadow run">
        <div className="stat-label">Shadow run</div>
        <div className="stat-value">{last ? `Ended on day ${last.day} of ${last.plannedDays}` : "Not running"}</div>
        <p className="muted">
          {last
            ? "Results are kept. Start a new run when you want another evaluation period."
            : data.candidates.length > 0
              ? "Agents draft on real mail and you approve or reject — nothing is sent. Measure approve / edit rates over 2 weeks before promoting."
              : "Create a shadow-tier agent first, then start a 2-week evaluation."}
        </p>
        <Link className="btn btn-sm btn-primary" to="/shadow">
          {last ? "View result / start new" : "Start a shadow run"}
        </Link>
      </div>
    );
  }

  const pctDone = Math.min(100, Math.round(((active.day - 1 + (active.complete ? 1 : 0)) / active.plannedDays) * 100));
  const t = active.totals;
  return (
    <div className="card shadow-card" aria-label="Shadow run">
      <div className="shadow-card-head">
        <div className="stat-label">Shadow run</div>
        <span className="faint">{active.complete ? "planned length reached" : `${active.daysRemaining} day${active.daysRemaining === 1 ? "" : "s"} left`}</span>
      </div>
      <div className="stat-value">
        Day {active.day} of {active.plannedDays}
      </div>
      <div className="sh-progress" role="progressbar" aria-valuemin={0} aria-valuemax={active.plannedDays} aria-valuenow={Math.min(active.day, active.plannedDays)} aria-label="Shadow run progress">
        <span className={`sh-progress-fill ${active.complete ? "sh-complete" : ""}`} style={{ width: `${pctDone}%` }} />
      </div>
      <ul className="shadow-card-agents">
        {active.agents.map((a) => (
          <li key={a.agentId}>
            <div className="shadow-card-agent-line">
              <strong>{a.displayName}</strong>
              <span className={`pill ${VERDICT_PILL[a.verdict.status]}`}>{VERDICT_LABEL[a.verdict.status]}</span>
            </div>
            <span className="sh-reason" title={a.verdict.reason}>
              {a.verdict.reason}
            </span>
          </li>
        ))}
      </ul>
      <p className="faint">
        {t.approvedUnchanged + t.approvedEdited} approved ({t.approvedEdited} edited) · {t.rejected} rejected ·{" "}
        {t.pending > 0 ? (
          <Link to="/inbox">
            {t.pending} waiting (oldest {ageOf(t.oldestPendingAt)})
          </Link>
        ) : (
          "nothing waiting"
        )}
      </p>
      <Link to="/shadow">Details →</Link>
    </div>
  );
}
