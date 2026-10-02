import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../api/client.ts";
import { useToast } from "../../components/Toast.tsx";

export function AddContactForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { notify } = useToast();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [companyDomain, setCompanyDomain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { created } = await api.createContact({
        email: email.trim(),
        name: name.trim() || undefined,
        companyName: companyName.trim() || undefined,
        companyDomain: companyDomain.trim() || undefined,
      });
      notify(created ? "Contact created." : "Existing contact updated.", "success");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add contact</h2>
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="contact-email">Email</label>
            <input id="contact-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="contact-name">Name</label>
            <input id="contact-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="form-row">
            <div className="field">
              <label htmlFor="contact-company">Company name</label>
              <input id="contact-company" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="contact-domain">Company domain</label>
              <input id="contact-domain" value={companyDomain} onChange={(e) => setCompanyDomain(e.target.value)} />
            </div>
          </div>
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
