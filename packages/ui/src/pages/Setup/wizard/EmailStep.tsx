import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../../api/client.ts";
import {
  setupWizardApi,
  type EmailSettingsInput,
  type EmailSettingsView,
  type EmailTestResult,
} from "../../../api/setupWizard.ts";
import { useApi } from "../../../hooks/useApi.ts";
import { useToast } from "../../../components/Toast.tsx";
import { useRegisterStep, useWizard } from "./WizardContext.tsx";

export type PresetKey = "gmail" | "outlook" | "zoho" | "other";

interface Preset {
  key: PresetKey;
  name: string;
  imap?: { host: string; port: number; secure: boolean };
  smtp?: { host: string; port: number; secure: boolean };
  help: string;
}

export const EMAIL_PRESETS: Preset[] = [
  {
    key: "gmail",
    name: "Gmail",
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    help: "Bật xác minh 2 bước cho tài khoản Google, rồi tạo App Password (Mật khẩu ứng dụng) tại myaccount.google.com/apppasswords và dán vào ô mật khẩu. Không dùng mật khẩu đăng nhập thường.",
  },
  {
    key: "outlook",
    name: "Outlook / Microsoft 365",
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    smtp: { host: "smtp.office365.com", port: 587, secure: false },
    help: "Cổng 587 dùng STARTTLS (không chọn SSL). Nếu tài khoản bật xác minh 2 bước, hãy dùng mật khẩu ứng dụng. Quản trị Microsoft 365 cần bật “SMTP AUTH” cho hộp thư này.",
  },
  {
    key: "zoho",
    name: "Zoho Mail",
    imap: { host: "imap.zoho.com", port: 993, secure: true },
    smtp: { host: "smtp.zoho.com", port: 465, secure: true },
    help: "Bật IMAP trong Zoho Mail → Settings → Mail Accounts, và tạo mật khẩu ứng dụng ở Zoho Accounts → Security → App Passwords. Tài khoản khu vực EU/IN dùng .eu / .in thay cho .com.",
  },
  {
    key: "other",
    name: "Khác",
    help: "Nhập thông tin IMAP (nhận thư) và SMTP (gửi thư) do nhà cung cấp email của bạn cấp.",
  },
];

interface FormState {
  preset: PresetKey | null;
  address: string;
  displayName: string;
  imapHost: string;
  imapPort: string;
  imapSecure: boolean;
  imapUser: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  smtpUser: string;
  mailbox: string;
  sentFolder: string;
  pollSec: string;
  separate: boolean;
  pass: string;
  imapPass: string;
  smtpPass: string;
}

const EMPTY: FormState = {
  preset: null,
  address: "",
  displayName: "",
  imapHost: "",
  imapPort: "993",
  imapSecure: true,
  imapUser: "",
  smtpHost: "",
  smtpPort: "465",
  smtpSecure: true,
  smtpUser: "",
  mailbox: "INBOX",
  sentFolder: "",
  pollSec: "60",
  separate: false,
  pass: "",
  imapPass: "",
  smtpPass: "",
};

function detectPreset(host: string): PresetKey {
  const p = EMAIL_PRESETS.find((x) => x.imap?.host === host);
  return p ? p.key : "other";
}

function fromView(v: EmailSettingsView): FormState {
  if (v.kind !== "imap-smtp" || !v.imap || !v.smtp) return EMPTY;
  return {
    ...EMPTY,
    preset: detectPreset(v.imap.host),
    address: v.address ?? "",
    displayName: v.displayName ?? "",
    imapHost: v.imap.host,
    imapPort: String(v.imap.port),
    imapSecure: v.imap.secure,
    imapUser: v.imap.user,
    smtpHost: v.smtp.host,
    smtpPort: String(v.smtp.port),
    smtpSecure: v.smtp.secure,
    smtpUser: v.smtp.user,
    mailbox: v.mailbox ?? "INBOX",
    sentFolder: v.sentFolder ?? "",
    pollSec: String(Math.round((v.pollIntervalMs ?? 60000) / 1000)),
  };
}

type Errors = Partial<
  Record<
    | "address"
    | "imapHost"
    | "imapPort"
    | "imapUser"
    | "smtpHost"
    | "smtpPort"
    | "smtpUser"
    | "pollSec",
    string
  >
>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parsePort(v: string): number | null {
  if (!/^\d+$/.test(v.trim())) return null;
  const n = Number(v);
  return n >= 1 && n <= 65535 ? n : null;
}

