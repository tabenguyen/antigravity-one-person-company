import { Link } from "react-router-dom";
import type { Agent, Task } from "../../api/types.ts";

type Data = Record<string, unknown>;

const isObj = (v: unknown): v is Data => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

const ACTION_TONE: Record<string, { label: string; cls: string }> = {
  delegated: { label: "Delegated", cls: "pill-success" },
  needs_human: { label: "Needs a human", cls: "pill-warning" },
  no_action: { label: "No action", cls: "pill-neutral" },
};
const URGENCY_TONE: Record<string, string> = { high: "pill-danger", normal: "pill-neutral", low: "pill-neutral" };

/**
 * Structured view of the Phase 4 result fields (cos.triage decision; am.* unverifiedClaims, urgency,
 * escalationReason, atRisk). Renders nothing when none are present, so the generic JSON view stays the fallback.
 */
export function TaskInsights({ task, agents }: { task: Task; agents: Agent[] }) {
  const data: Data = isObj(task.result?.data) ? task.result.data : {};
  const cards = [
    task.kind.startsWith("cos.") ? <TriageDecision key="decision" data={data} agents={agents} /> : null,
    task.kind.startsWith("am.") ? <AmNotes key="am" data={data} /> : null,
    task.kind === "am.account_review" ? <AtRisk key="risk" data={data} /> : null,
  ].filter(Boolean);
  if (cards.length === 0) return null;
  return <div className="task-insights">{cards}</div>;
}

function TriageDecision({ data, agents }: { data: Data; agents: Agent[] }) {
  const d = data["decision"];
  if (!isObj(d)) return null;
  const action = str(d["action"]);
  if (!action && !str(d["reason"])) return null;
  const tone = (action && ACTION_TONE[action]) || { label: action ?? "unknown", cls: "pill-neutral" };
  const assignee = str(d["assigneeAgentId"]);
  const assigneeName = assignee ? agents.find((a) => a.id === assignee)?.displayName : undefined;
  const kind = str(d["kind"]);
  const reason = str(d["reason"]);
  return (
    <div className="card" aria-label="Triage decision">
      <h3>Triage decision</h3>
      <dl className="kv">
        <dt>Action</dt>
        <dd>
          <span className={`pill ${tone.cls}`}>{tone.label}</span>
        </dd>
        {assignee && (
          <>
            <dt>Assignee</dt>
            <dd>
              <Link to={`/tasks?agent=${encodeURIComponent(assignee)}`}>{assigneeName ?? assignee}</Link>
              {assigneeName && <span className="faint"> ({assignee})</span>}
            </dd>
          </>
        )}
        {kind && (
          <>
            <dt>Task kind</dt>
            <dd>
              <code>{kind}</code>
            </dd>
          </>
        )}
        {reason && (
          <>
            <dt>Reason</dt>
            <dd>{reason}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function AmNotes({ data }: { data: Data }) {
  const claims = Array.isArray(data["unverifiedClaims"]) ? (data["unverifiedClaims"] as unknown[]) : [];
  const urgency = str(data["urgency"]);
  const escalation = str(data["escalationReason"]);
  if (claims.length === 0 && !urgency && !escalation) return null;
  return (
    <div className="card" aria-label="Account manager notes">
      <h3>Account manager notes</h3>
      <dl className="kv">
        {urgency && (
          <>
            <dt>Urgency</dt>
            <dd>
              <span className={`pill ${URGENCY_TONE[urgency] ?? "pill-neutral"}`}>{urgency}</span>
            </dd>
          </>
        )}
        {escalation && (
          <>
            <dt>Escalation reason</dt>
            <dd>{escalation}</dd>
          </>
        )}
        {claims.length > 0 && (
          <>
            <dt>Unverified claims</dt>
            <dd>
              <p className="faint" style={{ margin: "0 0 4px" }}>
                Promises in the handoff summary the agent did not repeat to the customer. Check them before anyone confirms.
              </p>
              <ul className="claims">
                {claims.map((c, i) => (
                  <li key={i}>{typeof c === "string" ? c : JSON.stringify(c)}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

function AtRisk({ data }: { data: Data }) {
  const rows = (Array.isArray(data["atRisk"]) ? (data["atRisk"] as unknown[]) : []).filter(isObj);
  if (rows.length === 0) return null;
  return (
    <div className="card" aria-label="At-risk accounts">
      <h3>At-risk accounts ({rows.length})</h3>
      <ul className="claims">
        {rows.map((r, i) => {
          const id = str(r["contactId"]);
          return (
            <li key={i}>
              {id ? <Link to={`/contacts/${encodeURIComponent(id)}`}>{id}</Link> : "(unknown contact)"} — {str(r["reason"]) ?? "no reason given"}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
