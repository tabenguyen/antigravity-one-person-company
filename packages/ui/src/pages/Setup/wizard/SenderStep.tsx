import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../../api/client.ts";
import { setupWizardApi } from "../../../api/setupWizard.ts";
import { useApi } from "../../../hooks/useApi.ts";
import { useToast } from "../../../components/Toast.tsx";
import { useRegisterStep, useWizard } from "./WizardContext.tsx";

interface Form {
  name: string;
  address: string;
  companyAddressLine: string;
  unsubscribeMailto: string;
}
type Key = keyof Form;
const EMPTY: Form = { name: "", address: "", companyAddressLine: "", unsubscribeMailto: "" };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Exactly what the server appends to every outgoing email (see ensureFooter in server/src/sender.ts). */
export function buildFooter(f: Form): string {
  const lines = ["", "--"];
  if (f.name.trim()) lines.push(f.name.trim());
  if (f.companyAddressLine.trim()) lines.push(f.companyAddressLine.trim());
  if (f.unsubscribeMailto.trim()) lines.push(`Don't want these emails? Reply "unsubscribe" or email ${f.unsubscribeMailto.trim()}.`);
  return lines.join("\n");
}

function validate(f: Form): Partial<Record<Key, string>> {
  const e: Partial<Record<Key, string>> = {};
  if (!f.name.trim()) e.name = "Nhập tên người gửi.";
  else if (f.name.length > 200) e.name = "Tối đa 200 ký tự.";
  if (!EMAIL_RE.test(f.address.trim())) e.address = "Nhập địa chỉ email hợp lệ.";
  if (f.companyAddressLine.trim().length < 5) e.companyAddressLine = "Nhập địa chỉ công ty (ít nhất 5 ký tự).";
  else if (f.companyAddressLine.length > 500) e.companyAddressLine = "Tối đa 500 ký tự.";
  if (!EMAIL_RE.test(f.unsubscribeMailto.trim())) e.unsubscribeMailto = "Nhập địa chỉ email hợp lệ.";
  return e;
}

