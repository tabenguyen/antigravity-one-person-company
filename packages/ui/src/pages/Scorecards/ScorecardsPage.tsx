import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError } from "../../api/client.ts";
import { categoryLabel, qualityApi, type AgentScorecard, type PromotionCriteria } from "../../api/quality.ts";
import { useApi } from "../../hooks/useApi.ts";
import { useToast } from "../../components/Toast.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { api } from "../../api/client.ts";
import type { Agent, TrustTier } from "../../api/types.ts";
import "./scorecards.css";

const WINDOWS = [7, 14, 30] as const;

const pct = (x: number | null): string => (x === null ? "n/a" : `${Math.round(x * 1000) / 10}%`);
const minutes = (x: number | null): string => (x === null ? "n/a" : x < 90 ? `${Math.round(x * 10) / 10} min` : `${Math.round(x / 6) / 10} h`);

const TIER_CLASS: Record<TrustTier, string> = { shadow: "pill-shadow", assisted: "pill-warning", autonomous: "pill-success" };

const TIER_CONSEQUENCES: Record<string, string> = {
  assisted:
    "The agent leaves practice mode. Drafts you approve will be sent for real (once outbound is enabled and outside quiet hours). You still review every email first.",
  autonomous:
    "The agent no longer needs review for every email. Drafts are auto-approved and sent according to your autonomous settings (by default only to people you have already approved a send to). Review shifts from before sending to after.",
};

