import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GeneratedRoleKbFile } from "../../../api/setupWizard.ts";
import { ApiError } from "../../../api/client.ts";
import { setupWizardApi } from "../../../api/setupWizard.ts";
import { useApi } from "../../../hooks/useApi.ts";
import { ConfirmDialog } from "../../../components/ConfirmDialog.tsx";
import { Markdown } from "../../../components/Markdown.tsx";
import { useToast } from "../../../components/Toast.tsx";
import { useRegisterStep, useWizard } from "./WizardContext.tsx";

type Origin = "template" | "custom" | "ai";
type KbRole = "sales-sdr" | "fanpage-manager";
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

const ROLES: { role: KbRole; label: string; saved: string; intro: string }[] = [
  {
    role: "sales-sdr",
    label: "Agent SDR",
    saved: "Đã lưu kiến thức bán hàng.",
    intro: "Đây là “sổ tay” agent SDR dùng khi viết email: khách hàng lý tưởng, cách tiếp cận, cách trả lời phản đối. Chỉnh cho đúng công ty bạn.",
  },
  {
    role: "fanpage-manager",
    label: "Fanpage Manager",
    saved: "Đã lưu kiến thức Fanpage.",
    intro:
      "Đây là “sổ tay” agent Fanpage Manager dùng khi soạn bài và trả lời bình luận: giọng văn của Page, các nhóm nội dung, chính sách bình luận. Agent sẽ bị tạm dừng nếu còn chữ TODO/placeholder trong các tệp này.",
  },
];

/** Editing state for one role's knowledge base (loaded from, and saved to, the role override). */
function useRoleKb(role: KbRole, aiFiles: GeneratedRoleKbFile[], savedMessage: string) {
  const { refreshReadiness } = useWizard();
  const { notify } = useToast();
  const kb = useApi(() => setupWizardApi.getRoleKb(role), [role]);

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

  async function save(): Promise<boolean> {
    if (!files || !dirty) return true;
    const bad = files.find((f) => !FILE_RE.test(f.relPath) || f.body.trim().length === 0);
    if (bad) {
      setSaveError(`Tệp “${bad.relPath}” cần có tên dạng ten-tep.md và nội dung không được để trống.`);
      return false;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await setupWizardApi.putRoleKb({ role, files: files.map((f) => ({ relPath: f.relPath, body: f.body })) });
      load(res);
      notify(savedMessage, "success");
      refreshReadiness();
      return true;
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }

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
    setFiles(aiFiles.map((f) => ({ relPath: f.relPath, title: f.title, body: f.body, hasPlaceholders: false, origin: "ai", originalBody: null })));
    setActive(0);
  }

  return {
    role, kb, files, source, dirty, active, setActive, newName, setNewName, nameError, confirmAi, setConfirmAi, confirmRemove, setConfirmRemove,
    saving, saveError, save, update, addFile, removeFile, applyAi, aiFiles,
  };
}
type RoleKbState = ReturnType<typeof useRoleKb>;

/** Step 2: edit the role knowledge bases (SDR sales KB, Fanpage Manager KB) that override the built-in templates. */
export function KnowledgeStep() {
  const { jobs } = useWizard();
  const result = jobs.latestDone?.result ?? null;
  const sdr = useRoleKb("sales-sdr", result?.roleKb.files ?? [], ROLES[0]!.saved);
  const fanpage = useRoleKb("fanpage-manager", result?.fanpageKb?.files ?? [], ROLES[1]!.saved);
  const [role, setRole] = useState<KbRole>("sales-sdr");
  const editors = { "sales-sdr": sdr, "fanpage-manager": fanpage };

  // Saving the step saves every role that has unsaved edits, so switching roles never loses work.
  useRegisterStep(sdr.dirty || fanpage.dirty, async () => {
    const a = await sdr.save();
    const b = await fanpage.save();
    return a && b;
  });

  const def = ROLES.find((r) => r.role === role)!;
  const fanpageQuestions = (result?.openQuestions ?? []).filter((q) => /^Fanpage:/i.test(q));

  return (
    <div className="wz-step-body">
      <h2 className="wz-title">2. Kiến thức cho agent</h2>
      <div className="wz-badges" role="group" aria-label="Chọn agent">
        {ROLES.map((r) => (
          <button key={r.role} type="button" className={r.role === role ? "btn btn-sm btn-primary" : "btn btn-sm"} aria-pressed={r.role === role} onClick={() => setRole(r.role)}>
            {r.label}
            {editors[r.role].dirty ? " •" : ""}
          </button>
        ))}
      </div>
      <p className="muted">{def.intro}</p>
      <RoleKbEditor ed={editors[role]} domain={jobs.latestDone?.domain} questions={role === "fanpage-manager" ? fanpageQuestions : []} />
    </div>
  );
}

