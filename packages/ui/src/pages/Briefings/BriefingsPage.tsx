import { useMemo, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../api/client.ts";
import { coordinationApi, type Briefing } from "../../api/coordination.ts";
import { routinesApi } from "../../api/routines.ts";
import { useApi } from "../../hooks/useApi.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { formatDateTime, relativeAge } from "../../lib/time.ts";
import "./briefings.css";

const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

/** "Oct 1, 09:00 → Oct 2, 09:00" (browser locale). */
export function formatPeriod(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return `${start} → ${end}`;
  return `${shortDate.format(s)} → ${shortDate.format(e)}`;
}

export function BriefingsPage() {
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  const { data, loading, error } = useApi(() => coordinationApi.listBriefings({ limit: 100 }), [], ["briefing.created"]);
  const { data: agentsData } = useApi(() => api.listAgents(), [], ["agent.created", "agent.updated"]);
  const agentName = useMemo(() => new Map((agentsData?.agents ?? []).map((a) => [a.id, a.displayName])), [agentsData]);

  const briefings = data?.briefings ?? [];
  const selected: Briefing | undefined = briefings.find((b) => b.id === routeId) ?? briefings[0];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Briefings</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Daily digests written by your Chief of Staff: what happened, what needs you, and the risks.
          </p>
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}
      {loading && !data && <p className="empty-state">Loading…</p>}

      {data && briefings.length === 0 && <EmptyState />}

      {briefings.length > 0 && (
        <div className="briefings-layout">
          <div className="inbox-list briefings-list" role="list" aria-label="Briefings">
            {briefings.map((b) => (
              <button
                type="button"
                role="listitem"
                key={b.id}
                className={`inbox-row ${selected?.id === b.id ? "selected" : ""}`}
                onClick={() => navigate(`/briefings/${encodeURIComponent(b.id)}`)}
              >
                <div className="inbox-row-top">
                  <span>{formatPeriod(b.periodStart, b.periodEnd)}</span>
                </div>
                <div className="inbox-row-subject">{agentName.get(b.agentId) ?? b.agentId}</div>
                <div className="inbox-row-meta">
                  <span>created {relativeAge(b.createdAt)}</span>
                </div>
              </button>
            ))}
          </div>

          {selected && (
            <article className="inbox-detail briefing-detail" aria-label="Briefing">
              <header>
                <h2 style={{ margin: 0 }}>{formatPeriod(selected.periodStart, selected.periodEnd)}</h2>
                <p className="faint" style={{ margin: "4px 0 0" }}>
                  by {agentName.get(selected.agentId) ?? selected.agentId} · created {formatDateTime(selected.createdAt)} ·{" "}
                  <Link to={`/tasks/${encodeURIComponent(selected.taskId)}`}>source task</Link>
                </p>
              </header>
              <Markdown source={selected.markdown} />
            </article>
          )}
        </div>
      )}
    </div>
  );
}

/** First-run guidance, with the steps that are already done ticked off. */
function EmptyState() {
  const { data: agentsData } = useApi(() => api.listAgents(), []);
  const { data: settingsData } = useApi(() => api.getSettings(), []);
  const { data: routinesData } = useApi(() => routinesApi.list(), []);

  const cos = (agentsData?.agents ?? []).filter((a) => a.role === "chief-of-staff" && a.status !== "archived");
  const digest = (routinesData?.routines ?? []).filter((r) => r.kind === "daily_digest");
  const steps: { done: boolean; node: ReactNode }[] = [
    {
      done: cos.length > 0,
      node: (
        <>
          Create a <strong>Chief of Staff</strong> agent on the <Link to="/agents">Agents</Link> page.
        </>
      ),
    },
    {
      done: Boolean(settingsData?.settings.defaultCosAgentId),
      node: (
        <>
          Optional: make it the default Chief of Staff in <Link to="/settings">Settings</Link> so it also triages inbound mail nobody else owns.
        </>
      ),
    },
    {
      done: digest.length > 0,
      node: (
        <>
          On <Link to="/routines">Routines</Link>, create a routine of kind <code>daily_digest</code> for that agent (for example daily at 08:30). Use{" "}
          <em>Run now</em> to get the first briefing right away.
        </>
      ),
    },
  ];

  return (
    <div className="card briefings-empty">
      <h3>No briefings yet</h3>
      <p className="muted">
        A briefing is written each time a Chief of Staff finishes a <code>daily_digest</code> routine run. Set it up in three steps:
      </p>
      <ol className="briefings-steps">
        {steps.map((s, i) => (
          <li key={i} className={s.done ? "done" : ""}>
            <span className="briefings-tick" aria-label={s.done ? "done" : "to do"}>
              {s.done ? "✓" : i + 1}
            </span>
            <span>{s.node}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
