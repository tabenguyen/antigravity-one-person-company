import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ApiError } from "../../api/client.ts";
import { readinessApi, type CompanyProfile, type CompanyProfileInput } from "../../api/readiness.ts";
import { useToast } from "../../components/Toast.tsx";
import { formatDateTime } from "../../lib/time.ts";
import "./setup.css";

interface FormValues {
  companyName: string;
  website: string;
  oneLiner: string;
  productDescription: string;
  targetCustomers: string;
  painPoints: string;
  differentiators: string;
  pricingPolicy: string;
  proofPoints: string;
  forbiddenClaims: string;
  meetingLink: string;
  languages: string[];
}

const EMPTY: FormValues = {
  companyName: "",
  website: "",
  oneLiner: "",
  productDescription: "",
  targetCustomers: "",
  painPoints: "",
  differentiators: "",
  pricingPolicy: "",
  proofPoints: "",
  forbiddenClaims: "",
  meetingLink: "",
  languages: ["vi", "en"],
};

type TextKey = Exclude<keyof FormValues, "languages">;

interface FieldDef {
  key: TextKey;
  label: string;
  required: boolean;
  min?: number;
  max: number;
  kind: "input" | "textarea" | "url";
  rows?: number;
  help: string;
  placeholder: string;
}

export const COMPANY_FIELD_DEFS: FieldDef[] = [
  {
    key: "companyName",
    label: "Company name",
    required: true,
    min: 1,
    max: 200,
    kind: "input",
    help: "Shown in every email footer and used whenever an agent introduces the company.",
    placeholder: "e.g. Acme Logistics",
  },
  {
    key: "website",
    label: "Website",
    required: false,
    max: 500,
    kind: "url",
    help: "Agents may link to it. Leave blank if you do not want links in emails.",
    placeholder: "https://acme.io",
  },
  {
    key: "oneLiner",
    label: "One-liner",
    required: true,
    min: 10,
    max: 300,
    kind: "input",
    help: "One sentence: what you sell and for whom. Agents reuse it in first-touch emails.",
    placeholder: "e.g. Inventory sync that stops overselling for multi-channel online sellers.",
  },
  {
    key: "productDescription",
    label: "Product description",
    required: true,
    min: 20,
    max: 20000,
    kind: "textarea",
    rows: 5,
    help: "What the product does, how it works, key features. Agents treat this as the only source of truth for product claims: anything not written here, they will say they need to check.",
    placeholder: "e.g. Acme keeps stock levels in sync across Shopee, Lazada, TikTok Shop and your own store in real time. Orders from every channel land in one dashboard…",
  },
  {
    key: "targetCustomers",
    label: "Target customers (ICP)",
    required: true,
    min: 10,
    max: 10000,
    kind: "textarea",
    rows: 4,
    help: "Industry, company size, geography and the buyer's role. Agents use this to qualify leads and decide who is worth contacting.",
    placeholder: "e.g. E-commerce retailers in Vietnam with 5-50 staff selling on two or more channels. Buyer: owner or head of operations.",
  },
  {
    key: "painPoints",
    label: "Pain points you solve",
    required: true,
    min: 10,
    max: 10000,
    kind: "textarea",
    rows: 4,
    help: "One problem per line. Agents frame outreach around these but will not claim a prospect has one without evidence.",
    placeholder: "- Overselling when stock runs out on one channel\n- Manual end-of-day inventory reconciliation",
  },
  {
    key: "differentiators",
    label: "Differentiators",
    required: false,
    max: 10000,
    kind: "textarea",
    rows: 3,
    help: "Optional. Why customers choose you over alternatives. If blank, agents describe the product factually and make no comparisons.",
    placeholder: "e.g. Set up in an afternoon with Vietnamese-language support; no per-order fees.",
  },
  {
    key: "pricingPolicy",
    label: "Pricing policy",
    required: true,
    min: 10,
    max: 10000,
    kind: "textarea",
    rows: 4,
    help: "Exactly what agents may say about price. Be explicit; anything beyond this they hand to a human.",
    placeholder: "e.g. Never quote numbers or discounts. Say plans start with a free 14-day pilot and offer a call to discuss pricing.",
  },
  {
    key: "proofPoints",
    label: "Proof points",
    required: false,
    max: 10000,
    kind: "textarea",
    rows: 3,
    help: "Optional. Case studies and numbers agents may cite, worded exactly as they may be quoted. If blank, agents cite none.",
    placeholder: "e.g. Used by 40 shops in Ho Chi Minh City. Reduced overselling incidents by 90% for Shop Hoa Mai (approved quote).",
  },
  {
    key: "forbiddenClaims",
    label: "Forbidden claims",
    required: false,
    max: 10000,
    kind: "textarea",
    rows: 3,
    help: "Optional. Things agents must never say or promise, one per line.",
    placeholder: "- Never promise zero overselling\n- Never name competitors\n- Never promise a delivery date",
  },
  {
    key: "meetingLink",
    label: "Meeting booking link",
    required: false,
    max: 500,
    kind: "url",
    help: "Optional. Offered when a prospect agrees to talk. If blank, agents ask for the prospect's availability instead.",
    placeholder: "https://cal.com/acme/intro",
  },
];


