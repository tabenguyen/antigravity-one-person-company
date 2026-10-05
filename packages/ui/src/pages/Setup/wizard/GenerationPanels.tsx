import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "../../../api/client.ts";
import type { GenerateSetupRequest, SetupJob } from "../../../api/setupWizard.ts";
import { formatDateTime } from "../../../lib/time.ts";
import { formatElapsed, type SetupJobState } from "./useSetupJob.ts";

// ---------------------------------------------------------------------------
// Input parsing

/** Mirrors GenerateSetupRequestZ.domain: strip scheme + path, lowercase, require a dotted host. */
export function normalizeDomain(raw: string): string | null {
  const d = raw.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

export function parseUrls(raw: string): { urls: string[]; bad: string[] } {
  const parts = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const urls: string[] = [];
  const bad: string[] = [];
  for (const p of parts) {
    try {
      const u = new URL(p);
      if (u.protocol === "http:" || u.protocol === "https:") urls.push(u.toString());
      else bad.push(p);
    } catch {
      bad.push(p);
    }
  }
  return { urls, bad };
}

function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// "Tạo bằng AI từ website" card (input form)

export function GenerateCard({ jobs, defaultDomain, onSkip, showSkip }: { jobs: SetupJobState; defaultDomain?: string; onSkip: () => void; showSkip: boolean }) {
  const [domain, setDomain] = useState(defaultDomain ?? "");
  const [urls, setUrls] = useState("");
  const [notes, setNotes] = useState("");
  const [language, setLanguage] = useState<"vi" | "en">("vi");
  const [includeFanpage, setIncludeFanpage] = useState(true);
  const [model, setModel] = useState("");
  const [errors, setErrors] = useState<{ domain?: string; urls?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const d = normalizeDomain(domain);
    const parsed = parseUrls(urls);
    const found: typeof errors = {};
    if (!d) found.domain = "Nhập tên miền, ví dụ acme.vn.";
    if (parsed.bad.length > 0) found.urls = `Địa chỉ không hợp lệ: ${parsed.bad.join(", ")}`;
    else if (parsed.urls.length > 10) found.urls = "Tối đa 10 địa chỉ.";
    setErrors(found);
    setApiError(null);
    if (found.domain || found.urls || !d) return;

    const body: GenerateSetupRequest = { domain: d, extraUrls: parsed.urls, language, includeFanpage };
    if (notes.trim()) body.notes = notes.trim();
    if (model.trim()) body.model = model.trim();
    setSubmitting(true);
    try {
      await jobs.start(body);
    } catch (err) {
      if (err instanceof ApiError && err.code === "conflict") {
        setApiError("Đang có một lần tạo khác chạy. Đang tải lại tiến trình…");
        void jobs.reload();
      } else {
        setApiError(err instanceof ApiError ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="card wz-card" aria-labelledby="gen-heading">
      <h3 id="gen-heading">Tạo bằng AI từ website</h3>
      <p className="muted">
        Nhập tên miền công ty. AI chỉ đọc các trang công khai trên website, rồi soạn nháp hồ sơ công ty, kiến thức bán hàng cho agent SDR và (tuỳ chọn) kiến thức cho agent Fanpage Manager.{" "}
        <strong>Chưa có gì được lưu</strong> cho đến khi bạn xem lại và bấm lưu.
      </p>
      <form onSubmit={submit} noValidate aria-busy={submitting}>
        <div className="field">
          <label htmlFor="gen-domain">Tên miền công ty</label>
          <input
            id="gen-domain"
            type="text"
            inputMode="url"
            autoComplete="off"
            value={domain}
            placeholder="acme.vn"
            aria-invalid={errors.domain ? true : undefined}
            aria-describedby={errors.domain ? "gen-domain-error" : undefined}
            onChange={(e) => setDomain(e.target.value)}
          />
          {errors.domain && (
            <p className="form-error" id="gen-domain-error">
              {errors.domain}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="gen-urls">Trang khác nên đọc (không bắt buộc)</label>
          <textarea
            id="gen-urls"
            rows={2}
            value={urls}
            placeholder={"https://acme.vn/bang-gia\nhttps://acme.vn/ve-chung-toi"}
            aria-invalid={errors.urls ? true : undefined}
            aria-describedby="gen-urls-help"
            onChange={(e) => setUrls(e.target.value)}
          />
          <p className="setup-hint" id="gen-urls-help">
            Mỗi dòng một địa chỉ, ví dụ trang bảng giá hoặc giới thiệu.
          </p>
          {errors.urls && <p className="form-error">{errors.urls}</p>}
        </div>
        <div className="field">
          <label htmlFor="gen-notes">Ghi chú cho AI (không bắt buộc)</label>
          <textarea
            id="gen-notes"
            rows={2}
            value={notes}
            maxLength={2000}
            placeholder="VD: Giá ở trang /bang-gia là mới nhất, bỏ qua site beta."
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="gen-language">Ngôn ngữ nội dung</label>
          <select id="gen-language" value={language} onChange={(e) => setLanguage(e.target.value as "vi" | "en")}>
            <option value="vi">Tiếng Việt</option>
            <option value="en">English</option>
          </select>
        </div>
        <div className="field">
          <label>
            <input type="checkbox" checked={includeFanpage} onChange={(e) => setIncludeFanpage(e.target.checked)} /> Soạn cả kiến thức cho Fanpage Manager
          </label>
          <p className="setup-hint">
            Giọng văn Page, nhóm nội dung, chính sách bình luận. Điểm nào website không nói rõ, AI đề xuất tạm và ghi vào danh sách “Cần xác nhận”.
          </p>
        </div>
        <details className="wz-advanced">
          <summary>Nâng cao</summary>
          <div className="field">
            <label htmlFor="gen-model">Model AI</label>
            <input id="gen-model" type="text" value={model} placeholder="Để trống để dùng mặc định" onChange={(e) => setModel(e.target.value)} />
          </div>
        </details>
        {apiError && (
          <p className="form-error" role="alert">
            {apiError}
          </p>
        )}
        <div className="wz-actions">
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Đang bắt đầu…" : "Tạo bằng AI"}
          </button>
          {showSkip && (
            <button type="button" className="btn btn-ghost" onClick={onSkip}>
              Tự điền thủ công
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Live progress

export function JobProgress({ job, now, onCancel }: { job: SetupJob; now: number; onCancel: () => Promise<void> }) {
  const logRef = useRef<HTMLOListElement>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const elapsed = formatElapsed(now - Date.parse(job.startedAt));

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [job.progress.length]);

  async function cancel() {
    setCancelling(true);
    setError(null);
    try {
      await onCancel();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <section className="card wz-card" aria-labelledby="job-heading" aria-busy="true">
      <div className="setup-card-head">
        <h3 id="job-heading">AI đang đọc {job.domain}…</h3>
        <span className="pill pill-neutral" aria-label={`Đã chạy ${elapsed}`}>
          <span className="pill-dot" aria-hidden="true" /> {elapsed}
        </span>
      </div>
      <p className="setup-hint">Thường mất vài phút. Bạn có thể ở lại trang này hoặc quay lại sau — tiến trình vẫn chạy.</p>
      <ol className="wz-log" ref={logRef} role="log" aria-live="polite" aria-label="Tiến trình của AI" tabIndex={0}>
        {job.progress.length === 0 && <li className="faint">Đang khởi động…</li>}
        {job.progress.map((p, i) => (
          <li key={`${p.at}-${i}`}>
            <time dateTime={p.at}>{new Date(p.at).toLocaleTimeString("vi-VN", { hour12: false })}</time> {p.line}
          </li>
        ))}
      </ol>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="btn btn-sm" onClick={cancel} disabled={cancelling}>
        {cancelling ? "Đang huỷ…" : "Huỷ"}
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Finished / failed / cancelled job

export interface JobReviewProps {
  job: SetupJob;
  /** The company profile was saved after this job finished: collapse by default. */
  stale: boolean;
  applied: boolean;
  conflictsAcked: boolean;
  onAckChange: (checked: boolean) => void;
  onApply: () => void;
}

export function JobReview({ job, stale, applied, conflictsAcked, onAckChange, onApply }: JobReviewProps) {
  const [open, setOpen] = useState(!stale);

  if (job.status === "failed") {
    return (
      <section className="card wz-card" aria-labelledby="job-result-heading">
        <h3 id="job-result-heading">Lần tạo cho {job.domain} không thành công</h3>
        <p className="form-error" role="alert">
          {job.error ?? "Lỗi không rõ."}
        </p>
        <p className="setup-hint">Bạn có thể thử lại ở trên, hoặc chọn “Tự điền thủ công”.</p>
      </section>
    );
  }
  if (job.status === "cancelled") {
    return (
      <section className="card wz-card" aria-labelledby="job-result-heading">
        <h3 id="job-result-heading">Đã huỷ lần tạo cho {job.domain}</h3>
      </section>
    );
  }
  const result = job.result;
  if (job.status !== "done" || !result) return null;

  const conflicts = result.conflicts ?? [];
  const questions = result.openQuestions ?? [];
  const sources = result.sources ?? [];

  return (
    <section className="card wz-card wz-review" aria-labelledby="job-result-heading">
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary id="job-result-heading">
          Kết quả AI cho {job.domain}
          {job.finishedAt && <span className="faint"> · {formatDateTime(job.finishedAt)}</span>}
        </summary>

        {conflicts.length > 0 && (
          <div className="wz-callout wz-callout-warn" role="group" aria-labelledby="conflicts-heading">
            <h4 id="conflicts-heading">Mâu thuẫn</h4>
            <p className="setup-hint">Các trang trên website nói khác nhau. Hãy kiểm tra và chọn đúng khi chỉnh hồ sơ bên dưới.</p>
            <ul>
              {conflicts.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
            <label className="wz-check">
              <input type="checkbox" checked={conflictsAcked} onChange={(e) => onAckChange(e.target.checked)} />
              Tôi đã xem các mâu thuẫn
            </label>
          </div>
        )}

        {questions.length > 0 && (
          <div className="wz-callout wz-callout-info" role="group" aria-labelledby="questions-heading">
            <h4 id="questions-heading">Cần bạn bổ sung</h4>
            <p className="setup-hint">Website không nói rõ những điều này. Bạn điền giúp vào hồ sơ để agent không phải đoán.</p>
            <ul>
              {questions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </div>
        )}

        {sources.length > 0 && (
          <div className="wz-sources">
            <h4>Nguồn AI đã đọc</h4>
            <ul>
              {sources.map((s) => {
                const href = safeHref(s.url);
                return (
                  <li key={s.url}>
                    {href ? (
                      <a href={href} target="_blank" rel="noreferrer noopener">
                        {s.title || s.url}
                      </a>
                    ) : (
                      <span>{s.title || s.url}</span>
                    )}
                    {s.title && <span className="faint"> {s.url}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="wz-actions">
          <button type="button" className="btn btn-primary" onClick={onApply}>
            {applied ? "Dùng lại kết quả này" : "Dùng kết quả này"}
          </button>
          {applied && (
            <span className="setup-hint" role="status">
              Đã điền vào biểu mẫu bên dưới — chưa lưu.
            </span>
          )}
        </div>
      </details>
    </section>
  );
}
