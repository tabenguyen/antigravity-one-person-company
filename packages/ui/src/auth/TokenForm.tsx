import { useState, type FormEvent } from "react";
import { useAuth } from "./AuthContext.tsx";

export function TokenForm() {
  const { login, error: authError } = useAuth();
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setSubmitting(true);
    setLocalError(null);
    try {
      await login(value.trim());
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="token-gate">
      <form className="token-form" onSubmit={handleSubmit}>
        <h1>agy-ui</h1>
        <p>
          Paste the admin token from <code>&lt;dataDir&gt;/admin-token</code> to continue.
        </p>
        <label htmlFor="token-input">Admin token</label>
        <input
          id="token-input"
          name="token"
          type="password"
          autoComplete="off"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="paste token here"
        />
        {(localError ?? authError) && (
          <p className="form-error" role="alert">
            {localError ?? authError}
          </p>
        )}
        <button type="submit" disabled={submitting || !value.trim()}>
          {submitting ? "Checking…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