export type Locale = "en" | "vi";

/** Vietnamese copy for the wizard; English (above) stays the default for the standalone form. */
const VI_FIELDS: Record<TextKey, { label: string; help: string; placeholder: string }> = {
  companyName: {
    label: "Tên công ty",
    help: "Hiện ở chân mọi email và khi agent giới thiệu công ty.",
    placeholder: "VD: Công ty TNHH Acme",
  },
  website: {
    label: "Website",
    help: "Agent có thể gắn link này. Để trống nếu không muốn có link trong email.",
    placeholder: "https://acme.vn",
  },
  oneLiner: {
    label: "Giới thiệu một câu",
    help: "Một câu: bạn bán gì cho ai. Agent dùng lại trong email đầu tiên.",
    placeholder: "VD: Phần mềm đồng bộ tồn kho giúp người bán đa kênh không bán lố hàng.",
  },
  productDescription: {
    label: "Mô tả sản phẩm",
    help: "Sản phẩm làm gì, hoạt động ra sao, tính năng chính. Agent coi đây là nguồn duy nhất cho mọi khẳng định về sản phẩm; điều gì không có ở đây, agent sẽ nói là cần kiểm tra lại.",
    placeholder: "VD: Acme đồng bộ tồn kho theo thời gian thực giữa Shopee, Lazada, TikTok Shop và website của bạn…",
  },
  targetCustomers: {
    label: "Khách hàng mục tiêu",
    help: "Ngành, quy mô, khu vực và vai trò người mua. Agent dùng để chọn ai đáng liên hệ.",
    placeholder: "VD: Cửa hàng thương mại điện tử 5-50 nhân viên bán trên 2 kênh trở lên. Người mua: chủ shop hoặc trưởng vận hành.",
  },
  painPoints: {
    label: "Vấn đề bạn giải quyết",
    help: "Mỗi dòng một vấn đề. Agent xoay nội dung quanh các vấn đề này nhưng không khẳng định khách đang gặp nếu chưa có bằng chứng.",
    placeholder: "- Bán lố hàng khi một kênh hết tồn\n- Đối soát tồn kho thủ công cuối ngày",
  },
  differentiators: {
    label: "Điểm khác biệt",
    help: "Không bắt buộc. Vì sao khách chọn bạn thay vì lựa chọn khác. Để trống thì agent chỉ mô tả sản phẩm, không so sánh.",
    placeholder: "VD: Cài đặt trong một buổi chiều, hỗ trợ tiếng Việt, không phí theo đơn.",
  },
  pricingPolicy: {
    label: "Chính sách giá",
    help: "Chính xác điều agent được phép nói về giá. Ngoài phạm vi này, agent chuyển cho người.",
    placeholder: "VD: Không báo giá hay giảm giá. Chỉ nói có 14 ngày dùng thử và mời gọi một cuộc gọi để trao đổi.",
  },
  proofPoints: {
    label: "Bằng chứng, số liệu",
    help: "Không bắt buộc. Case study và con số agent được trích, viết đúng như được phép trích. Để trống thì agent không trích gì.",
    placeholder: "VD: 40 cửa hàng ở TP.HCM đang dùng. Giảm 90% sự cố bán lố tại Shop Hoa Mai (đã được đồng ý trích).",
  },
  forbiddenClaims: {
    label: "Điều không được nói",
    help: "Không bắt buộc. Những điều agent tuyệt đối không nói hay hứa, mỗi dòng một ý.",
    placeholder: "- Không hứa không bao giờ bán lố\n- Không nhắc tên đối thủ\n- Không hứa ngày giao",
  },
  meetingLink: {
    label: "Link đặt lịch hẹn",
    help: "Không bắt buộc. Gửi khi khách đồng ý trao đổi. Để trống thì agent hỏi lịch rảnh của khách.",
    placeholder: "https://cal.com/acme/intro",
  },
};

