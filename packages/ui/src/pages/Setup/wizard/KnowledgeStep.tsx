import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../../api/client.ts";
import { setupWizardApi } from "../../../api/setupWizard.ts";
import { useApi } from "../../../hooks/useApi.ts";
import { ConfirmDialog } from "../../../components/ConfirmDialog.tsx";
import { Markdown } from "../../../components/Markdown.tsx";
import { useToast } from "../../../components/Toast.tsx";
import { useRegisterStep, useWizard } from "./WizardContext.tsx";

type Origin = "template" | "custom" | "ai";
interface KbFile {
  relPath: string;
  title: string;
  body: string;
  hasPlaceholders: boolean;
  origin: Origin;
  /** Body as loaded from the server; used to decide whether the server's placeholder flag still applies. */
  originalBody: string | null;
}

const PLACEHOLDER_RE = /\b(TODO|TBD|FIXME|XXX|lorem ipsum)\b|\{\{[^}]*\}\}|\[(?:your|insert|điền|company)[^\]]*\]|<(?:[A-Z_ ]{3,})>/i;
const FILE_RE = /^[\w-]+\.md$/;

function placeholders(f: KbFile): boolean {
  return f.originalBody !== null && f.body === f.originalBody ? f.hasPlaceholders : PLACEHOLDER_RE.test(f.body);
}

const ORIGIN_BADGE: Record<Origin, { label: string; cls: string }> = {
  template: { label: "Mẫu", cls: "pill-neutral" },
  custom: { label: "Đã tùy chỉnh", cls: "pill-success" },
  ai: { label: "AI tạo", cls: "pill-shadow" },
};

function signature(files: KbFile[]): string {
  return JSON.stringify(files.map((f) => [f.relPath, f.body]));
}

