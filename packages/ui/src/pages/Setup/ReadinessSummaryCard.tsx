import { Link } from "react-router-dom";
import { readinessApi } from "../../api/readiness.ts";
import { useApi } from "../../hooks/useApi.ts";
import { countStatuses } from "./ReadinessChecklist.tsx";
import "./setup.css";

/** Small Dashboard card: overall go-live state with a link to the Setup page. */
export function ReadinessSummaryCard() {
  const { data, error } = useApi(() => readinessApi.readiness(), [], ["settings.changed", "setup.company_saved", "kb.synced"]);
  const report = data?.readiness ?? null;
  const counts = report ? countStatuses(report) : null;

  return (
    <div className="card" data-testid="readiness-card">
      <div className="stat-label">Go-live readiness</div>
      <div className="stat-value">{error ? "Unknown" : !report ? "Checking…" : report.ready ? "Ready" : "Not ready"}</div>
      {counts && (
        <p className={report?.ready ? "muted" : "form-error"}>
          {counts.fail} failing · {counts.warn} warning{counts.warn === 1 ? "" : "s"}
        </p>
      )}
      {error && <p className="faint">{error}</p>}
      <Link className="readiness-card-link" to="/setup">
        {report?.ready ? "Review setup" : "Open setup checklist"} →
      </Link>
    </div>
  );
}
