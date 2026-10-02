import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { readinessApi } from "../../api/readiness.ts";
import { useApi } from "../../hooks/useApi.ts";
import { useAuth } from "../../auth/AuthContext.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Stepper } from "./wizard/Stepper.tsx";
import { WizardContext, type StepController, type WizardCtx } from "./wizard/WizardContext.tsx";
import { useSetupJob } from "./wizard/useSetupJob.ts";
import { STEPS, computeStepStatuses, isStepKey, stepFromHash, stepIndex, type StepKey } from "./wizard/steps.ts";
import { CompanyStep } from "./wizard/CompanyStep.tsx";
import { KnowledgeStep } from "./wizard/KnowledgeStep.tsx";
import { EmailStep } from "./wizard/EmailStep.tsx";
import { SenderStep } from "./wizard/SenderStep.tsx";
import { AgentStep } from "./wizard/AgentStep.tsx";
import { GoLiveStep } from "./wizard/GoLiveStep.tsx";
import "./setup.css";
import "./wizard/wizard.css";

const LIVE_EVENTS = ["settings.changed", "setup.company_saved", "kb.synced", "agent.created", "agent.updated"];

function StepBody({ step }: { step: StepKey }) {
  switch (step) {
    case "company":
      return <CompanyStep />;
    case "kb":
      return <KnowledgeStep />;
    case "email":
      return <EmailStep />;
    case "sender":
      return <SenderStep />;
    case "agent":
      return <AgentStep />;
    case "golive":
      return <GoLiveStep />;
  }
}

/** /setup — a step-by-step wizard from zero to go-live. The current step lives in the URL (?step=email). */
export function SetupPage() {
  const { status } = useAuth();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const stepParam = params.get("step");
  const current: StepKey = isStepKey(stepParam) ? stepParam : (stepFromHash(location.hash) ?? "company");

  const readiness = useApi(() => readinessApi.readiness(), [], LIVE_EVENTS);
  const jobs = useSetupJob();
  const report = readiness.data?.readiness ?? null;

  const controllerRef = useRef<StepController | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pendingNav, setPendingNav] = useState<StepKey | null>(null);
  const [continuing, setContinuing] = useState(false);

  const mainRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    // Moving between steps: reset dirty state and bring focus to the new step for keyboard / screen-reader users.
    setDirty(false);
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [current]);

  const applyStep = useCallback(
    (key: StepKey) => {
      setParams({ step: key }, { replace: false });
    },
    [setParams],
  );

  const goStep = useCallback(
    (key: StepKey) => {
      if (key === current) return;
      if (dirty) setPendingNav(key);
      else applyStep(key);
    },
    [current, dirty, applyStep],
  );

  const statuses = useMemo(
    () => computeStepStatuses({ report, job: jobs.current, outboundEnabled: !!status?.outboundEnabled }),
    [report, jobs.current, status?.outboundEnabled],
  );
  const doneCount = STEPS.filter((s) => statuses[s.key] === "done").length;

  const idx = stepIndex(current);
  const prev = idx > 0 ? STEPS[idx - 1]! : null;
  const next = idx < STEPS.length - 1 ? STEPS[idx + 1]! : null;

  async function onContinue() {
    if (!next) return;
    const c = controllerRef.current;
    if (c?.dirty) {
      setContinuing(true);
      let ok = false;
      try {
        ok = await c.save();
      } finally {
        setContinuing(false);
      }
      if (!ok) return;
      setDirty(false);
    }
    applyStep(next.key);
  }

  const ctx: WizardCtx = useMemo(
    () => ({
      report,
      readinessLoading: readiness.loading,
      readinessError: readiness.error,
      refreshReadiness: readiness.refresh,
      jobs,
      controllerRef,
      setDirty,
      goStep,
    }),
    [report, readiness.loading, readiness.error, readiness.refresh, jobs, goStep],
  );

  return (
    <WizardContext.Provider value={ctx}>
      <div className="wizard">
        <header className="wz-head">
          <h1>Thiết lập</h1>
          <p className="muted">
            Đi lần lượt qua 6 bước để agent bán hàng sẵn sàng làm việc. Email chỉ được gửi đi khi bạn bật ở bước cuối.{" "}
            <span role="status">{report ? `Đã xong ${doneCount}/${STEPS.length} bước.` : ""}</span>
          </p>
        </header>

        <div className="wz-body">
          <Stepper current={current} statuses={statuses} onSelect={goStep} />

          <div className="wz-main" ref={mainRef} tabIndex={-1} data-step={current}>
            <StepBody key={current} step={current} />

            <div className="wz-footer">
              {prev ? (
                <button type="button" className="btn" onClick={() => goStep(prev.key)} disabled={continuing}>
                  ← Quay lại
                </button>
              ) : (
                <span />
              )}
              {next && (
                <button type="button" className="btn btn-primary" onClick={onContinue} disabled={continuing} aria-busy={continuing}>
                  {continuing ? "Đang lưu…" : dirty ? "Lưu & tiếp tục →" : "Tiếp tục →"}
                </button>
              )}
            </div>
          </div>
        </div>

        {pendingNav && (
          <ConfirmDialog
            title="Bỏ thay đổi chưa lưu?"
            description="Bước này có thay đổi chưa lưu. Nếu rời đi, các thay đổi sẽ mất."
            confirmLabel="Bỏ thay đổi và rời đi"
            cancelLabel="Ở lại"
            destructive
            onCancel={() => setPendingNav(null)}
            onConfirm={() => {
              const key = pendingNav;
              setPendingNav(null);
              applyStep(key);
            }}
          />
        )}
      </div>
    </WizardContext.Provider>
  );
}
