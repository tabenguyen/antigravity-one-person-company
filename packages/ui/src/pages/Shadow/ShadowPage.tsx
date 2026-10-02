import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError } from "../../api/client.ts";
import { categoryLabel } from "../../api/quality.ts";
import { shadowApi, VERDICT_LABEL, VERDICT_PILL, type ShadowAgentStatus, type ShadowDailyRow, type ShadowRunStatus, type ShadowStartCandidate } from "../../api/shadow.ts";
import { useApi } from "../../hooks/useApi.ts";
import { useToast } from "../../components/Toast.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { roleLabel } from "../../lib/roles.ts";
import { formatDateTime } from "../../lib/time.ts";
import { ageOf, minutes, pct, shortDate } from "./format.ts";
import "../Scorecards/scorecards.css";
import "./shadow.css";

export function ShadowPage() {
  const { notify } = useToast();
  const [params, setParams] = useSearchParams();
  const runId = params.get("run");
  const overview = useApi(() => shadowApi.overview(), [], ["shadow.updated", "outbox.updated"]);
  const picked = useApi(() => (runId ? shadowApi.get(runId).then((r) => r.status) : Promise.resolve(null)), [runId], ["shadow.updated", "outbox.updated"]);
  const [dialog, setDialog] = useState<null | "start" | "end">(null);

  const data = overview.data;
  const status: ShadowRunStatus | null = runId ? picked.data : (data?.active ?? data?.last ?? null);
  const active = data?.active ?? null;

  async function onStarted(s: ShadowRunStatus) {
    setDialog(null);
    setParams({});
    notify(`Shadow run started for ${s.run.agentIds.join(", ")}. Nothing will be sent.`, "success");
    overview.refresh();
  }

  return (
    <div className="shadow-page">
      <div className="page-header">
        <h1>Shadow run</h1>
        <div className="sh-actions">
          {active ? (
            <button type="button" className="btn btn-danger" onClick={() => setDialog("end")}>
              End shadow run
            </button>
          ) : (
            data && (
              <button type="button" className="btn btn-primary" onClick={() => setDialog("start")}>
                Start shadow run
              </button>
            )
          )}
        </div>
      </div>
      <p className="muted">
        A bounded evaluation of your shadow-tier agents on real mail: they draft, you approve, edit or reject in the{" "}
        <Link to="/inbox">Inbox</Link>, and nothing is ever sent. At the end the approve / edit rates decide whether to promote them on{" "}
        <Link to="/scorecards">Scorecards</Link>.
      </p>

      {overview.error && <p className="form-error">{overview.error}</p>}
      {overview.loading && !data && <p className="empty-state">Loading…</p>}

      {data && !status && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>No shadow run yet</h2>
          <p className="muted">
            {data.candidates.length > 0
              ? `Start one to track ${data.candidates.map((c) => c.displayName).join(", ")} over 14 days: approvals, edits, rejections and a verdict per agent.`
              : "There are no shadow-tier SDR / Account Manager agents. Create one on the Agents page (new agents start in shadow tier), then start a run."}
          </p>
        </div>
      )}

      {runId && picked.error && <p className="form-error">{picked.error}</p>}
      {status && <RunView status={status} />}

      {data && data.history.length > 0 && (
        <section className="card" style={{ marginTop: "var(--space-4)" }} aria-label="Past shadow runs">
          <h2 style={{ marginTop: 0 }}>Runs</h2>
          <ul className="sh-history">
            {data.history.map((r) => (
              <li key={r.id}>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setParams(active?.run.id === r.id ? {} : { run: r.id })}>
                  {shortDate(r.startedAt)} · {r.plannedDays} days
                </button>{" "}
                <span className="faint">
                  {r.agentIds.join(", ")} · {r.endedAt ? `ended ${shortDate(r.endedAt)}` : "active"}
                  {r.notes ? ` · ${r.notes}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {dialog === "start" && data && <StartDialog candidates={data.candidates} onCancel={() => setDialog(null)} onStarted={onStarted} />}
      {dialog === "end" && active && (
        <EndDialog
          status={active}
          onCancel={() => setDialog(null)}
          onEnded={() => {
            setDialog(null);
            notify("Shadow run ended. The result stays on this page.", "success");
            overview.refresh();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function RunView({ status }: { status: ShadowRunStatus }) {
  const t = status.totals;
  const pctDone = Math.min(100, Math.round(((status.day - 1 + (status.complete ? 1 : 0)) / status.plannedDays) * 100));
  return (
    <>
      <section className="card sh-hero" aria-label="Shadow run progress">
        <div className="sh-hero-top">
          <div>
            <div className="sh-day">
              Day {status.day} <small>of {status.plannedDays}</small>
            </div>
            <div className="faint">
              {status.active ? (status.complete ? "planned length reached" : `${status.daysRemaining} day${status.daysRemaining === 1 ? "" : "s"} left`) : `ended ${formatDateTime(status.run.endedAt)}`}
              {" · "}started {formatDateTime(status.run.startedAt)} · planned end {formatDateTime(status.endsAt)}
            </div>
          </div>
        </div>
        <div className="sh-progress" role="progressbar" aria-valuemin={0} aria-valuemax={status.plannedDays} aria-valuenow={Math.min(status.day, status.plannedDays)} aria-label="Shadow run progress">
          <span className={`sh-progress-fill ${status.complete ? "sh-complete" : ""}`} style={{ width: `${pctDone}%` }} />
        </div>
        <div className="sh-totals">
          <span>Drafts <strong>{t.drafts}</strong></span>
          <span>Approved unchanged <strong>{t.approvedUnchanged}</strong></span>
          <span>Approved with edits <strong>{t.approvedEdited}</strong></span>
          <span>Rejected <strong>{t.rejected}</strong></span>
        </div>
        {status.run.notes && <p className="muted" style={{ margin: 0 }}>Notes: {status.run.notes}</p>}
      </section>

      {status.active && status.complete && (
        <div className="banner banner-warning" role="status" style={{ marginTop: "var(--space-3)" }}>
          The planned {status.plannedDays} days are over. Review the verdicts below, then end the run and decide on promotion in{" "}
          <Link to="/scorecards">Scorecards</Link>.
        </div>
      )}
      {status.active && t.pending > 0 && (
        <div className="banner banner-shadow" role="status" style={{ marginTop: "var(--space-3)" }}>
          {t.pending} draft{t.pending === 1 ? "" : "s"} waiting for review (oldest {ageOf(t.oldestPendingAt)}). <Link to="/inbox">Open the Inbox →</Link>
        </div>
      )}

      {status.agents.length === 0 && <p className="empty-state">None of this run's agents exist any more.</p>}
      {status.agents.map((a) => (
        <AgentSection key={a.agentId} agent={a} />
      ))}

      <section className="card" style={{ marginTop: "var(--space-4)" }} aria-label="Daily trend">
        <h2 style={{ marginTop: 0 }}>Daily trend — all agents</h2>
        <Trend rows={status.daily} />
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

type Tone = "ok" | "bad" | "none";
const TONE: Record<"met" | "unmet" | "no_data", Tone> = { met: "ok", unmet: "bad", no_data: "none" };

function AgentSection({ agent: a }: { agent: ShadowAgentStatus }) {
  const cats = Object.entries(a.rejectionsByCategory).sort((x, y) => (y[1] ?? 0) - (x[1] ?? 0));
  const maxCat = Math.max(1, ...cats.map(([, n]) => n ?? 0));
  const fmtValue = (code: string, v: number | null) => (v === null ? "n/a" : code === "decided" || code === "compliance" ? String(v) : pct(v));
  return (
    <section className="card sh-agent" aria-label={`Shadow results ${a.agentId}`}>
      <div className="sh-agent-head">
        <h2>{a.displayName}</h2>
        <span className={`pill ${VERDICT_PILL[a.verdict.status]}`}>{VERDICT_LABEL[a.verdict.status]}</span>
        <span className="faint">
          {a.agentId} · {roleLabel(a.role)} · {a.trustTier}
          {a.agentStatus !== "active" ? ` · ${a.agentStatus}` : ""}
        </span>
      </div>
      <div className={`sh-verdict sh-${a.verdict.status}`}>{a.verdict.reason}</div>
      {a.trustTier !== "shadow" && <p className="banner banner-warning">This agent is no longer in shadow tier ({a.trustTier}); its drafts can now be sent.</p>}

      <div className="sh-counts">
        <Count label="Drafts" value={String(a.drafts)} />
        <Count label="Approved unchanged" value={String(a.approvedUnchanged)} />
        <Count label="Approved with edits" value={String(a.approvedEdited)} hint={a.medianEditRatioOfEdited === null ? undefined : `median edit ${pct(a.medianEditRatioOfEdited)}`} />
        <Count label="Rejected" value={String(a.rejected)} />
        <Count label="Waiting for you" value={String(a.pending)} hint={a.pending > 0 ? `oldest ${ageOf(a.oldestPendingAt)}` : undefined} />
        <Count label="Lint errors" value={String(a.lintErrors)} hint={a.lintErrorRate === null ? undefined : pct(a.lintErrorRate)} />
        <Count label="Needs-human escalations" value={String(a.needsHuman)} />
        <Count label="Median time to review" value={minutes(a.medianReviewMinutes)} />
      </div>

      <h3 className="sh-criteria-title">Progress against the promotion bar</h3>
      <div className="sc-metrics" style={{ marginTop: 0 }}>
        {a.criteria.map((k) => (
          <div key={k.code} className={`sc-metric sc-${TONE[k.status]}`} data-tone={TONE[k.status]} aria-label={k.label}>
            <div className="stat-label">{k.label}</div>
            <div className="stat-value">{fmtValue(k.code, k.value)}</div>
            <div className="sc-threshold">
              need {k.op === ">=" ? "≥" : "≤"} {fmtValue(k.code, k.target)}
            </div>
          </div>
        ))}
      </div>
      {a.promotionEligible && (
        <p className="sc-eligible">
          Every promotion criterion is met. <Link to="/scorecards">Promote on Scorecards →</Link>
        </p>
      )}

      <div className="sh-agents-lower">
        <div className="sc-reject" aria-label="Rejection reasons">
          <h3>Rejection reasons</h3>
          {cats.length === 0 ? (
            <p className="faint">No rejections yet.</p>
          ) : (
            <ul className="sc-bars">
              {cats.map(([cat, n]) => (
                <li key={cat}>
                  <span className="sc-bar-label">{categoryLabel(cat)}</span>
                  <span className="sc-bar-track">
                    <span className="sc-bar-fill" style={{ width: `${((n ?? 0) / maxCat) * 100}%` }} />
                  </span>
                  <span className="sc-bar-count">{n}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div aria-label={`Daily trend ${a.agentId}`}>
          <h3>Daily trend</h3>
          <Trend rows={a.daily} />
        </div>
      </div>
    </section>
  );
}

function Count({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="sh-count" aria-label={label}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="faint">{hint}</div>}
    </div>
  );
}

/** One row per day: stacked bar of the day's decisions (approved / edited / rejected) plus the numbers. Drafts = created that day. */
function Trend({ rows }: { rows: ShadowDailyRow[] }) {
  const max = Math.max(1, ...rows.map((r) => r.approvedUnchanged + r.approvedEdited + r.rejected));
  const last = rows.length;
  return (
    <>
      <p className="sh-legend">
        <span><i className="sh-seg-ok" />approved</span>
        <span><i className="sh-seg-edit" />approved with edits</span>
        <span><i className="sh-seg-rej" />rejected</span>
      </p>
      <ul className="sh-trend">
        <li className="sh-trend-head" aria-hidden="true">
          <span>Day</span>
          <span />
          <span className="num">Drafts</span>
          <span className="num">OK</span>
          <span className="num">Edit</span>
          <span className="num">Rej</span>
        </li>
        {rows.map((r) => (
          <li key={r.day} className={r.day === last ? "sh-today" : undefined}>
            <span title={formatDateTime(r.startAt)}>
              {r.day} <span className="faint">{shortDate(r.startAt)}</span>
            </span>
            <span className="sh-stack" aria-hidden="true">
              <span className="sh-seg-ok" style={{ width: `${(r.approvedUnchanged / max) * 100}%` }} />
              <span className="sh-seg-edit" style={{ width: `${(r.approvedEdited / max) * 100}%` }} />
              <span className="sh-seg-rej" style={{ width: `${(r.rejected / max) * 100}%` }} />
            </span>
            <span className="num">{r.drafts}</span>
            <span className="num">{r.approvedUnchanged}</span>
            <span className="num">{r.approvedEdited}</span>
            <span className="num">{r.rejected}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------

function StartDialog({ candidates, onCancel, onStarted }: { candidates: ShadowStartCandidate[]; onCancel: () => void; onStarted: (s: ShadowRunStatus) => void }) {
  const { notify } = useToast();
  const [days, setDays] = useState("14");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(candidates.map((c) => c.agentId)));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const chosen = useMemo(() => candidates.filter((c) => picked.has(c.agentId)), [candidates, picked]);

  async function start() {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 90) return notify("Length must be a whole number of days between 1 and 90.", "error");
    if (chosen.length === 0) return notify("Pick at least one shadow-tier agent.", "error");
    if (busy) return;
    setBusy(true);
    try {
      const { status } = await shadowApi.start({ plannedDays: n, agentIds: chosen.map((c) => c.agentId), ...(notes.trim() ? { notes: notes.trim() } : {}) });
      onStarted(status);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      title="Start a shadow run?"
      description={
        <>
          <p>Day 1 starts now. The agents keep drafting on real mail; approving a draft only records your verdict (held) — nothing is sent while they are in shadow tier.</p>
          {candidates.length === 0 && <p className="form-error">There are no shadow-tier SDR / Account Manager agents to evaluate.</p>}
        </>
      }
      confirmLabel={busy ? "Starting…" : "Start shadow run"}
      onConfirm={() => void start()}
      onCancel={onCancel}
    >
      <div className="field">
        <label htmlFor="shadow-days">Length (days)</label>
        <input id="shadow-days" type="number" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} />
      </div>
      {candidates.length > 0 && (
        <fieldset className="sh-agent-pick" style={{ border: 0, padding: 0 }}>
          <legend className="stat-label">Agents to evaluate</legend>
          {candidates.map((c) => (
            <label key={c.agentId}>
              <input
                type="checkbox"
                checked={picked.has(c.agentId)}
                onChange={(e) =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(c.agentId);
                    else next.delete(c.agentId);
                    return next;
                  })
                }
              />
              {c.displayName} <span className="faint">{c.agentId} · {roleLabel(c.role)}</span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="field">
        <label htmlFor="shadow-notes">Notes (optional)</label>
        <textarea id="shadow-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. mailbox sdr@…, 30 leads/week" />
      </div>
    </ConfirmDialog>
  );
}

function EndDialog({ status, onCancel, onEnded }: { status: ShadowRunStatus; onCancel: () => void; onEnded: () => void }) {
  const { notify } = useToast();
  const [notes, setNotes] = useState(status.run.notes ?? "");
  const [busy, setBusy] = useState(false);

  async function end() {
    if (busy) return;
    setBusy(true);
    try {
      await shadowApi.end(status.run.id, notes.trim() ? { notes: notes.trim() } : {});
      onEnded();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      title="End the shadow run?"
      description={
        <>
          <p>
            Ends the evaluation at day {status.day} of {status.plannedDays}. The result stays on this page. It does <strong>not</strong> change any agent's trust tier — promotion is a separate decision on Scorecards.
          </p>
          {status.totals.pending > 0 && <p>{status.totals.pending} draft(s) are still waiting for review; they stay in the Inbox but are no longer tracked as part of a run.</p>}
        </>
      }
      confirmLabel={busy ? "Ending…" : "End shadow run"}
      destructive
      onConfirm={() => void end()}
      onCancel={onCancel}
    >
      <div className="field">
        <label htmlFor="shadow-end-notes">Decision / notes (optional)</label>
        <textarea id="shadow-end-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. promote sdr-01, keep am-01 in shadow another week" />
      </div>
    </ConfirmDialog>
  );
}
