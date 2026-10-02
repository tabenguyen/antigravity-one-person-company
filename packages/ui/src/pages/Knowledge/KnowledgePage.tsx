import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError } from "../../api/client.ts";
import { useApi } from "../../hooks/useApi.ts";
import { useToast } from "../../components/Toast.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { formatDateTime } from "../../lib/time.ts";
import type { KbDocSummary, KbHit } from "../../api/types.ts";

export function KnowledgePage() {
  const { notify } = useToast();
  const { data, error, refresh } = useApi(() => api.listKbDocs(), [], ["kb.synced"]);
  const [selected, setSelected] = useState<KbDocSummary | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const grouped = useMemo(() => {
    const map = new Map<string, KbDocSummary[]>();
    for (const doc of data?.docs ?? []) {
      const list = map.get(doc.scope) ?? [];
      list.push(doc);
      map.set(doc.scope, list);
    }
    return map;
  }, [data]);

  async function handleSync() {
    setSyncing(true);
    try {
      const result = await api.syncKb();
      notify(`Synced: ${result.scanned} scanned, ${result.changed} changed, ${result.deleted} deleted.`, "success");
      refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Knowledge base</h1>
        <div className="inbox-detail-actions">
          <button type="button" className="btn" onClick={handleSync} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync"}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)}>
            New doc
          </button>
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="two-col">
        <div className="card">
          {[...grouped.entries()].map(([scope, docs]) => (
            <div key={scope} style={{ marginBottom: 16 }}>
              <h3>{scope}</h3>
              {docs.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  className={`inbox-row ${selected?.id === doc.id ? "selected" : ""}`}
                  style={{ borderRadius: 6, marginBottom: 2 }}
                  onClick={() => setSelected(doc)}
                >
                  {doc.title}
                  <div className="faint">{formatDateTime(doc.updatedAt)}</div>
                </button>
              ))}
            </div>
          ))}
          {data && data.docs.length === 0 && <p className="empty-state">No docs yet. Sync or create one.</p>}

          <KbSearchTester />
        </div>

        <div>
          {selected ? (
            <DocEditor
              doc={selected}
              onDeleted={() => {
                setSelected(null);
                refresh();
              }}
              onSaved={refresh}
            />
          ) : (
            <div className="card">
              <p className="empty-state">Select a document to edit it.</p>
            </div>
          )}
        </div>
      </div>

      {showNew && (
        <NewDocForm
          onClose={() => setShowNew(false)}
          onCreated={(doc) => {
            setShowNew(false);
            refresh();
            setSelected(doc);
          }}
        />
      )}
    </div>
  );
}

function DocEditor({ doc, onDeleted, onSaved }: { doc: KbDocSummary; onDeleted: () => void; onSaved: () => void }) {
  const { notify } = useToast();
  const { data, loading } = useApi(() => api.getKbDoc(doc.id), [doc.id]);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setBody(data?.doc.body ?? "");
  }, [data]);

  const dirty = data ? body !== data.doc.body : false;

  async function save() {
    if (!data) return;
    const relPath = data.doc.relPath;
    if (!relPath) {
      notify("This document has no editable path.", "error");
      return;
    }
    setSaving(true);
    try {
      await api.putKbFile({ scope: data.doc.scope, relPath, body });
      notify("Saved.", "success");
      onSaved();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    } finally {
      setSaving(false);
    }
  }

  async function del() {
    if (!data?.doc.relPath) return;
    if (!confirm(`Delete ${data.doc.title}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await api.deleteKbFile({ scope: data.doc.scope, relPath: data.doc.relPath });
      notify("Deleted.", "success");
      onDeleted();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "error");
    } finally {
      setDeleting(false);
    }
  }

  if (loading && !data) return <p className="empty-state">Loading…</p>;

  return (
    <div className="card">
      <div className="page-header">
        <h2>
          {doc.title}
          {dirty && <span className="dirty-dot" />}
        </h2>
        <div className="inbox-detail-actions">
          <button type="button" className="btn btn-sm" onClick={save} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" className="btn btn-danger btn-sm" onClick={del} disabled={deleting}>
            Delete
          </button>
        </div>
      </div>
      <div className="kb-editor-layout">
        <textarea value={body} onChange={(e) => setBody(e.target.value)} aria-label="Document body" rows={20} />
        <Markdown source={body} />
      </div>
    </div>
  );
}

function NewDocForm({ onClose, onCreated }: { onClose: () => void; onCreated: (doc: KbDocSummary) => void }) {
  const { notify } = useToast();
  const [scope, setScope] = useState("company");
  const [relPath, setRelPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!/^(company|role:[a-z-]+)$/.test(scope)) {
      setError('Scope must be "company" or "role:<role>".');
      return;
    }
    if (!/^[\w\-./]+\.md$/.test(relPath)) {
      setError("Path must be a relative .md path (letters, numbers, -, _, ., /).");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { doc } = await api.putKbFile({ scope, relPath, body: `# ${relPath}\n\n` });
      notify("Document created.", "success");
      onCreated(doc);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New document</h2>
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="doc-scope">Scope</label>
            <input id="doc-scope" value={scope} onChange={(e) => setScope(e.target.value)} placeholder="company or role:sales-sdr" />
          </div>
          <div className="field">
            <label htmlFor="doc-path">Path</label>
            <input id="doc-path" value={relPath} onChange={(e) => setRelPath(e.target.value)} placeholder="pricing.md" />
          </div>
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function KbSearchTester() {
  const [query, setQuery] = useState("");
  const [scopes, setScopes] = useState("company");
  const [results, setResults] = useState<KbHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  async function search(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const { results } = await api.searchKb(query.trim(), scopes, 10);
      setResults(results);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h3>Search tester</h3>
      <form onSubmit={search} className="form-row">
        <input placeholder="query" value={query} onChange={(e) => setQuery(e.target.value)} />
        <input placeholder="scopes (comma-separated)" value={scopes} onChange={(e) => setScopes(e.target.value)} />
        <button type="submit" className="btn btn-sm" disabled={searching}>
          Search
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
      {results?.map((r) => (
        <div key={r.docId} className="timeline-item">
          <strong>{r.title}</strong> <span className="faint">({r.scope}, score {r.score.toFixed(2)})</span>
          <p className="muted">{r.snippet}</p>
        </div>
      ))}
      {results?.length === 0 && <p className="empty-state">No hits.</p>}
    </div>
  );
}