export function buildEmailInput(f: FormState): {
  input: EmailSettingsInput | null;
  errors: Errors;
} {
  const errors: Errors = {};
  if (!EMAIL_RE.test(f.address.trim()))
    errors.address = "Nhập địa chỉ email hợp lệ, ví dụ ten@congty.vn.";
  if (!f.imapHost.trim()) errors.imapHost = "Nhập máy chủ IMAP.";
  if (!f.smtpHost.trim()) errors.smtpHost = "Nhập máy chủ SMTP.";
  const imapPort = parsePort(f.imapPort);
  const smtpPort = parsePort(f.smtpPort);
  if (imapPort === null) errors.imapPort = "Cổng phải là số từ 1 đến 65535.";
  if (smtpPort === null) errors.smtpPort = "Cổng phải là số từ 1 đến 65535.";
  if (!f.imapUser.trim()) errors.imapUser = "Nhập tên đăng nhập IMAP.";
  if (!f.smtpUser.trim()) errors.smtpUser = "Nhập tên đăng nhập SMTP.";
  const poll = Number(f.pollSec);
  if (!Number.isFinite(poll) || poll < 15 || poll > 3600)
    errors.pollSec = "Từ 15 đến 3600 giây.";
  if (Object.keys(errors).length > 0) return { input: null, errors };

  const imapPass = (f.separate ? f.imapPass : f.pass) || undefined;
  const smtpPass = (f.separate ? f.smtpPass : f.pass) || undefined;
  const input: EmailSettingsInput = {
    kind: "imap-smtp",
    address: f.address.trim(),
    ...(f.displayName.trim() ? { displayName: f.displayName.trim() } : {}),
    imap: {
      host: f.imapHost.trim(),
      port: imapPort!,
      secure: f.imapSecure,
      user: f.imapUser.trim(),
      ...(imapPass ? { pass: imapPass } : {}),
    },
    smtp: {
      host: f.smtpHost.trim(),
      port: smtpPort!,
      secure: f.smtpSecure,
      user: f.smtpUser.trim(),
      ...(smtpPass ? { pass: smtpPass } : {}),
    },
    mailbox: f.mailbox.trim() || "INBOX",
    sentFolder: f.sentFolder.trim() || null,
    pollIntervalMs: Math.round(poll * 1000),
  };
  return { input, errors };
}