interface FormTexts {
  heading: string;
  saved: (when: string) => string;
  intro: React.ReactNode;
  loading: string;
  languages: string;
  languagesHelp: string;
  removeLanguage: (c: string) => string;
  addLanguageLabel: string;
  addLanguagePlaceholder: string;
  add: string;
  langInvalid: string;
  fixFields: (n: number) => string;
  save: string;
  saving: string;
  savedToast: string;
  filesWritten: string;
  required: (label: string) => string;
  tooShort: (label: string, n: number) => string;
  tooLong: (label: string, n: number) => string;
  badUrl: (label: string) => string;
  noLanguage: string;
}

const TEXTS: Record<Locale, FormTexts> = {
  en: {
    heading: "Company profile",
    saved: (w) => `saved ${w}`,
    intro: (
      <>
        Agents read this to know what you sell, to whom, and what they must never say. Saving renders it into the company knowledge base (
        <code>kb/company/</code>) and re-indexes it. Write for an AI reader: concrete, specific, no marketing fluff.
      </>
    ),
    loading: "Loading profile…",
    languages: "Languages",
    languagesHelp: "Languages agents may write in. They reply in the prospect's language when it is on this list; otherwise in the first one.",
    removeLanguage: (c) => `Remove language ${c}`,
    addLanguageLabel: "Add language code",
    addLanguagePlaceholder: "e.g. zh",
    add: "Add",
    langInvalid: "Use a short language code such as vi, en or zh-cn.",
    fixFields: (n) => `Please fix ${n} field${n === 1 ? "" : "s"} above.`,
    save: "Save company profile",
    saving: "Saving…",
    savedToast: "Company profile saved. Knowledge base updated.",
    filesWritten: "Knowledge base files written:",
    required: (l) => `${l} is required.`,
    tooShort: (l, n) => `${l} must be at least ${n} characters.`,
    tooLong: (l, n) => `${l} must be at most ${n} characters.`,
    badUrl: (l) => `${l} must be a full URL starting with https://`,
    noLanguage: "Add at least one language.",
  },
  vi: {
    heading: "Hồ sơ công ty",
    saved: (w) => `đã lưu ${w}`,
    intro: (
      <>
        Agent đọc phần này để biết bạn bán gì, cho ai và điều gì tuyệt đối không được nói. Khi lưu, hồ sơ được ghi vào kiến thức công ty (
        <code>kb/company/</code>). Hãy viết cụ thể, rõ ràng, không văn quảng cáo.
      </>
    ),
    loading: "Đang tải hồ sơ…",
    languages: "Ngôn ngữ",
    languagesHelp: "Ngôn ngữ agent được phép viết. Agent trả lời theo ngôn ngữ của khách nếu có trong danh sách; nếu không thì dùng ngôn ngữ đầu tiên.",
    removeLanguage: (c) => `Bỏ ngôn ngữ ${c}`,
    addLanguageLabel: "Thêm mã ngôn ngữ",
    addLanguagePlaceholder: "VD: zh",
    add: "Thêm",
    langInvalid: "Dùng mã ngắn như vi, en hoặc zh-cn.",
    fixFields: (n) => `Vui lòng sửa ${n} ô ở trên.`,
    save: "Lưu hồ sơ",
    saving: "Đang lưu…",
    savedToast: "Đã lưu hồ sơ công ty và cập nhật kiến thức.",
    filesWritten: "Các tệp kiến thức đã ghi:",
    required: (l) => `Cần nhập ${l}.`,
    tooShort: (l, n) => `${l} cần ít nhất ${n} ký tự.`,
    tooLong: (l, n) => `${l} tối đa ${n} ký tự.`,
    badUrl: (l) => `${l} phải là địa chỉ đầy đủ, bắt đầu bằng https://`,
    noLanguage: "Thêm ít nhất một ngôn ngữ.",
  },
};

function fieldText(f: FieldDef, locale: Locale) {
  return locale === "vi" ? VI_FIELDS[f.key] : { label: f.label, help: f.help, placeholder: f.placeholder };
}

function fromInput(p: CompanyProfileInput): FormValues {
  return {
    companyName: p.companyName ?? "",
    website: p.website ?? "",
    oneLiner: p.oneLiner ?? "",
    productDescription: p.productDescription ?? "",
    targetCustomers: p.targetCustomers ?? "",
    painPoints: p.painPoints ?? "",
    differentiators: p.differentiators ?? "",
    pricingPolicy: p.pricingPolicy ?? "",
    proofPoints: p.proofPoints ?? "",
    forbiddenClaims: p.forbiddenClaims ?? "",
    meetingLink: p.meetingLink ?? "",
    languages: p.languages && p.languages.length ? p.languages : ["vi", "en"],
  };
}

