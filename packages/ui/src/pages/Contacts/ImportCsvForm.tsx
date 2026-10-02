import { useState } from "react";
import { api, ApiError } from "../../api/client.ts";
import { useToast } from "../../components/Toast.tsx";
import { parseCsv } from "../../lib/csv.ts";
import type { CreateContactRequest } from "../../api/types.ts";

const FIELDS: { key: keyof CreateContactRequest; label: string; required?: boolean }[] = [
  { key: "email", label: "Email", required: true },
  { key: "name", label: "Name" },
  { key: "title", label: "Title" },
  { key: "phone", label: "Phone" },
  { key: "linkedinUrl", label: "LinkedIn URL" },
  { key: "language", label: "Language" },
  { key: "source", label: "Source" },
  { key: "companyName", label: "Company name" },
  { key: "companyDomain", label: "Company domain" },
];

const NONE = "__none__";

export function ImportCsvForm({ onClose, onImported }: { onClose: () => void; onImported: (count: number) => void }) {
  const { notify } = useToast();
  const [rows, setRows] = useState<string[][] | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const headers = rows?.[0] ?? [];
  const dataRows = rows ? rows.slice(1) : [];

  function handleFile(file: File) {
    file
      .text()
      .then((text) => {
        const parsed = parseCsv(text);
        if (parsed.length === 0) {
          setError("CSV appears to be empty.");
          return;
        }
        setRows(parsed);
        // Best-effort auto-mapping by matching header names case-insensitively.
        const auto: Record<string, string> = {};
        parsed[0]!.forEach((h, i) => {
          const match = FIELDS.find((f) => f.key.toLowerCase() === h.trim().toLowerCase() || f.label.toLowerCase() === h.trim().toLowerCase());
          if (match) auto[match.key] = String(i);
        });
        setMapping(auto);
        setError(null);
      })
      .catch(() => setError("Could not read that file."));
  }

  function buildContacts(): CreateContactRequest[] | null {
    const emailCol = mapping.email;
    if (emailCol === undefined || emailCol === NONE) {
      setError("Map a column to Email before importing.");
      return null;
    }
    const contacts: CreateContactRequest[] = [];
    for (const row of dataRows) {
      const email = row[Number(emailCol)]?.trim();
      if (!email) continue;
      const contact: Record<string, string> = { email };
      for (const field of FIELDS) {
        if (field.key === "email") continue;
        const col = mapping[field.key];
        if (col === undefined || col === NONE) continue;
        const value = row[Number(col)]?.trim();
        if (value) contact[field.key] = value;
      }
      contacts.push(contact as unknown as CreateContactRequest);
    }
    if (contacts.length === 0) {
      setError("No rows with a valid email to import.");
      return null;
    }
    return contacts;
  }

  async function handleImport() {
    const contacts = buildContacts();
    if (!contacts) return;
    setSubmitting(true);
    setError(null);
    try {
      const { contacts: imported } = await api.importContacts({ contacts });
      notify(`Imported ${imported.length} contact(s).`, "success");
      onImported(imported.length);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 680 }} onClick={(e) => e.stopPropagation()}>
        <h2>Import contacts from CSV</h2>
        {!rows && (
          <div className="field">
            <label htmlFor="csv-file">CSV file</label>
            <input
              id="csv-file"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
          </div>
        )}

        {rows && (
          <>
            <h3>Map columns</h3>
            <div className="card-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
              {FIELDS.map((f) => (
                <div className="field" key={f.key}>
                  <label htmlFor={`map-${f.key}`}>
                    {f.label}
                    {f.required ? " *" : ""}
                  </label>
                  <select
                    id={`map-${f.key}`}
                    value={mapping[f.key] ?? NONE}
                    onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}
                  >
                    <option value={NONE}>(ignore)</option>
                    {headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <h3>Preview ({dataRows.length} row(s))</h3>
            <div style={{ maxHeight: 180, overflow: "auto" }}>
              <table>
                <thead>
                  <tr>
                    {headers.map((h, i) => (
                      <th key={i}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dataRows.slice(0, 5).map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          {rows && (
            <button type="button" className="btn btn-primary" onClick={handleImport} disabled={submitting}>
              {submitting ? "Importing…" : `Import ${dataRows.length} row(s)`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