/** Step 3: connect the mailbox (IMAP to receive, SMTP to send) with provider presets. */
export function EmailStep() {
  const { refreshReadiness } = useWizard();
  const { notify } = useToast();
  const email = useApi(() => setupWizardApi.getEmail(), []);
  const [view, setView] = useState<EmailSettingsView | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [baseline, setBaseline] = useState(JSON.stringify(EMPTY));
  const [errors, setErrors] = useState<Errors>({});
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<EmailTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loaded = useRef(false);
  useEffect(() => {
    if (email.data && !loaded.current) {
      loaded.current = true;
      const f = fromView(email.data.email);
      setView(email.data.email);
      setForm(f);
      setBaseline(JSON.stringify(f));
    }
  }, [email.data]);

  const dirty = JSON.stringify(form) !== baseline;

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setTest(null);
  }

  function setAddress(v: string) {
    setForm((f) => ({
      ...f,
      address: v,
      // Usernames mirror the address until the user types something different.
      imapUser: f.imapUser === "" || f.imapUser === f.address ? v : f.imapUser,
      smtpUser: f.smtpUser === "" || f.smtpUser === f.address ? v : f.smtpUser,
    }));
    setErrors((e) => ({ ...e, address: undefined }));
    setTest(null);
  }

  function pickPreset(p: Preset) {
    setForm((f) => ({
      ...f,
      preset: p.key,
      ...(p.imap
        ? {
            imapHost: p.imap.host,
            imapPort: String(p.imap.port),
            imapSecure: p.imap.secure,
          }
        : {}),
      ...(p.smtp
        ? {
            smtpHost: p.smtp.host,
            smtpPort: String(p.smtp.port),
            smtpSecure: p.smtp.secure,
          }
        : {}),
      ...(p.key === "gmail" ? { sentFolder: "" } : {}),
      imapUser: f.imapUser || f.address,
      smtpUser: f.smtpUser || f.address,
    }));
    setErrors({});
    setTest(null);
  }

  async function runTest() {
    const { input, errors: found } = buildEmailInput(form);
    setErrors(found);
    if (!input) return;
    setTesting(true);
    setTest(null);
    setTestError(null);
    try {
      setTest(await setupWizardApi.testEmail(input));
    } catch (err) {
      setTestError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setTesting(false);
      refreshReadiness();
    }
  }

  async function save(): Promise<boolean> {
    const { input, errors: found } = buildEmailInput(form);
    setErrors(found);
    if (!input) return false;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await setupWizardApi.putEmail(input);
      const f = fromView(res.email);
      setView(res.email);
      setForm(f);
      setBaseline(JSON.stringify(f));
      notify("Đã lưu cấu hình email.", "success");
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

  const preset = EMAIL_PRESETS.find((p) => p.key === form.preset) ?? null;
  const imapStored = !!view?.imap?.hasPassword;
  const smtpStored = !!view?.smtp?.hasPassword;
  const env = view?.passwordFromEnv;

  function field(
    id: keyof Errors,
    label: string,
    value: string,
    onChange: (v: string) => void,
    opts: { type?: string; placeholder?: string; inputMode?: "numeric" } = {},
  ) {
    const err = errors[id];
    return (
      <div className="field">
        <label htmlFor={`em-${id}`}>{label}</label>
        <input
          id={`em-${id}`}
          type={opts.type ?? "text"}
          inputMode={opts.inputMode}
          value={value}
          placeholder={opts.placeholder}
          aria-invalid={err ? true : undefined}
          aria-describedby={err ? `em-${id}-err` : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        {err && (
          <p className="form-error" id={`em-${id}-err`}>
            {err}
          </p>
        )}
      </div>
    );
  }

  function passwordField(
    id: string,
    label: string,
    value: string,
    onChange: (v: string) => void,
    stored: boolean,
  ) {
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          type="password"
          autoComplete="new-password"
          value={value}
          placeholder={stored ? "Đã lưu — để trống nếu không đổi" : ""}
          aria-describedby={stored ? `${id}-stored` : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        {stored && (
          <p className="setup-hint" id={`${id}-stored`}>
            ✓ Đã lưu — để trống nếu không đổi
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="wz-step-body">
      <h2 className="wz-title">3. Email</h2>
      <p className="muted">
        Hộp thư công ty để agent nhận thư trả lời và gửi email (sau khi bạn
        duyệt). Chọn nhà cung cấp để điền sẵn máy chủ.
      </p>

      {email.error && (
        <p className="form-error" role="alert">
          {email.error}
        </p>
      )}
      {view?.kind === "maildir" && (
        <p className="setup-hint wz-note" role="status">
          Đang dùng hộp thư thử (maildir). Lưu cấu hình IMAP/SMTP dưới đây sẽ
          thay thế nó.
        </p>
      )}
      {view?.source === "config" && view.kind === "imap-smtp" && (
        <p className="setup-hint wz-note" role="status">
          Cấu hình hiện lấy từ file cấu hình của hệ thống. Lưu ở đây sẽ ghi đè
          mà không cần khởi động lại.
        </p>
      )}
      {(env?.imap || env?.smtp) && (
        <p className="setup-hint wz-note" role="status">
          Mật khẩu {env.imap && "IMAP"}
          {env.imap && env.smtp && " và "}
          {env.smtp && "SMTP"} đang lấy từ biến môi trường (
          {[env.imap && "AGYHQ_IMAP_PASS", env.smtp && "AGYHQ_SMTP_PASS"]
            .filter(Boolean)
            .join(", ")}
          ) và luôn được ưu tiên hơn mật khẩu nhập ở đây.
        </p>
      )}

      {!view && !email.error && <p className="empty-state">Đang tải…</p>}
      {(view || email.error) && (
        <>
          <section
            className="card wz-card"
            aria-labelledby="em-provider-heading"
          >
            <h3 id="em-provider-heading">Nhà cung cấp</h3>
            <div
              className="wz-presets"
              role="group"
              aria-labelledby="em-provider-heading"
            >
              {EMAIL_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className="wz-preset"
                  aria-pressed={form.preset === p.key}
                  onClick={() => pickPreset(p)}
                >
                  {p.name}
                </button>
              ))}
            </div>
            {preset && (
              <p className="setup-hint wz-note" role="note">
                {preset.help}
              </p>
            )}
          </section>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            noValidate
            aria-busy={saving}
          >
            <section className="card wz-card">
              <h3>Tài khoản</h3>
              {field("address", "Địa chỉ email", form.address, setAddress, {
                type: "email",
                placeholder: "ten@congty.vn",
              })}
              <div className="field">
                <label htmlFor="em-displayName">Tên hiển thị</label>
                <input
                  id="em-displayName"
                  type="text"
                  value={form.displayName}
                  placeholder="VD: Mai — Acme"
                  onChange={(e) => set("displayName", e.target.value)}
                />
                <p className="setup-hint">Tên người nhận thấy ở ô “Từ”.</p>
              </div>

              {form.separate ? (
                <>
                  {passwordField(
                    "em-imapPass",
                    "Mật khẩu IMAP",
                    form.imapPass,
                    (v) => set("imapPass", v),
                    imapStored,
                  )}
                  {passwordField(
                    "em-smtpPass",
                    "Mật khẩu SMTP",
                    form.smtpPass,
                    (v) => set("smtpPass", v),
                    smtpStored,
                  )}
                </>
              ) : (
                passwordField(
                  "em-pass",
                  "Mật khẩu (dùng chung cho IMAP và SMTP)",
                  form.pass,
                  (v) => set("pass", v),
                  imapStored && smtpStored,
                )
              )}
              <label className="wz-check">
                <input
                  type="checkbox"
                  checked={form.separate}
                  onChange={(e) => set("separate", e.target.checked)}
                />
                Dùng mật khẩu riêng cho IMAP và SMTP
              </label>
            </section>

            <div className="wz-two">
              <section className="card wz-card" aria-labelledby="em-imap-h">
                <h3 id="em-imap-h">Nhận thư (IMAP)</h3>
                {field(
                  "imapHost",
                  "Máy chủ IMAP",
                  form.imapHost,
                  (v) => set("imapHost", v),
                  { placeholder: "imap.example.com" },
                )}
                {field(
                  "imapPort",
                  "Cổng IMAP",
                  form.imapPort,
                  (v) => set("imapPort", v),
                  { inputMode: "numeric" },
                )}
                <label className="wz-check">
                  <input
                    type="checkbox"
                    checked={form.imapSecure}
                    onChange={(e) => set("imapSecure", e.target.checked)}
                  />
                  Dùng SSL/TLS (IMAP)
                </label>
                {field("imapUser", "Tên đăng nhập IMAP", form.imapUser, (v) =>
                  set("imapUser", v),
                )}
              </section>
              <section className="card wz-card" aria-labelledby="em-smtp-h">
                <h3 id="em-smtp-h">Gửi thư (SMTP)</h3>
                {field(
                  "smtpHost",
                  "Máy chủ SMTP",
                  form.smtpHost,
                  (v) => set("smtpHost", v),
                  { placeholder: "smtp.example.com" },
                )}
                {field(
                  "smtpPort",
                  "Cổng SMTP",
                  form.smtpPort,
                  (v) => set("smtpPort", v),
                  { inputMode: "numeric" },
                )}
                <label className="wz-check">
                  <input
                    type="checkbox"
                    checked={form.smtpSecure}
                    onChange={(e) => set("smtpSecure", e.target.checked)}
                  />
                  Dùng SSL/TLS (SMTP)
                </label>
                <p className="setup-hint">
                  Bỏ chọn nếu dùng STARTTLS (thường là cổng 587).
                </p>
                {field("smtpUser", "Tên đăng nhập SMTP", form.smtpUser, (v) =>
                  set("smtpUser", v),
                )}
              </section>
            </div>

            <details className="wz-advanced card wz-card">
              <summary>Nâng cao</summary>
              <div className="field">
                <label htmlFor="em-mailbox">Thư mục nhận (mailbox)</label>
                <input
                  id="em-mailbox"
                  type="text"
                  value={form.mailbox}
                  onChange={(e) => set("mailbox", e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="em-sent">Thư mục đã gửi</label>
                <input
                  id="em-sent"
                  type="text"
                  value={form.sentFolder}
                  placeholder="Để trống nếu máy chủ tự lưu thư đã gửi (Gmail)"
                  onChange={(e) => set("sentFolder", e.target.value)}
                />
              </div>
              {field(
                "pollSec",
                "Kiểm tra thư mới mỗi (giây)",
                form.pollSec,
                (v) => set("pollSec", v),
                { inputMode: "numeric" },
              )}
            </details>

            <section className="card wz-card" aria-labelledby="em-test-h">
              <h3 id="em-test-h">Kiểm tra</h3>
              <p className="muted">
                Thử đăng nhập bằng thông tin ở trên, chưa lưu gì. Có thể mất vài
                chục giây.
              </p>
              <div className="wz-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={runTest}
                  disabled={testing}
                  aria-busy={testing}
                >
                  {testing ? "Đang kiểm tra…" : "Kiểm tra kết nối"}
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving || !dirty}
                >
                  {saving ? "Đang lưu…" : "Lưu"}
                </button>
              </div>
              <div role="status" aria-live="polite" className="wz-test">
                {test && (
                  <ul className="wz-test-list">
                    {(["imap", "smtp"] as const).map((k) => (
                      <li
                        key={k}
                        className={test[k].ok ? "wz-ok" : "form-error"}
                      >
                        {test[k].ok
                          ? `✓ ${k.toUpperCase()}: kết nối được`
                          : `✗ ${k.toUpperCase()}: không kết nối được — ${test[k].error ?? "lỗi không rõ"}`}
                      </li>
                    ))}
                  </ul>
                )}
                {testError && <p className="form-error">{testError}</p>}
              </div>
              {saveError && (
                <p className="form-error" role="alert">
                  {saveError}
                </p>
              )}
            </section>
          </form>
        </>
      )}
    </div>
  );
}