export interface CompanyStepController {
  dirty: boolean;
  /** Validates and saves; resolves true when the profile was saved. */
  save: () => Promise<boolean>;
}

function toFormValues(p: CompanyProfile | null): FormValues {
  if (!p) return EMPTY;
  return {
    companyName: p.companyName,
    website: p.website ?? "",
    oneLiner: p.oneLiner,
    productDescription: p.productDescription,
    targetCustomers: p.targetCustomers,
    painPoints: p.painPoints,
    differentiators: p.differentiators,
    pricingPolicy: p.pricingPolicy,
    proofPoints: p.proofPoints,
    forbiddenClaims: p.forbiddenClaims,
    meetingLink: p.meetingLink ?? "",
    languages: p.languages.length ? p.languages : ["vi", "en"],
  };
}

function isUrl(v: string): boolean {
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}

/** Mirrors CompanyProfileInputZ so most mistakes are caught before a round trip. */
export function validateCompany(v: FormValues, locale: Locale = "en"): Partial<Record<keyof FormValues, string>> {
  const errors: Partial<Record<keyof FormValues, string>> = {};
  const t = TEXTS[locale];
  for (const f of COMPANY_FIELD_DEFS) {
    const value = v[f.key].trim();
    const label = fieldText(f, locale).label;
    if (f.required && value.length === 0) errors[f.key] = t.required(label);
    else if (value.length > 0 && f.min && value.length < f.min) errors[f.key] = t.tooShort(label, f.min);
    else if (value.length > f.max) errors[f.key] = t.tooLong(label, f.max);
    else if (f.kind === "url" && value.length > 0 && !isUrl(value)) errors[f.key] = t.badUrl(label);
  }
  if (v.languages.length === 0) errors.languages = t.noLanguage;
  return errors;
}

export function toInput(v: FormValues): CompanyProfileInput {
  return {
    companyName: v.companyName.trim(),
    website: v.website.trim() || null,
    oneLiner: v.oneLiner.trim(),
    productDescription: v.productDescription.trim(),
    targetCustomers: v.targetCustomers.trim(),
    painPoints: v.painPoints.trim(),
    differentiators: v.differentiators.trim(),
    pricingPolicy: v.pricingPolicy.trim(),
    proofPoints: v.proofPoints.trim(),
    forbiddenClaims: v.forbiddenClaims.trim(),
    meetingLink: v.meetingLink.trim() || null,
    languages: v.languages,
  };
}

export interface CompanyProfileFormProps {
  profile: CompanyProfile | null;
  loading: boolean;
  loadError: string | null;
  /** Called after a successful save so readiness can be re-checked. */
  onSaved: () => void;
  locale?: Locale;
  /** A draft (e.g. AI-generated) to load into the form whenever `draftKey` changes. Not saved until the user saves. */
  draft?: CompanyProfileInput | null;
  draftKey?: number;
  /** When set, saving is blocked and this message is shown next to the button. */
  saveBlockedReason?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  /** Receives a handle the wizard uses for "save & continue". */
  onController?: (c: CompanyStepController | null) => void;
  /** Hide the card heading/intro when the host page already provides one. */
  compact?: boolean;
}

