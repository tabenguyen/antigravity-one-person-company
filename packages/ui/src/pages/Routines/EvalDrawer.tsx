import { useEffect, useRef } from "react";
import type { EvalCaseResult, EvalRun } from "../../api/routines.ts";
import { formatDateTime } from "../../lib/time.ts";
import { formatDuration, statusClass, statusLabel } from "./evalFormat.ts";

function CaseCard({ result }: { result: EvalCaseResult }) {
  const failed = result.assertions.filter((a) => !a.ok).length;
  return (
    <div className="rt-case" data-testid={`eval-case-${result.caseId}`}>
      <div className="rt-case-head">
        <strong>{result.caseId}</strong>
        <span className={statusClass(result.status)}>{statusLabel(result.status)}</span>
        <span className="faint">{formatDuration(result.durationMs)}</span>
        <span className="faint">
          {result.assertions.length - failed}/{result.assertions.length} assertions
        </span>
      </div>
      <ul className="rt-assertions" aria-label={`Assertions for ${result.caseId}`}>
        {result.assertions.map((a, i) => (
          <li key={i}>
            <span className={a.ok ? "rt-ok" : "rt-bad"} aria-label={a.ok ? "passed" : "failed"}>
              {a.ok ? "✓" : "✗"}
            </span>
            <span>{a.name}</span>
            {a.detail && <span className="rt-detail">{a.detail}</span>}
          </li>
        ))}
        {result.assertions.length === 0 && <li className="faint">No assertions were evaluated.</li>}
      </ul>
      <details>
        <summary>Output JSON</summary>
        <pre className="rt-output">{JSON.stringify(result.output, null, 2)}</pre>
      </details>
    </div>
  );
}

export function EvalDrawer({ run, onClose }: { run: EvalRun; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const s = run.summary;
  return (
    <>
      <div className="rt-drawer-backdrop" role="presentation" onClick={onClose} />
      <aside className="rt-drawer" role="dialog" aria-label="Eval run details" aria-modal="true" tabIndex={-1} ref={ref}>
        <div className="rt-drawer-head">
          <div>
            <h2>
              {run.suite} <span className="faint">· {run.model}</span>
            </h2>
            <span className="faint">
              Started {formatDateTime(run.startedAt)} · {statusLabel(run.status)}
              {run.finishedAt ? ` · ${formatDuration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime())}` : ""}
            </span>
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
        <p>
          {s ? (
            <>
              <span className="rt-ok">{s.pass} passed</span> · <span className="rt-bad">{s.fail} failed</span> ·{" "}
              <span className="rt-warn">{s.error} errors</span>
              {s.skipped > 0 && <> · {s.skipped} skipped</>}
            </>
          ) : (
            <span className="muted">Running — {run.results.length} case(s) finished so far…</span>
          )}
        </p>
        {run.results.map((r) => (
          <CaseCard key={r.caseId} result={r} />
        ))}
        {run.results.length === 0 && <p className="empty-state">No case has finished yet.</p>}
      </aside>
    </>
  );
}
