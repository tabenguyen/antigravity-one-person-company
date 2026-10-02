import { useState } from "react";
import { coordinationApi, type KpiReport } from "../../api/coordination.ts";
import { useApi } from "../../hooks/useApi.ts";
import { roleLabel } from "../../lib/roles.ts";

const WINDOWS = [7, 30] as const;

/** Counts are real numbers (0 is data); rates and medians are null when there is nothing to divide, shown as "—". */
export function fmtCount(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString();
}
export function fmtPct(r: number | null | undefined): string {
  return r === null || r === undefined ? "—" : `${Math.round(r * 100)}%`;
}
export function fmtMinutes(m: number | null | undefined): string {
  if (m === null || m === undefined) return "—";
  if (m < 1) return "<1 min";
  if (m < 90) return `${Math.round(m)} min`;
  const h = m / 60;
  return h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`;
}

interface Kpi {
  label: string;
  value: string;
  hint?: string;
}

function KpiGroup({ title, agents, kpis }: { title: string; agents?: number; kpis: Kpi[] }) {
  return (
    <section className="kpi-group" aria-label={title}>
      <h3>
        {title}
        {agents !== undefined && (
          <span className="faint kpi-agents">
            {" "}
            · {agents} agent{agents === 1 ? "" : "s"}
          </span>
        )}
      </h3>
      <div className="kpi-grid">
        {kpis.map((k) => (
          <div className="card kpi-card" key={k.label}>
            <div className="stat-label">{k.label}</div>
            <div className="stat-value">{k.value}</div>
            {k.hint && <div className="faint kpi-hint">{k.hint}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}

export function KpiGroups({ report }: { report: KpiReport }) {
  const { roles, common } = report;
  const sdr = roles["sales-sdr"];
  const am = roles["account-manager"];
  const cos = roles["chief-of-staff"];
  return (
    <>
      {sdr.agents > 0 && (
        <KpiGroup
          title={roleLabel("sales-sdr")}
          agents={sdr.agents}
          kpis={[
            { label: "Leads researched", value: fmtCount(sdr.leadsResearched) },
            { label: "First touches drafted", value: fmtCount(sdr.firstTouchDrafted) },
            { label: "Emails sent", value: fmtCount(sdr.emailsSent) },
            { label: "Replies", value: fmtCount(sdr.replies) },
            { label: "Reply rate", value: fmtPct(sdr.replyRate), hint: sdr.replyRate === null ? "nothing sent yet" : "replies / emails sent" },
            { label: "Qualified", value: fmtCount(sdr.qualified) },
            { label: "Meetings booked", value: fmtCount(sdr.meetingsBooked) },
            { label: "Handoffs to AM", value: fmtCount(sdr.handoffs) },
          ]}
        />
      )}
      {am.agents > 0 && (
        <KpiGroup
          title={roleLabel("account-manager")}
          agents={am.agents}
          kpis={[
            { label: "Accounts", value: fmtCount(am.accounts), hint: "customers right now" },
            { label: "Messages handled", value: fmtCount(am.messagesHandled) },
            {
              label: "Median first response",
              value: fmtMinutes(am.medianFirstResponseMinutes),
              hint: am.medianFirstResponseMinutes === null ? "no reply sent yet" : "message to sent answer",
            },
            { label: "Escalations", value: fmtCount(am.escalations), hint: "handed to a human" },
            { label: "Check-ins drafted", value: fmtCount(am.checkInsDrafted) },
            { label: "Churned", value: fmtCount(am.churned) },
          ]}
        />
      )}
      {cos.agents > 0 && (
        <KpiGroup
          title={roleLabel("chief-of-staff")}
          agents={cos.agents}
          kpis={[
            { label: "Triaged", value: fmtCount(cos.triaged) },
            { label: "Delegated", value: fmtCount(cos.delegated) },
            { label: "Escalated", value: fmtCount(cos.escalated) },
            { label: "Briefings", value: fmtCount(cos.digests) },
          ]}
        />
      )}
      <KpiGroup
        title="All agents"
        kpis={[
          { label: "Tasks done", value: fmtCount(common.tasksDone) },
          { label: "Tasks failed", value: fmtCount(common.tasksFailed) },
          { label: "Needs human", value: fmtCount(common.needsHuman) },
          { label: "Approval rate", value: fmtPct(common.approvalRate), hint: common.approvalRate === null ? "no drafts decided" : undefined },
          { label: "Median edit ratio", value: fmtPct(common.medianEditRatio), hint: common.medianEditRatio === null ? "no drafts approved" : "how much humans rewrite" },
        ]}
      />
    </>
  );
}

export function KpiSection() {
  const [days, setDays] = useState<number>(7);
  const { data, error } = useApi(
    () => coordinationApi.kpis(days),
    [days],
    ["task.transition", "outbox.updated", "contact.handoff", "briefing.created"],
  );

  return (
    <section className="kpi-section" aria-labelledby="kpi-heading">
      <div className="page-header kpi-header">
        <h2 id="kpi-heading" style={{ margin: 0 }}>
          KPIs by role
        </h2>
        <div className="tabs kpi-window" role="group" aria-label="KPI window">
          {WINDOWS.map((d) => (
            <button key={d} type="button" className={`tab ${days === d ? "active" : ""}`} aria-pressed={days === d} onClick={() => setDays(d)}>
              {d} days
            </button>
          ))}
        </div>
      </div>
      {error && <p className="form-error">{error}</p>}
      {data && <KpiGroups report={data} />}
    </section>
  );
}