/** Step 4: sender identity + unsubscribe address, with a live preview of the email footer. */
export function SenderStep() {
  const { jobs, refreshReadiness } = useWizard();
  const { notify } = useToast();
  const sender = useApi(() => setupWizardApi.getSender().catch(() => null), []);
  const email = useApi(() => setupWizardApi.getEmail().catch(() => null), []);

  const [form, setForm] = useState<Form>(EMPTY);
  const [baseline, setBaseline] = useState(JSON.stringify(EMPTY));
  const [suggested, setSuggested] = useState<Partial<Form>>({});
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);
  const prefilled = useRef(false);

  const jobsReady = !jobs.loading;
  const senderReady = !sender.loading && !email.loading;

  // Prefill once everything we need has loaded: saved sender > email-step address (address only) > AI suggestion.
  useEffect(() => {
    if (prefilled.current || !senderReady || !jobsReady) return;
    prefilled.current = true;
    const saved = sender.data?.sender;
    const sug = jobs.latestDone?.result?.suggestedSender;
    const emailAddress = email.data?.email.address ?? "";
    const next: Form = { ...EMPTY };
    const fromSuggestion: Partial<Form> = {};
    const pick = (key: Key, savedVal: string | undefined, ...fallbacks: [string | null | undefined, boolean][]) => {
      if (savedVal && savedVal.trim()) {
        next[key] = savedVal;
        return;
      }
      for (const [val, isSuggestion] of fallbacks) {
        if (val && val.trim()) {
          next[key] = val;
          if (isSuggestion) fromSuggestion[key] = val;
          return;
        }
      }
    };
    pick("name", saved?.name, [sug?.name, true]);
    pick("address", saved?.address, [emailAddress, false], [sug?.address, true]);
    pick("companyAddressLine", saved?.companyAddressLine, [sug?.companyAddressLine, true]);
    pick("unsubscribeMailto", saved?.unsubscribeMailto, [sug?.unsubscribeMailto, true]);
    setForm(next);
    setSuggested(fromSuggestion);
    // Saved values form the baseline; suggestions / defaults count as unsaved changes.
    const base: Form = { ...EMPTY };
    for (const k of Object.keys(base) as Key[]) base[k] = saved?.[k]?.trim() ? saved[k] : "";
    setBaseline(JSON.stringify(base));
    setSavedOnce(!!saved && !!saved.name?.trim() && !!saved.unsubscribeMailto?.trim());
  }, [senderReady, jobsReady, sender.data, email.data, jobs.latestDone]);

  const dirty = JSON.stringify(form) !== baseline;

  function set(key: Key, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  }

  async function save(): Promise<boolean> {
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return false;
    setSaving(true);
    setSaveError(null);
    try {
      const body = {
        name: form.name.trim(),
        address: form.address.trim(),
        companyAddressLine: form.companyAddressLine.trim(),
        unsubscribeMailto: form.unsubscribeMailto.trim(),
      };
      const res = await setupWizardApi.putSender(body);
      const next: Form = {
        name: res.sender.name,
        address: res.sender.address,
        companyAddressLine: res.sender.companyAddressLine,
        unsubscribeMailto: res.sender.unsubscribeMailto,
      };
      setForm(next);
      setBaseline(JSON.stringify(next));
      setSuggested({});
      setSavedOnce(true);
      notify("Đã lưu thông tin người gửi.", "success");
      refreshReadiness();
      return true;
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }
  useRegisterStep(dirty, save);

  function row(key: Key, label: string, help: string, opts: { type?: string; placeholder?: string } = {}) {
    const err = errors[key];
    const isSuggestion = suggested[key] !== undefined && suggested[key] === form[key];
    return (
      <div className="field">
        <label htmlFor={`sd-${key}`}>
          {label}
          {isSuggestion && <span className="pill pill-shadow wz-suggest">Gợi ý từ website</span>}
        </label>
        <input
          id={`sd-${key}`}
          type={opts.type ?? "text"}
          value={form[key]}
          placeholder={opts.placeholder}
          aria-invalid={err ? true : undefined}
          aria-describedby={`sd-${key}-help${err ? ` sd-${key}-err` : ""}`}
          onChange={(e) => set(key, e.target.value)}
        />
        <p className="setup-hint" id={`sd-${key}-help`}>
          {help}
        </p>
        {err && (
          <p className="form-error" id={`sd-${key}-err`}>
            {err}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="wz-step-body">
      <h2 className="wz-title">4. Người gửi</h2>
      <p className="muted">Thông tin hiện ở chân mọi email gửi đi. Luật chống thư rác yêu cầu có địa chỉ công ty và cách huỷ đăng ký.</p>

      {(sender.error || email.error) && (
        <p className="form-error" role="alert">
          {sender.error ?? email.error}
        </p>
      )}

      <div className="wz-two">
        <form
          className="card wz-card"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          noValidate
          aria-busy={saving}
        >
          {row("name", "Tên người gửi", "Tên hoặc tên công ty ở chân email, ví dụ “Mai — Acme”.", { placeholder: "Mai — Acme" })}
          {row("address", "Địa chỉ gửi", "Mặc định là email ở bước 3. Phải là địa chỉ hộp thư đã kết nối.", { type: "email", placeholder: "mai@acme.vn" })}
          {row("companyAddressLine", "Địa chỉ công ty", "Một dòng, ví dụ “Acme Ltd, 12 Nguyễn Huệ, Q.1, TP.HCM”.", { placeholder: "Acme Ltd, 12 Nguyễn Huệ, Q.1, TP.HCM" })}
          {row("unsubscribeMailto", "Email nhận yêu cầu huỷ đăng ký", "Hộp thư bạn thật sự theo dõi. Có thể trùng địa chỉ gửi.", { type: "email", placeholder: "huy-dang-ky@acme.vn" })}
          {saveError && (
            <p className="form-error" role="alert">
              {saveError}
            </p>
          )}
          <div className="wz-actions">
            <button type="submit" className="btn btn-primary" disabled={saving || (!dirty && savedOnce)}>
              {saving ? "Đang lưu…" : "Lưu"}
            </button>
            {dirty && <span className="setup-hint">Có thay đổi chưa lưu.</span>}
          </div>
        </form>

        <section className="card wz-card" aria-labelledby="sd-preview-h">
          <h3 id="sd-preview-h">Xem trước chân email</h3>
          <p className="setup-hint">Người nhận sẽ thấy đúng như dưới đây, nằm sau nội dung email.</p>
          <pre className="wz-footer-preview" data-testid="footer-preview" aria-live="polite">
            {buildFooter(form)}
          </pre>
        </section>
      </div>
    </div>
  );
}