export function CompanyProfileForm({
  profile,
  loading,
  loadError,
  onSaved,
  locale = "en",
  draft = null,
  draftKey = 0,
  saveBlockedReason = null,
  onDirtyChange,
  onController,
  compact = false,
}: CompanyProfileFormProps) {
  const t = TEXTS[locale];
  const { notify } = useToast();
  const [values, setValues] = useState<FormValues>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof FormValues, string>>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFiles, setSavedFiles] = useState<string[] | null>(null);
  const [langDraft, setLangDraft] = useState("");
  const [langError, setLangError] = useState<string | null>(null);

  // Baseline = what is saved (or empty); the form is "dirty" when it differs.
  const [baseline, setBaseline] = useState<string>(() => JSON.stringify(toInput(EMPTY)));

  useEffect(() => {
    if (profile) {
      const v = toFormValues(profile);
      setValues(v);
      setBaseline(JSON.stringify(toInput(v)));
    }
  }, [profile]);

  useEffect(() => {
    if (draft && draftKey > 0) {
      setValues(fromInput(draft));
      setErrors({});
      setServerError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  const dirty = JSON.stringify(toInput(values)) !== baseline;

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }

  function addLanguage() {
    const code = langDraft.trim().toLowerCase().replace(/,$/, "");
    if (!code) return;
    if (!/^[a-z]{2,3}(-[a-z0-9]{1,2})?$/.test(code) || code.length > 5) {
      setLangError(t.langInvalid);
      return;
    }
    setLangError(null);
    if (!values.languages.includes(code)) set("languages", [...values.languages, code]);
    setLangDraft("");
  }

  function onLangKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addLanguage();
    }
  }

  async function save(): Promise<boolean> {
    if (saveBlockedReason) return false;
    const found = validateCompany(values, locale);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setServerError(null);
      return false;
    }
    setSaving(true);
    setServerError(null);
    try {
      const input = toInput(values);
      const res = await readinessApi.putCompany(input);
      setSavedFiles(res.files ?? []);
      setBaseline(JSON.stringify(input));
      notify(t.savedToast, "success");
      onSaved();
      return true;
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void save();
  }

  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => {
    if (!onController) return;
    onController({ dirty, save: () => saveRef.current() });
    return () => onController(null);
  }, [dirty, onController]);

  const errorCount = Object.values(errors).filter(Boolean).length;

  return (
    <section className="card setup-section" id="company" aria-labelledby="company-heading">
      <div className="setup-card-head">
        <h2 id="company-heading">{t.heading}</h2>
        {profile?.updatedAt && <span className="faint">{t.saved(formatDateTime(profile.updatedAt))}</span>}
      </div>
      {!compact && <p className="muted">{t.intro}</p>}

      {loadError && (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      )}
      {loading && !profile && <p className="empty-state">{t.loading}</p>}

      <form className="setup-form" onSubmit={submit} noValidate aria-busy={saving}>
        {COMPANY_FIELD_DEFS.map((f) => {
          const ft = fieldText(f, locale);
          const id = `company-${f.key}`;
          const err = errors[f.key];
          const describedBy = `${id}-help${err ? ` ${id}-error` : ""}`;
          return (
            <div className="field" key={f.key}>
              <label htmlFor={id}>
                {ft.label}
                {f.required && (
                  <span className="req" aria-hidden="true">
                    *
                  </span>
                )}
              </label>
              {f.kind === "textarea" ? (
                <textarea
                  id={id}
                  rows={f.rows ?? 3}
                  value={values[f.key]}
                  placeholder={ft.placeholder}
                  required={f.required}
                  aria-invalid={err ? true : undefined}
                  aria-describedby={describedBy}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              ) : (
                <input
                  id={id}
                  type={f.kind === "url" ? "url" : "text"}
                  value={values[f.key]}
                  placeholder={ft.placeholder}
                  required={f.required}
                  aria-invalid={err ? true : undefined}
                  aria-describedby={describedBy}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              )}
              <p className="setup-hint" id={`${id}-help`}>
                {ft.help}
              </p>
              {err && (
                <p className="form-error" id={`${id}-error`}>
                  {err}
                </p>
              )}
            </div>
          );
        })}

        <div className="field" role="group" aria-labelledby="company-languages-label">
          <span id="company-languages-label" style={{ fontWeight: 600, fontSize: 12, color: "var(--color-text-muted)" }}>
            {t.languages}<span className="req" aria-hidden="true" style={{ color: "var(--color-danger)", marginLeft: 2 }}>*</span>
          </span>
          <div className="setup-chips">
            {values.languages.map((code) => (
              <span className="setup-chip" key={code}>
                {code}
                <button type="button" aria-label={t.removeLanguage(code)} onClick={() => set("languages", values.languages.filter((c) => c !== code))}>
                  ×
                </button>
              </span>
            ))}
            <span className="setup-chip-add">
              <input
                type="text"
                value={langDraft}
                onChange={(e) => setLangDraft(e.target.value)}
                onKeyDown={onLangKey}
                placeholder={t.addLanguagePlaceholder}
                maxLength={5}
                aria-label={t.addLanguageLabel}
                aria-describedby="company-languages-help"
              />
              <button type="button" className="btn btn-sm" onClick={addLanguage}>
                {t.add}
              </button>
            </span>
          </div>
          <p className="setup-hint" id="company-languages-help">
            {t.languagesHelp}
          </p>
          {langError && <p className="form-error">{langError}</p>}
          {errors.languages && <p className="form-error">{errors.languages}</p>}
        </div>

        {errorCount > 0 && (
          <p className="form-error" role="alert">
            {t.fixFields(errorCount)}
          </p>
        )}
        {serverError && (
          <p className="form-error" role="alert">
            {serverError}
          </p>
        )}

        {saveBlockedReason && (
          <p className="form-error" role="alert">
            {saveBlockedReason}
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={saving || !!saveBlockedReason}>
          {saving ? t.saving : t.save}
        </button>
      </form>

      {savedFiles && savedFiles.length > 0 && (
        <div role="status">
          <p className="setup-result">{t.filesWritten}</p>
          <ul className="setup-files">
            {savedFiles.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
