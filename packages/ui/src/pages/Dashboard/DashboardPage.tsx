import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../api/client.ts";
import { useApi } from "../../hooks/useApi.ts";
import { useAuth } from "../../auth/AuthContext.tsx";
import { useToast } from "../../components/Toast.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { formatDateTime } from "../../lib/time.ts";
import { eventHub, type HubEvent } from "../../api/sse.ts";
import { readinessApi, type ReadinessCheck } from "../../api/readiness.ts";
import { KpiSection } from "./KpiSection.tsx";
import { ReadinessSummaryCard } from "../Setup/ReadinessSummaryCard.tsx";

export function DashboardPage() {
  const { status, refreshStatus } = useAuth();
  const { notify } = useToast();
  const { data: statsData, error: statsError } = useApi(() => api.stats(7), [], ["outbox.updated", "run.finished", "inbound.routed"]);
  const { data: quotaData } = useApi(() => api.quota(), []);
  const [confirmKill, setConfirmKill] = useState<null | { next: boolean }>(null);
  const [reason, setReason] = useState("");
  const [feed, setFeed] = useState<HubEvent[]>([]);
  // Readiness gate: the server answers 409 when enabling outbound while checks fail.
  const [notReady, setNotReady] = useState<null | { message: string; failing: ReadinessCheck[] }>(null);
  const [confirmForce, setConfirmForce] = useState(false);

  useEffect(() => eventHub.subscribe("*", (e) => setFeed((prev) => [e, ...prev].slice(0, 30))), []);

  async function applyKillSwitch(next: boolean, force: boolean) {
    await readinessApi.killSwitch({ outboundEnabled: next, reason: reason.trim() || undefined, ...(force ? { force: true } : {}) });
    await refreshStatus();
    notify(next ? (force ? "Outbound enabled (readiness overridden)." : "Outbound enabled.") : "Outbound disabled.", force ? "info" : "success");
  }

  async function confirmKillSwitch() {
    if (!confirmKill) return;
    const next = confirmKill.next;
    try {
      await applyKillSwitch(next, false);
      setReason("");
    } catch (err) {
      if (next && err instanceof ApiError && err.status === 409 && err.code === "conflict") {
        // Not ready: show exactly which checks fail and offer an explicit override.
        let failing: ReadinessCheck[] = [];
        try {
          const { readiness } = await readinessApi.readiness();
          failing = readiness.checks.filter((c) => c.status === "fail");
        } catch {
          // fall back to the server's message alone
        }
        setNotReady({ message: err.message, failing });
      } else {
        notify(err instanceof ApiError ? err.message : String(err), "error");
        setReason("");
      }
    } finally {
      setConfirmKill(null);
    }
  }

  async function forceEnable() {
    try {
      await applyKillSwitch(true, true);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    } finally {
      setConfirmForce(false);
      setNotReady(null);
      setReason("");
    }
  }

  return (
    <div>
      <h1>Dashboard</h1>

      <div className="card-grid">
        <div className="card">
          <div className="stat-label">Email provider</div>
          <div className="stat-value">{status?.email.provider ?? "—"}</div>
          <p className="muted">
            {status?.email.address ?? "no address"} ·{" "}
            <span className={status?.email.ok ? "pill pill-success" : "pill pill-danger"}>
              {status?.email.ok ? "ok" : status?.email.error ?? "error"}
            </span>
          </p>
          <p className="faint">
            last poll {formatDateTime(status?.email.lastPollAt ?? null)} · last send{" "}
            {formatDateTime(status?.email.lastSendAt ?? null)}
          </p>
        </div>

        <div className="card">
          <div className="stat-label">Outbound kill switch</div>
          <div className="stat-value">{status?.outboundEnabled ? "Enabled" : "Disabled"}</div>
          {!status?.outboundEnabled && status?.outboundDisabledReason && (
            <p className="muted">{status.outboundDisabledReason}</p>
          )}
          <button
            type="button"
            className={status?.outboundEnabled ? "btn btn-danger btn-sm" : "btn btn-primary btn-sm"}
            onClick={() => setConfirmKill({ next: !status?.outboundEnabled })}
          >
            {status?.outboundEnabled ? "Disable outbound" : "Enable outbound"}
          </button>
        </div>

        <ReadinessSummaryCard />

        <div className="card">
          <div className="stat-label">Quiet hours</div>
          <div className="stat-value">{status?.inQuietHours ? "Active now" : "Not active"}</div>
        </div>

        <div className="card">
          <div className="stat-label">Quota / throttle</div>
          <div className="stat-value">{status?.quotaThrottled ? "Throttled" : "Normal"}</div>
          {quotaData?.buckets.map((b) => (
            <p key={b.group + b.window} className="faint">
              {b.group} ({b.window}): {Math.round(b.remainingFraction * 100)}% remaining
            </p>
          ))}
        </div>

        <div className="card">
          <div className="stat-label">Running tasks</div>
          <div className="stat-value">{status?.runningTasks ?? 0}</div>
        </div>

        <div className="card">
          <div className="stat-label">agy version</div>
          <div className="stat-value">{status?.agyVersion ?? "—"}</div>
          <p className="faint">agy-hq daemon {status?.version ?? "—"}</p>
        </div>
      </div>

      <KpiSection />

      <h2>Per-agent stats ({statsData?.days ?? 7}d)</h2>
      {statsError && <p className="form-error">{statsError}</p>}
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Approval rate</th>
            <th>Edit rate</th>
            <th>Sent</th>
            <th>Replies</th>
            <th>Tokens</th>
          </tr>
        </thead>
        <tbody>
          {statsData?.agents.map((a) => (
            <tr key={a.agentId}>
              <td>{a.agentId}</td>
              <td>{a.approvalRate !== null ? `${Math.round(a.approvalRate * 100)}%` : "—"}</td>
              <td>{a.editRate !== null ? `${Math.round(a.editRate * 100)}%` : "—"}</td>
              <td>{a.sent}</td>
              <td>{a.repliesReceived}</td>
              <td>{a.tokensUsed.toLocaleString()}</td>
            </tr>
          ))}
          {statsData && statsData.agents.length === 0 && (
            <tr>
              <td colSpan={6} className="empty-state">
                No agent activity yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2 style={{ marginTop: 24 }}>Live activity</h2>
      <div className="card" style={{ maxHeight: 300, overflowY: "auto" }}>
        {feed.length === 0 && <p className="empty-state">No events yet.</p>}
        {feed.map((e, i) => (
          <div key={i} className="timeline-item">
            <strong>{e.type}</strong> {JSON.stringify(e).slice(0, 160)}
          </div>
        ))}
      </div>

      {confirmKill && (
        <ConfirmDialog
          title={confirmKill.next ? "Enable outbound sending?" : "Disable outbound sending?"}
          description={
            confirmKill.next
              ? "Approved drafts will start sending (subject to quiet hours and rate limits)."
              : "Nothing will send until this is turned back on. Already-approved drafts will queue."
          }
          destructive={!confirmKill.next}
          confirmLabel={confirmKill.next ? "Enable" : "Disable"}
          onConfirm={confirmKillSwitch}
          onCancel={() => setConfirmKill(null)}
        >
          <div className="field">
            <label htmlFor="kill-reason">Reason (optional)</label>
            <input id="kill-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </ConfirmDialog>
      )}

      {notReady && !confirmForce && (
        <ConfirmDialog
          title="Not ready to enable outbound"
          description={
            <>
              <p>
                {notReady.failing.length > 0
                  ? `${notReady.failing.length} readiness check${notReady.failing.length === 1 ? " is" : "s are"} failing:`
                  : notReady.message}
              </p>
              {notReady.failing.length > 0 && (
                <ul className="notready-list">
                  {notReady.failing.map((c) => (
                    <li key={c.id}>
                      <strong>{c.title}</strong>
                      <div className="muted">{c.detail}</div>
                      {c.fixPath && <Link to={c.fixPath}>Fix →</Link>}
                    </li>
                  ))}
                </ul>
              )}
              <p className="muted">Fix these on the Setup page, or enable anyway if you understand the risk.</p>
            </>
          }
          destructive
          confirmLabel="Enable anyway"
          cancelLabel="Cancel"
          onConfirm={() => setConfirmForce(true)}
          onCancel={() => setNotReady(null)}
        />
      )}

      {notReady && confirmForce && (
        <ConfirmDialog
          title="Override readiness checks?"
          description={`Outbound will be enabled while ${notReady.failing.length || "some"} readiness check(s) fail. Agents may quote placeholder content or send from an unverified setup. This override is recorded in the audit log.`}
          destructive
          confirmLabel="Yes, enable anyway"
          onConfirm={forceEnable}
          onCancel={() => setConfirmForce(false)}
        />
      )}
    </div>
  );
}