/** Step 2: edit the sales knowledge base (role KB) that overrides the built-in templates. */
export function KnowledgeStep() {
  const { jobs, refreshReadiness } = useWizard();
  const { notify } = useToast();
  const kb = useApi(() => setupWizardApi.getRoleKb("sales-sdr"), []);

  const [files, setFiles] = useState<KbFile[] | null>(null);
  const [baseline, setBaseline] = useState("");
  const [source, setSource] = useState<"override" | "template">("template");
  const [active, setActive] = useState(0);
  const [newName, setNewName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [confirmAi, setConfirmAi] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback((data: NonNullable<typeof kb.data>) => {
    const origin: Origin = data.source === "override" ? "custom" : "template";
    const list = data.files.map((f) => ({ ...f, origin, originalBody: f.body }));
    setFiles(list);
    setBaseline(signature(list));
    setSource(data.source);
    setActive(0);
  }, []);

  // First load only; later saves reload through `load` directly.
  const initialised = useRef(false);
  useEffect(() => {
    if (kb.data && !initialised.current) {
      initialised.current = true;
      load(kb.data);
    }
  }, [kb.data, load]);

  const dirty = files !== null && signature(files) !== baseline;
  const aiFiles = jobs.latestDone?.result?.roleKb.files ?? [];

  async function save(): Promise<boolean> {
    if (!files) return true;
    const bad = files.find((f) => !FILE_RE.test(f.relPath) || f.body.trim().length === 0);
    if (bad) {
      setSaveError(`Tệp “${bad.relPath}” cần có tên dạng ten-tep.md và nội dung không được để trống.`);
      return false;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await setupWizardApi.putRoleKb({ role: "sales-sdr", files: files.map((f) => ({ relPath: f.relPath, body: f.body })) });
      load(res);
      notify("Đã lưu kiến thức bán hàng.", "success");
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

  function update(i: number, body: string) {
    setFiles((prev) => prev && prev.map((f, idx) => (idx === i ? { ...f, body } : f)));
  }

  function addFile() {
    const name = newName.trim().toLowerCase().replace(/\s+/g, "-");
    const rel = name.endsWith(".md") ? name : `${name}.md`;
    if (!FILE_RE.test(rel)) return setNameError("Tên tệp chỉ gồm chữ, số, dấu - hoặc _, ví dụ bang-gia.md.");
    if (files?.some((f) => f.relPath === rel)) return setNameError("Đã có tệp trùng tên.");
    if ((files?.length ?? 0) >= 20) return setNameError("Tối đa 20 tệp.");
    setNameError(null);
    setNewName("");
    setFiles((prev) => [...(prev ?? []), { relPath: rel, title: rel, body: `# ${rel.replace(/\.md$/, "")}\n\n`, hasPlaceholders: false, origin: "custom", originalBody: null }]);
    setActive(files?.length ?? 0);
  }

  function removeFile(rel: string) {
    setFiles((prev) => prev && prev.filter((f) => f.relPath !== rel));
    setActive(0);
  }

  function applyAi() {
    const list: KbFile[] = aiFiles.map((f) => ({
      relPath: f.relPath,
      title: f.title,
      body: f.body,
      hasPlaceholders: false,
      origin: "ai",
      originalBody: null,
    }));
    setFiles(list);
    setActive(0);
  }

  const withPlaceholders = useMemo(() => (files ?? []).filter(placeholders), [files]);
  const current = files?.[Math.min(active, (files?.length ?? 1) - 1)] ?? null;
  const currentIdx = current && files ? files.indexOf(current) : 0;

  return (
    <div className="wz-step-body">
      <h2 className="wz-title">2. Kiến thức bán hàng</h2>
      <p className="muted">
        Đây là “sổ tay” agent SDR dùng khi viết email: khách hàng lý tưởng, cách tiếp cận, cách trả lời phản đối. Chỉnh cho đúng công ty bạn.
      </p>

      {kb.error && (
        <p className="form-error" role="alert">
          {kb.error}
        </p>
      )}
      {kb.loading && !files && <p className="empty-state">Đang tải…</p>}

      {files && source === "template" && !dirty && (
        <p className="setup-hint wz-note" role="status">
          Đang dùng bộ mẫu có sẵn. Hãy chỉnh lại cho đúng công ty bạn (hoặc dùng bản AI tạo), rồi bấm “Lưu tất cả”.
        </p>
      )}

      {aiFiles.length > 0 && (
        <section className="card wz-card" aria-labelledby="kb-ai-heading">
          <h3 id="kb-ai-heading">Bản AI tạo từ {jobs.latestDone?.domain}</h3>
          <p className="muted">AI đã soạn {aiFiles.length} tệp: {aiFiles.map((f) => f.relPath).join(", ")}. Dùng bản này sẽ thay toàn bộ các tệp hiện tại; chưa lưu cho đến khi bạn bấm “Lưu tất cả”.</p>
          <button type="button" className="btn" onClick={() => setConfirmAi(true)}>
            Dùng bản AI tạo
          </button>
        </section>
      )}

      {files && (
        <section className="card wz-card" aria-label="Soạn kiến thức">
          <div className="tabs" role="tablist" aria-label="Các tệp kiến thức">
            {files.map((f, i) => (
              <button
                key={f.relPath}
                type="button"
                role="tab"
                id={`kbtab-${i}`}
                aria-selected={i === currentIdx}
                aria-controls="kb-panel"
                className={i === currentIdx ? "tab active" : "tab"}
                onClick={() => setActive(i)}
              >
                {f.relPath}
                {placeholders(f) && <span aria-label="còn placeholder" title="Còn placeholder"> ⚠</span>}
              </button>
            ))}
          </div>

          {current && (
            <div id="kb-panel" role="tabpanel" aria-labelledby={`kbtab-${currentIdx}`}>
              <div className="wz-badges">
                <span className={`pill ${ORIGIN_BADGE[current.origin].cls}`}>{ORIGIN_BADGE[current.origin].label}</span>
                {placeholders(current) && <span className="pill pill-warning">⚠ Còn placeholder</span>}
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmRemove(current.relPath)} disabled={files.length <= 1}>
                  Xoá tệp này
                </button>
              </div>
              <div className="wz-editor">
                <div className="field">
                  <label htmlFor="kb-editor">Nội dung {current.relPath} (Markdown)</label>
                  <textarea id="kb-editor" className="wz-mono" rows={18} value={current.body} spellCheck={false} onChange={(e) => update(currentIdx, e.target.value)} />
                </div>
                <div className="wz-preview" aria-label="Xem trước">
                  <div className="wz-preview-label">Xem trước</div>
                  <Markdown source={current.body} />
                </div>
              </div>
            </div>
          )}

          <div className="wz-add">
            <div className="field">
              <label htmlFor="kb-new">Thêm tệp mới</label>
              <div className="wz-inline">
                <input id="kb-new" type="text" value={newName} placeholder="vd: bang-gia.md" onChange={(e) => setNewName(e.target.value)} />
                <button type="button" className="btn" onClick={addFile}>
                  Thêm tệp
                </button>
              </div>
              {nameError && <p className="form-error">{nameError}</p>}
            </div>
          </div>

          {withPlaceholders.length > 0 && (
            <p className="form-error" role="status">
              Còn placeholder trong: {withPlaceholders.map((f) => f.relPath).join(", ")}. Hãy thay bằng nội dung thật trước khi go-live.
            </p>
          )}
          {saveError && (
            <p className="form-error" role="alert">
              {saveError}
            </p>
          )}
          <div className="wz-actions">
            <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving || !dirty} aria-busy={saving}>
              {saving ? "Đang lưu…" : "Lưu tất cả"}
            </button>
            {dirty && <span className="setup-hint">Có thay đổi chưa lưu.</span>}
          </div>
        </section>
      )}

      {confirmAi && (
        <ConfirmDialog
          title="Thay bằng bản AI tạo?"
          description={`Toàn bộ ${files?.length ?? 0} tệp hiện tại sẽ được thay bằng ${aiFiles.length} tệp do AI soạn. Chưa lưu cho đến khi bạn bấm “Lưu tất cả”.`}
          confirmLabel="Thay bằng bản AI"
          cancelLabel="Giữ bản hiện tại"
          destructive
          onCancel={() => setConfirmAi(false)}
          onConfirm={() => {
            setConfirmAi(false);
            applyAi();
          }}
        />
      )}
      {confirmRemove && (
        <ConfirmDialog
          title={`Xoá ${confirmRemove}?`}
          description="Tệp sẽ bị gỡ khỏi danh sách; việc xoá chỉ có hiệu lực khi bạn bấm “Lưu tất cả”."
          confirmLabel="Xoá tệp"
          cancelLabel="Giữ lại"
          destructive
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            removeFile(confirmRemove);
            setConfirmRemove(null);
          }}
        />
      )}
    </div>
  );
}