function RoleKbEditor({ ed, domain, questions }: { ed: RoleKbState; domain: string | undefined; questions: string[] }) {
  const { kb, files, source, dirty, active, newName, nameError, confirmAi, confirmRemove, saving, saveError, aiFiles } = ed;
  const idp = ed.role === "sales-sdr" ? "kb" : "fb";
  const withPlaceholders = useMemo(() => (files ?? []).filter(placeholders), [files]);
  const current = files?.[Math.min(active, (files?.length ?? 1) - 1)] ?? null;
  const currentIdx = current && files ? files.indexOf(current) : 0;

  return (
    <>
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
        <section className="card wz-card" aria-labelledby={`${idp}-ai-heading`}>
          <h3 id={`${idp}-ai-heading`}>Bản AI tạo từ {domain}</h3>
          <p className="muted">AI đã soạn {aiFiles.length} tệp: {aiFiles.map((f) => f.relPath).join(", ")}. Dùng bản này sẽ thay toàn bộ các tệp hiện tại; chưa lưu cho đến khi bạn bấm “Lưu tất cả”.</p>
          <button type="button" className="btn" onClick={() => ed.setConfirmAi(true)}>
            Dùng bản AI tạo
          </button>
          {questions.length > 0 && (
            <div className="wz-callout" role="group" aria-label="Cần chủ Page xác nhận">
              <h4>Cần chủ Page xác nhận</h4>
              <p className="muted">Website không nói rõ các điểm này nên AI đề xuất tạm; hãy kiểm tra trước khi lưu:</p>
              <ul>
                {questions.map((q, i) => (
                  <li key={i}>{q.replace(/^Fanpage:\s*/i, "")}</li>
                ))}
              </ul>
            </div>
          )}
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
                id={`${idp}tab-${i}`}
                aria-selected={i === currentIdx}
                aria-controls={`${idp}-panel`}
                className={i === currentIdx ? "tab active" : "tab"}
                onClick={() => ed.setActive(i)}
              >
                {f.relPath}
                {placeholders(f) && <span aria-label="còn placeholder" title="Còn placeholder"> ⚠</span>}
              </button>
            ))}
          </div>

          {current && (
            <div id={`${idp}-panel`} role="tabpanel" aria-labelledby={`${idp}tab-${currentIdx}`}>
              <div className="wz-badges">
                <span className={`pill ${ORIGIN_BADGE[current.origin].cls}`}>{ORIGIN_BADGE[current.origin].label}</span>
                {placeholders(current) && <span className="pill pill-warning">⚠ Còn placeholder</span>}
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => ed.setConfirmRemove(current.relPath)} disabled={files.length <= 1}>
                  Xoá tệp này
                </button>
              </div>
              <div className="wz-editor">
                <div className="field">
                  <label htmlFor={`${idp}-editor`}>Nội dung {current.relPath} (Markdown)</label>
                  <textarea id={`${idp}-editor`} className="wz-mono" rows={18} value={current.body} spellCheck={false} onChange={(e) => ed.update(currentIdx, e.target.value)} />
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
              <label htmlFor={`${idp}-new`}>Thêm tệp mới</label>
              <div className="wz-inline">
                <input id={`${idp}-new`} type="text" value={newName} placeholder="vd: bang-gia.md" onChange={(e) => ed.setNewName(e.target.value)} />
                <button type="button" className="btn" onClick={ed.addFile}>
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
            <button type="button" className="btn btn-primary" onClick={() => void ed.save()} disabled={saving || !dirty} aria-busy={saving}>
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
          onCancel={() => ed.setConfirmAi(false)}
          onConfirm={() => {
            ed.setConfirmAi(false);
            ed.applyAi();
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
          onCancel={() => ed.setConfirmRemove(null)}
          onConfirm={() => {
            ed.removeFile(confirmRemove);
            ed.setConfirmRemove(null);
          }}
        />
      )}
    </>
  );
}
