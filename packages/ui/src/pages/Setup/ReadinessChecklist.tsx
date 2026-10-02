import { Link } from "react-router-dom";
import type { ReadinessCheck, ReadinessReport } from "../../api/readiness.ts";
import "./setup.css";

const ICON_GLYPH: Record<ReadinessCheck["status"], string> = { pass: "✓", warn: "!", fail: "✗" };

/** UI strings; the wizard passes Vietnamese, everything else keeps the English default. */
export interface ReadinessTexts {
  heading: string;
  recheck: string;
  checking: string;
  loading: string;
  fix: string;
  statusLabel: Record<ReadinessCheck["status"], string>;
  summary: (c: { fail: number; warn: number; pass: number }) => string;
}

export const READINESS_TEXTS_EN: ReadinessTexts = {
  heading: "Go-live checklist",
  recheck: "Re-check",
  checking: "Checking…",
  loading: "Loading checks…",
  fix: "Fix",
  statusLabel: { pass: "Passing", warn: "Warning", fail: "Failing" },
  summary: (c) => `${c.fail} failing · ${c.warn} warning${c.warn === 1 ? "" : "s"} · ${c.pass} passing`,
};

export const READINESS_TEXTS_VI: ReadinessTexts = {
  heading: "Danh sách kiểm tra trước go-live",
  recheck: "Kiểm tra lại",
  checking: "Đang kiểm tra…",
  loading: "Đang tải…",
  fix: "Xử lý",
  statusLabel: { pass: "Đạt", warn: "Cảnh báo", fail: "Chưa đạt" },
  summary: (c) => `${c.fail} chưa đạt · ${c.warn} cảnh báo · ${c.pass} đạt`,
};

export function countStatuses(report: ReadinessReport): { fail: number; warn: number; pass: number } {
  const counts = { fail: 0, warn: 0, pass: 0 };
  for (const c of report.checks) counts[c.status]++;
  return counts;
}

/** Fix links are app routes like "/setup#company"; keep them working when already on /setup. */
export function FixLink({ check, label = "Fix", to }: { check: ReadinessCheck; label?: string; to?: string | null }) {
  const target = to ?? check.fixPath;
  if (!target) return null;
  return (
    <Link className="readiness-fix" to={target} aria-label={`${label}: ${check.title}`}>
      {label} →
    </Link>
  );
}

export interface ReadinessChecklistProps {
  report: ReadinessReport | null;
  loading: boolean;
  error: string | null;
  onRecheck: () => void;
  texts?: ReadinessTexts;
  /** Override where a check's Fix link goes (the wizard maps checks to its steps). */
  resolveFix?: (check: ReadinessCheck) => string | null;
}

export function ReadinessChecklist({ report, loading, error, onRecheck, texts = READINESS_TEXTS_EN, resolveFix }: ReadinessChecklistProps) {
  const counts = report ? countStatuses(report) : null;
  return (
    <section className="card setup-section" id="readiness" aria-labelledby="readiness-heading">
      <div className="setup-card-head">
        <div>
          <h2 id="readiness-heading">{texts.heading}</h2>
          {counts && (
            <p className="setup-hint" role="status">
              {texts.summary(counts)}
            </p>
          )}
        </div>
        <button type="button" className="btn btn-sm" onClick={onRecheck} disabled={loading} aria-busy={loading}>
          {loading ? texts.checking : texts.recheck}
        </button>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!report && !error && <p className="empty-state">{texts.loading}</p>}

      {report && (
        <ul className="readiness-list">
          {report.checks.map((c) => (
            <li key={c.id} className="readiness-item" data-status={c.status} data-check-id={c.id}>
              <span className={`readiness-icon readiness-icon-${c.status}`} role="img" aria-label={texts.statusLabel[c.status]}>
                {ICON_GLYPH[c.status]}
              </span>
              <div>
                <div className="readiness-title">
                  {c.title} <span className="readiness-id">{c.id}</span>
                </div>
                <p className="readiness-detail">{c.detail}</p>
              </div>
              {c.status !== "pass" && <FixLink check={c} label={texts.fix} to={resolveFix ? resolveFix(c) : undefined} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