export function ScorecardsPage() {
  const [days, setDays] = useState<number>(14);
  const { data, loading, error, refresh } = useApi(() => qualityApi.scorecards(days), [days], ["agent.updated", "outbox.updated"]);
  const { data: agentsData } = useApi(() => api.listAgents(), []);
  const names = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agentsData?.agents ?? []) map.set(a.id, a);
    return map;
  }, [agentsData]);

  return (
    <div className="scorecards-page">
      <div className="page-header">
        <h1>Scorecards</h1>
        <div className="sc-window" role="group" aria-label="Time window">
          {WINDOWS.map((d) => (
            <button key={d} type="button" className={`btn btn-sm ${days === d ? "btn-primary" : ""}`} aria-pressed={days === d} onClick={() => setDays(d)}>
              {d} days
            </button>
          ))}
        </div>
      </div>
      <p className="muted">
        How well each agent's drafts hold up under human review, and whether the evidence supports giving it more autonomy.
      </p>

      {error && <p className="form-error">{error}</p>}
      {loading && !data && <p className="empty-state">Loading…</p>}

      {data && <CriteriaEditor criteria={data.criteria} onSaved={refresh} />}

      {data && data.scorecards.length === 0 && <p className="empty-state">No agents yet.</p>}
      {data?.scorecards.map((sc) => (
        <ScorecardCard key={sc.agentId} sc={sc} criteria={data.criteria} agent={names.get(sc.agentId) ?? null} onChanged={refresh} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

const CRITERIA_FIELDS: { key: keyof PromotionCriteria; label: string; percent: boolean; hint: string }[] = [
  { key: "minDecided", label: "Minimum decided drafts", percent: false, hint: "Drafts a human approved or rejected in the window" },
  { key: "minApprovalRate", label: "Minimum approval rate (%)", percent: true, hint: "Approved / (approved + rejected)" },
  { key: "maxMedianEditRatio", label: "Maximum median edit ratio (%)", percent: true, hint: "How much humans rewrite approved drafts" },
  { key: "maxComplianceRejections", label: "Maximum compliance rejections", percent: false, hint: "Rejections categorized as compliance" },
  { key: "maxLintErrorsRate", label: "Maximum lint error rate (%)", percent: true, hint: "Drafts that tripped an automatic error check" },
];

function CriteriaEditor({ criteria, onSaved }: { criteria: PromotionCriteria; onSaved: () => void }) {
  const { notify } = useToast();
  const toForm = (c: PromotionCriteria) =>
    Object.fromEntries(CRITERIA_FIELDS.map((f) => [f.key, String(f.percent ? Math.round(c[f.key] * 1000) / 10 : c[f.key])])) as Record<keyof PromotionCriteria, string>;
  const [form, setForm] = useState(() => toForm(criteria));
  const [saving, setSaving] = useState(false);
  useEffect(() => setForm(toForm(criteria)), [criteria]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    const patch: Partial<PromotionCriteria> = {};
    for (const f of CRITERIA_FIELDS) {
      const n = Number(form[f.key]);
      if (form[f.key].trim() === "" || !Number.isFinite(n) || n < 0 || (f.percent && n > 100)) {
        notify(`"${f.label}" must be a valid number${f.percent ? " between 0 and 100" : ""}.`, "error");
        return;
      }
      patch[f.key] = f.percent ? n / 100 : n;
    }
    setSaving(true);
    try {
      await qualityApi.putCriteria(patch);
      notify("Promotion criteria saved.", "success");
      onSaved();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="card sc-criteria">
      <summary>Promotion criteria</summary>
      <p className="muted">An agent can move up a tier only when every criterion is met over the selected window.</p>
      <div className="sc-criteria-grid">
        {CRITERIA_FIELDS.map((f) => (
          <div className="field" key={f.key}>
            <label htmlFor={`crit-${f.key}`}>{f.label}</label>
            <input
              id={`crit-${f.key}`}
              type="number"
              min={0}
              step={f.percent ? 1 : 1}
              value={form[f.key]}
              onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
            />
            <span className="faint">{f.hint}</span>
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save criteria"}
        </button>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------

type Tone = "ok" | "bad" | "none";

function Metric({ label, value, threshold, tone, detail }: { label: string; value: string; threshold?: string; tone: Tone; detail?: string }) {
  return (
    <div className={`sc-metric sc-${tone}`} data-tone={tone} aria-label={label}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {threshold && <div className="sc-threshold">{threshold}</div>}
      {detail && <div className="faint">{detail}</div>}
    </div>
  );
}

function ScorecardCard({ sc, criteria, agent, onChanged }: { sc: AgentScorecard; criteria: PromotionCriteria; agent: Agent | null; onChanged: () => void }) {
  const compliance = sc.rejectionsByCategory.compliance ?? 0;
  const cats = Object.entries(sc.rejectionsByCategory).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  const maxCat = Math.max(1, ...cats.map(([, n]) => n ?? 0));
  const tone = (ok: boolean | null): Tone => (ok === null ? "none" : ok ? "ok" : "bad");

  return (
    <section className="card sc-card" aria-label={`Scorecard ${sc.agentId}`}>
      <div className="sc-card-head">
        <h2>{agent?.displayName ?? sc.agentId}</h2>
        <span className={`pill ${TIER_CLASS[sc.trustTier]}`} aria-label="Trust tier">
          {sc.trustTier}
        </span>
        <span className="faint">
          {sc.agentId} · {sc.role} · last {sc.windowDays} days
        </span>
      </div>

      <div className="sc-metrics">
        <Metric label="Decided drafts" value={String(sc.decided)} threshold={`need ≥ ${criteria.minDecided}`} tone={tone(sc.decided >= criteria.minDecided)} detail={`${sc.approved} approved · ${sc.rejected} rejected`} />
        <Metric label="Approval rate" value={pct(sc.approvalRate)} threshold={`need ≥ ${pct(criteria.minApprovalRate)}`} tone={tone(sc.approvalRate === null ? null : sc.approvalRate >= criteria.minApprovalRate)} />
        <Metric label="Median edit ratio" value={pct(sc.medianEditRatio)} threshold={`need ≤ ${pct(criteria.maxMedianEditRatio)}`} tone={tone(sc.medianEditRatio === null ? null : sc.medianEditRatio <= criteria.maxMedianEditRatio)} detail={sc.editedRate === null ? undefined : `${pct(sc.editedRate)} of approved drafts edited`} />
        <Metric label="Compliance rejections" value={String(compliance)} threshold={`need ≤ ${criteria.maxComplianceRejections}`} tone={tone(compliance <= criteria.maxComplianceRejections)} />
        <Metric label="Lint error rate" value={pct(sc.lintErrorRate)} threshold={`need ≤ ${pct(criteria.maxLintErrorsRate)}`} tone={tone(sc.lintErrorRate === null ? null : sc.lintErrorRate <= criteria.maxLintErrorsRate)} />
      </div>

      <div className="sc-secondary">
        <span>Drafts <strong>{sc.drafts}</strong></span>
        <span>Median review time <strong>{minutes(sc.medianReviewMinutes)}</strong></span>
        <span>Sent <strong>{sc.sent}</strong></span>
        <span>Replies <strong>{sc.replies}</strong>{sc.replyRate !== null && <> ({pct(sc.replyRate)})</>}</span>
        <span>Tasks <strong>{sc.tasks.done}</strong> done · <strong>{sc.tasks.failed}</strong> failed · <strong>{sc.tasks.needsHuman}</strong> need a human</span>
      </div>

      <div className="sc-lower">
        <div className="sc-reject" aria-label="Rejection reasons">
          <h3>Rejection reasons</h3>
          {cats.length === 0 ? (
            <p className="faint">No rejections in this window.</p>
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

        <PromotionPanel sc={sc} onChanged={onChanged} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

type Step = "closed" | "confirm" | "force1" | "force2";

function PromotionPanel({ sc, onChanged }: { sc: AgentScorecard; onChanged: () => void }) {
  const { notify } = useToast();
  const [step, setStep] = useState<Step>("closed");
  const [busy, setBusy] = useState(false);
  const promo = sc.promotion;

  if (!promo) {
    return (
      <div className="sc-promo" aria-label="Promotion">
        <h3>Promotion</h3>
        <p className="muted">Already at the highest trust tier (autonomous).</p>
      </div>
    );
  }

  async function run(force: boolean) {
    setBusy(true);
    try {
      await qualityApi.promoteAgent(sc.agentId, force ? { force: true } : {});
      notify(`${sc.agentId} promoted to ${promo!.nextTier}.`, "success");
      setStep("closed");
      onChanged();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
      setStep("closed");
    } finally {
      setBusy(false);
    }
  }

  const consequences: ReactNode = (
    <>
      <p>
        Move <strong>{sc.agentId}</strong> from <strong>{sc.trustTier}</strong> to <strong>{promo.nextTier}</strong>?
      </p>
      <p>{TIER_CONSEQUENCES[promo.nextTier]}</p>
      <p className="muted">The change is audited. You can move an agent back at any time from the Agents page.</p>
    </>
  );

  return (
    <div className="sc-promo" aria-label="Promotion">
      <h3>Promotion</h3>
      {promo.eligible ? (
        <>
          <p className="sc-eligible">Eligible to move to {promo.nextTier}</p>
          <button type="button" className="btn btn-primary" onClick={() => setStep("confirm")} disabled={busy}>
            Promote to {promo.nextTier}
          </button>
        </>
      ) : (
        <>
          <p className="muted">Not yet eligible to move to {promo.nextTier}:</p>
          <ul className="sc-unmet">
            {promo.unmet.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep("force1")} disabled={busy}>
            Promote anyway
          </button>
        </>
      )}

      {step === "confirm" && (
        <ConfirmDialog
          title={`Promote ${sc.agentId} to ${promo.nextTier}?`}
          description={consequences}
          confirmLabel={`Promote to ${promo.nextTier}`}
          onConfirm={() => void run(false)}
          onCancel={() => setStep("closed")}
        />
      )}
      {step === "force1" && (
        <ConfirmDialog
          title="Promote without meeting the criteria?"
          description={
            <>
              <p>The evidence does not support this yet:</p>
              <ul>
                {promo.unmet.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
              {consequences}
            </>
          }
          confirmLabel="Continue"
          destructive
          onConfirm={() => setStep("force2")}
          onCancel={() => setStep("closed")}
        />
      )}
      {step === "force2" && (
        <ConfirmDialog
          title="Are you absolutely sure?"
          description={<p>This overrides the promotion criteria and is recorded in the audit log as a forced promotion.</p>}
          confirmLabel="Yes, promote anyway"
          destructive
          onConfirm={() => void run(true)}
          onCancel={() => setStep("closed")}
        />
      )}
    </div>
  );
}
