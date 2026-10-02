import { useCallback, useEffect, useState } from "react";
import { readinessApi, type CompanyProfileInput } from "../../../api/readiness.ts";
import type { SetupJob } from "../../../api/setupWizard.ts";
import { useApi } from "../../../hooks/useApi.ts";
import { ConfirmDialog } from "../../../components/ConfirmDialog.tsx";
import { CompanyProfileForm } from "../CompanyProfileForm.tsx";
import { GenerateCard, JobProgress, JobReview } from "./GenerationPanels.tsx";
import { useWizard } from "./WizardContext.tsx";

/** Step 1: generate the company profile from the website with AI (or type it), review, save. */
export function CompanyStep() {
  const { jobs, refreshReadiness, controllerRef, setDirty } = useWizard();
  const company = useApi(() => readinessApi.getCompany(), []);
  const profile = company.data?.profile ?? null;

  const [manual, setManual] = useState(false);
  const [draft, setDraft] = useState<CompanyProfileInput | null>(null);
  const [draftKey, setDraftKey] = useState(0);
  const [draftJob, setDraftJob] = useState<SetupJob | null>(null);
  const [ackJobId, setAckJobId] = useState<string | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const [confirmApply, setConfirmApply] = useState<SetupJob | null>(null);

  const onDirtyChange = useCallback(
    (d: boolean) => {
      setFormDirty(d);
      setDirty(d);
    },
    [setDirty],
  );
  const onController = useCallback(
    (c: { dirty: boolean; save: () => Promise<boolean> } | null) => {
      controllerRef.current = c;
    },
    [controllerRef],
  );

  const current = jobs.current;
  const showForm = !!profile || manual || draftKey > 0;

  useEffect(() => {
    if (draftKey > 0) document.getElementById("company-heading")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [draftKey]);

  function applyJob(job: SetupJob) {
    if (!job.result) return;
    setDraft(job.result.profile);
    setDraftJob(job);
    setDraftKey((k) => k + 1);
  }
  function requestApply(job: SetupJob) {
    if (formDirty) setConfirmApply(job);
    else applyJob(job);
  }

  const conflictCount = draftJob?.result?.conflicts?.length ?? 0;
  const blocked =
    draftJob && conflictCount > 0 && ackJobId !== draftJob.id
      ? "Hãy xem các mâu thuẫn ở trên và tick “Tôi đã xem các mâu thuẫn” trước khi lưu."
      : null;

  const savedAt = profile?.updatedAt ?? null;
  const stale = !!(current?.finishedAt && savedAt && savedAt >= current.finishedAt);

  return (
    <div className="wz-step-body">
      <h2 className="wz-title">1. Công ty</h2>
      <p className="muted">
        Cho agent biết bạn bán gì, cho ai, giá thế nào và điều gì không được nói. Cách nhanh nhất: để AI đọc website rồi bạn chỉnh lại.
      </p>

      {jobs.error && (
        <p className="form-error" role="alert">
          {jobs.error}
        </p>
      )}

      {jobs.running ? (
        <JobProgress job={jobs.running} now={jobs.now} onCancel={() => jobs.cancel(jobs.running!.id)} />
      ) : (
        <>
          <GenerateCard
            jobs={jobs}
            defaultDomain={profile?.website ? hostOf(profile.website) : undefined}
            showSkip={!showForm}
            onSkip={() => setManual(true)}
          />
          {current && (
            <JobReview
              job={current}
              stale={stale}
              applied={!!draftJob && draftJob.id === current.id}
              conflictsAcked={ackJobId === current.id}
              onAckChange={(checked) => setAckJobId(checked ? current.id : null)}
              onApply={() => requestApply(current)}
            />
          )}
        </>
      )}

      {showForm && (
        <>
          {draftJob && (
            <p className="setup-hint wz-note" role="status">
              Nội dung bên dưới đang là bản nháp do AI soạn (từ {draftJob.domain}). Bạn có thể sửa tự do. Chưa có gì được lưu cho đến khi bạn bấm “Lưu hồ sơ”.
            </p>
          )}
          <CompanyProfileForm
            locale="vi"
            compact
            profile={profile}
            loading={company.loading}
            loadError={company.error}
            draft={draft}
            draftKey={draftKey}
            saveBlockedReason={blocked}
            onDirtyChange={onDirtyChange}
            onController={onController}
            onSaved={() => {
              setDraftJob(null);
              company.refresh();
              refreshReadiness();
            }}
          />
        </>
      )}

      {confirmApply && (
        <ConfirmDialog
          title="Thay nội dung đang sửa?"
          description="Biểu mẫu có thay đổi chưa lưu. Dùng kết quả AI sẽ thay thế toàn bộ nội dung đó."
          confirmLabel="Dùng kết quả AI"
          cancelLabel="Giữ nội dung hiện tại"
          onCancel={() => setConfirmApply(null)}
          onConfirm={() => {
            applyJob(confirmApply);
            setConfirmApply(null);
          }}
        />
      )}
    </div>
  );
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}
