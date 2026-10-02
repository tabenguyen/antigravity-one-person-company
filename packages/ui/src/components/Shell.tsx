import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { StatusPill, QuietHoursPill } from "./StatusPill.tsx";
import { ConnectionIndicator } from "./ConnectionIndicator.tsx";
import { useAuth } from "../auth/AuthContext.tsx";
import { useApi } from "../hooks/useApi.ts";
import { api } from "../api/client.ts";
import { eventHub } from "../api/sse.ts";
import { useToast } from "./Toast.tsx";

const NAV_ITEMS = [
  { to: "/inbox", label: "Inbox", badge: "pending" as const },
  { to: "/dashboard", label: "Dashboard" },
  { to: "/briefings", label: "Briefings" },
  { to: "/tasks", label: "Tasks" },
  { to: "/agents", label: "Agents" },
  { to: "/contacts", label: "Contacts" },
  { to: "/inbound", label: "Inbound" },
  { to: "/knowledge", label: "Knowledge" },
  { to: "/memory", label: "Memory" },
  { to: "/scorecards", label: "Scorecards" },
  { to: "/routines", label: "Routines" },
  { to: "/setup", label: "Setup" },
  { to: "/settings", label: "Settings" },
];

export function Shell() {
  const { status, logout } = useAuth();
  const { notify } = useToast();
  const [navOpen, setNavOpen] = useState(false);

  // Sending stopping on its own is something a human must notice, wherever they are in the app.
  useEffect(
    () =>
      eventHub.subscribe("outbound.auto_paused", (e) => {
        const reason = typeof e.reason === "string" ? e.reason : "a readiness check failed";
        notify(`Outbound sending was paused automatically — ${reason}. Fix it on the Setup page, then re-enable.`, "error");
      }),
    [notify],
  );
  const { data } = useApi(
    () => api.listOutbox({ status: ["pending_approval"], limit: 200 }),
    [],
    ["outbox.drafted", "outbox.updated"],
  );
  const { data: waitingData } = useApi(
    () => api.listTasks({ status: ["waiting_approval"], limit: 200 }),
    [],
    ["task.transition"],
  );
  // Inbox badge = everything waiting on a human: drafts to approve + tasks the agent handed back.
  const pendingCount = (data?.items.length ?? 0) + (waitingData?.tasks.length ?? 0);

  return (
    <div className="shell">
      <header className="topbar">
        <button
          type="button"
          className="btn btn-ghost nav-toggle"
          aria-label="Toggle navigation"
          onClick={() => setNavOpen((v) => !v)}
        >
          ☰
        </button>
        <div style={{ flex: 1 }} />
        <QuietHoursPill status={status} />
        <StatusPill status={status} />
        <ConnectionIndicator />
        <button type="button" className="btn btn-sm" onClick={logout}>
          Sign out
        </button>
      </header>

      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}

      <nav className={`nav ${navOpen ? "open" : ""}`}>
        <div className="nav-brand">agy-ui</div>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
            onClick={() => setNavOpen(false)}
          >
            <span>{item.label}</span>
            {item.badge === "pending" && pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}
          </NavLink>
        ))}
      </nav>

      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
