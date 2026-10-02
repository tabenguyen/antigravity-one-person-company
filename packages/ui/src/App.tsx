import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthContext.tsx";
import { TokenForm } from "./auth/TokenForm.tsx";
import { Shell } from "./components/Shell.tsx";
import { InboxPage } from "./pages/Inbox/InboxPage.tsx";
import { DashboardPage } from "./pages/Dashboard/DashboardPage.tsx";
import { TasksPage } from "./pages/Tasks/TasksPage.tsx";
import { TaskDetailPage } from "./pages/Tasks/TaskDetailPage.tsx";
import { AgentsPage } from "./pages/Agents/AgentsPage.tsx";
import { ContactsPage } from "./pages/Contacts/ContactsPage.tsx";
import { ContactDetailPage } from "./pages/Contacts/ContactDetailPage.tsx";
import { InboundPage } from "./pages/Inbound/InboundPage.tsx";
import { KnowledgePage } from "./pages/Knowledge/KnowledgePage.tsx";
import { MemoryPage } from "./pages/Memory/MemoryPage.tsx";
import { SettingsPage } from "./pages/Settings/SettingsPage.tsx";
import { SetupPage } from "./pages/Setup/SetupPage.tsx";
import { ScorecardsPage } from "./pages/Scorecards/ScorecardsPage.tsx";
import { RoutinesPage } from "./pages/Routines/RoutinesPage.tsx";

export function App() {
  const { authenticated, checking } = useAuth();

  if (checking) {
    return <div className="app-loading">Loading agy-ui…</div>;
  }

  if (!authenticated) {
    return <TokenForm />;
  }

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Navigate to="/inbox" replace />} />
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/tasks/:id" element={<TaskDetailPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/contacts/:id" element={<ContactDetailPage />} />
        <Route path="/inbound" element={<InboundPage />} />
        <Route path="/knowledge" element={<KnowledgePage />} />
        <Route path="/memory" element={<MemoryPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/scorecards" element={<ScorecardsPage />} />
        <Route path="/routines" element={<RoutinesPage />} />
        <Route path="*" element={<Navigate to="/inbox" replace />} />
      </Route>
    </Routes>
  );
}
