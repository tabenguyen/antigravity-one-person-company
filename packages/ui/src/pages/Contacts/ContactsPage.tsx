import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client.ts";
import { useApi } from "../../hooks/useApi.ts";
import { AddContactForm } from "./AddContactForm.tsx";
import { ImportCsvForm } from "./ImportCsvForm.tsx";

export function ContactsPage() {
  const [query, setQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const { data, loading, error, refresh } = useApi(
    () => api.listContacts({ query: query || undefined, limit: 50 }),
    [query],
    ["contact.upserted", "contact.imported"],
  );

  return (
    <div>
      <div className="page-header">
        <h1>Contacts</h1>
        <div className="inbox-detail-actions">
          <button type="button" className="btn" onClick={() => setShowImport(true)}>
            Import CSV
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}>
            Add contact
          </button>
        </div>
      </div>

      <div className="filter-bar">
        <input
          type="search"
          placeholder="Search by name, email or company…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 320 }}
          aria-label="Search contacts"
        />
      </div>

      {error && <p className="form-error">{error}</p>}

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Company</th>
            <th>Stage</th>
            <th>Owner</th>
          </tr>
        </thead>
        <tbody>
          {data?.contacts.map((c) => (
            <tr key={c.id}>
              <td>
                <Link to={`/contacts/${c.id}`}>{c.name ?? "(no name)"}</Link>
              </td>
              <td>{c.email}</td>
              <td>{c.company?.name ?? "—"}</td>
              <td>
                <span className="chip">{c.stage}</span>
              </td>
              <td>{c.ownerAgentId ?? "—"}</td>
            </tr>
          ))}
          {!loading && data?.contacts.length === 0 && (
            <tr>
              <td colSpan={5} className="empty-state">
                No contacts found.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {showAdd && (
        <AddContactForm
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            refresh();
          }}
        />
      )}
      {showImport && (
        <ImportCsvForm
          onClose={() => setShowImport(false)}
          onImported={(count) => {
            setShowImport(false);
            refresh();
            void count;
          }}
        />
      )}
    </div>
  );
}
