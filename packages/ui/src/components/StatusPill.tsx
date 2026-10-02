import type { DaemonStatus } from "../api/types.ts";

export function StatusPill({ status }: { status: DaemonStatus | null }) {
  if (!status) return <span className="pill pill-neutral">status unknown</span>;
  const enabled = status.outboundEnabled;
  return (
    <span
      className={`pill status-pill ${enabled ? "pill-success" : "pill-danger"}`}
      title={enabled ? "Outbound sending is enabled" : status.outboundDisabledReason ?? "Outbound sending is disabled"}
    >
      <span className="pill-dot" />
      <span className="pill-text">
        {enabled ? "OUTBOUND ENABLED" : "OUTBOUND DISABLED"}
        {!enabled && status.outboundDisabledReason ? ` — ${status.outboundDisabledReason}` : ""}
      </span>
    </span>
  );
}

export function QuietHoursPill({ status }: { status: DaemonStatus | null }) {
  if (!status?.inQuietHours) return null;
  return (
    <span className="pill pill-warning" title="No sends while in quiet hours">
      <span className="pill-dot" />
      quiet hours
    </span>
  );
}
