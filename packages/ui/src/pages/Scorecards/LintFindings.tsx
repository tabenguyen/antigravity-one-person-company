// Draft-lint widgets shared with the Inbox: findings list, row badge, rejection-category chips.
import "./lint.css";
import { REJECTION_CATEGORY_OPTIONS, type LintFinding, type RejectionCategory } from "../../api/quality.ts";

const ORDER: Record<LintFinding["severity"], number> = { error: 0, warn: 1, info: 2 };

/** Severity-coloured list of lint findings (errors first). Renders nothing when there are none. */
export function LintFindings({ findings }: { findings: LintFinding[] | undefined | null }) {
  if (!findings || findings.length === 0) return null;
  const sorted = [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  return (
    <ul className="lint-list" aria-label="Lint findings">
      {sorted.map((f, i) => (
        <li key={`${f.code}-${i}`} className={`lint-item lint-${f.severity}`} data-severity={f.severity}>
          <span className="lint-code">{f.code}</span>
          {f.message}
        </li>
      ))}
    </ul>
  );
}

/** Small "2 errors / 1 warning" badge for list rows; renders nothing when clean. */
export function LintBadge({ findings }: { findings: LintFinding[] | undefined | null }) {
  const errors = (findings ?? []).filter((f) => f.severity === "error").length;
  const warns = (findings ?? []).filter((f) => f.severity === "warn").length;
  if (errors === 0 && warns === 0) return null;
  const sev = errors > 0 ? "error" : "warn";
  const text = errors > 0 ? `${errors} lint error${errors === 1 ? "" : "s"}` : `${warns} lint warning${warns === 1 ? "" : "s"}`;
  return (
    <span className={`lint-badge lint-${sev}`} title="Automatic draft checks">
      {text}
    </span>
  );
}

/** "revised ×N" (the agent rewrote this pending draft in place) / "superseded" (a newer draft replaced it). */
export function RevisionBadge({ item }: { item: { revisions?: number; status: string; decidedBy: string | null } }) {
  const superseded = item.status === "rejected" && item.decidedBy === "policy:superseded";
  const revisions = item.revisions ?? 0;
  if (!superseded && revisions === 0) return null;
  return superseded ? (
    <span className="lint-badge lint-note" title="Replaced by a newer draft for the same thread; not counted in scorecards">
      superseded
    </span>
  ) : (
    <span className="lint-badge lint-note" title="The agent rewrote this draft in place before review (one queue item, not a duplicate)">
      revised ×{revisions}
    </span>
  );
}

/** Required single-choice rejection category (nothing preselected). */
export function RejectCategoryChips({ value, onChange, showKeys = false }: { value: RejectionCategory | null; onChange: (c: RejectionCategory) => void; showKeys?: boolean }) {
  return (
    <div role="group" aria-label="Rejection category" className="reject-chips">
      {REJECTION_CATEGORY_OPTIONS.map((o, i) => (
        <button
          key={o.value}
          type="button"
          className="reject-chip"
          aria-pressed={value === o.value}
          data-key={showKeys ? i + 1 : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
