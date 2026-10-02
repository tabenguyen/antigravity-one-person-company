import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../../api/client.ts";
import { readinessApi, type ReadinessCheck } from "../../../api/readiness.ts";
import { useAuth } from "../../../auth/AuthContext.tsx";
import { useApi } from "../../../hooks/useApi.ts";
import { ConfirmDialog } from "../../../components/ConfirmDialog.tsx";
import { useToast } from "../../../components/Toast.tsx";
import { ReadinessChecklist, READINESS_TEXTS_VI } from "../ReadinessChecklist.tsx";
import { stepForCheck, stepPath } from "./steps.ts";
import { useWizard } from "./WizardContext.tsx";

/** Where a readiness check's "Xử lý" link goes: inside the wizard when the check belongs to a step. */
export function resolveWizardFix(check: ReadinessCheck): string | null {
  const step = stepForCheck(check.id);
  return step ? stepPath(step) : null;
}

/** Step 6: final checklist + the (guarded) switch that turns outbound email on. */
export function GoLiveStep() {
  const { report, readinessLoading, readinessError, refreshReadiness } = useWizard();
  const { status, refreshStatus } = useAuth();
  const { notify } = useToast();
  const agents = useApi(() => api.listAgents({ role: "sales-sdr" }), []);
  const settings = useApi(() => api.getSettings(), []);

  const [confirm, setConfirm] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [blocked, setBlocked] = useState<null | { message: string; failing: ReadinessCheck[] }>(null);

  const enabled = !!status?.outboundEnabled;
  const defaultId = settings.data?.settings.defaultSdrAgentId ?? null;
  const sdr = agents.data?.agents.find((a) => a.id === defaultId) ?? agents.data?.agents[0] ?? null;

  async function enable() {
    setConfirm(false);
    setEnabling(true);
    setBlocked(null);
    try {
      await readinessApi.killSwitch({ outboundEnabled: true, reason: "Bật từ trình thiết lập" });
      await refreshStatus();
      refreshReadiness();
      notify("Đã bật gửi email.", "success");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === "conflict") {
        let failing: ReadinessCheck[] = [];
        try {
          const { readiness } = await readinessApi.readiness();
          failing = readiness.checks.filter((c) => c.status === "fail");
        } catch {
          // fall back to the server message alone
        }
        setBlocked({ message: err.message, failing });
        refreshReadiness();
      } else {
        notify(err instanceof ApiError ? err.message : String(err), "error");
      }
    } finally {
      setEnabling(false);
    }
  }

  return (
    <div className="wz-step-body">
      <h2 className="wz-title">6. Go-live</h2>
      <p className="muted">Kiểm tra lần cuối. Khi mọi mục bắt buộc đạt, bạn có thể bật gửi email.</p>

      <ReadinessChecklist
        report={report}
        loading={readinessLoading}
        error={readinessError}
        onRecheck={refreshReadiness}
        texts={READINESS_TEXTS_VI}
        resolveFix={resolveWizardFix}
      />

      <section className="card wz-card" aria-labelledby="gl-summary-h">
        <h3 id="gl-summary-h">Khi bật gửi email, điều gì xảy ra?</h3>
        <ul className="wz-bullets">
          <li>
            {sdr ? (
              <>
                Agent <strong>{sdr.displayName}</strong> ({sdr.id}) soạn email cho khách tiềm năng và trả lời khi khách phản hồi.
              </>
            ) : (
              <>Agent SDR soạn email cho khách tiềm năng và trả lời khi khách phản hồi.</>
            )}
          </li>
          {sdr?.trustTier === "shadow" ? (
            <li>
              Agent đang ở <strong>chế độ thực hành</strong>: mọi email chỉ là bản nháp trong Inbox, <strong>không gửi đi</strong>. Bạn nâng quyền sau khi thấy chất lượng tốt.
            </li>
          ) : (
            <li>Email do agent soạn xuất hiện trong Inbox để bạn duyệt trước khi gửi (tuỳ quyền của agent).</li>
          )}
          <li>Bạn tắt gửi email bất cứ lúc nào bằng công tắc khẩn trên trang Dashboard. Hệ thống cũng tự tạm dừng nếu có sự cố.</li>
        </ul>

        {enabled ? (
          <div className="setup-banner setup-banner-ready" role="status">
            <div>
              <h4>Đã bật gửi email</h4>
              <p>Hệ thống đang hoạt động. Xem các bản nháp cần duyệt trong Inbox.</p>
            </div>
            <Link className="btn btn-primary" to="/inbox">
              Mở Inbox
            </Link>
          </div>
        ) : (
          <>
            {report && !report.ready && (
              <p className="setup-hint wz-note" role="status">
                Còn mục bắt buộc chưa đạt ở danh sách trên. Hệ thống sẽ từ chối bật cho đến khi xử lý xong.
              </p>
            )}
            <div className="wz-actions">
              <button type="button" className="btn btn-primary" onClick={() => setConfirm(true)} disabled={enabling} aria-busy={enabling}>
                {enabling ? "Đang bật…" : "Bật gửi email"}
              </button>
            </div>
          </>
        )}

        {blocked && (
          <div className="wz-callout wz-callout-warn" role="alert">
            <h4>Chưa thể bật gửi email</h4>
            <p>{blocked.message}</p>
            {blocked.failing.length > 0 && (
              <ul>
                {blocked.failing.map((c) => {
                  const to = resolveWizardFix(c) ?? c.fixPath;
                  return (
                    <li key={c.id}>
                      {c.title} — <span className="muted">{c.detail}</span>{" "}
                      {to && (
                        <Link to={to} aria-label={`Xử lý: ${c.title}`}>
                          Xử lý →
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="setup-hint">Người dùng nâng cao có thể ép bật từ trang Dashboard (không khuyến nghị).</p>
          </div>
        )}
      </section>

      {confirm && (
        <ConfirmDialog
          title="Bật gửi email?"
          description="Hệ thống bắt đầu xử lý email theo quyền của agent. Bạn có thể tắt lại bất cứ lúc nào trên Dashboard."
          confirmLabel="Bật"
          cancelLabel="Chưa bật"
          onCancel={() => setConfirm(false)}
          onConfirm={() => void enable()}
        />
      )}
    </div>
  );
}
