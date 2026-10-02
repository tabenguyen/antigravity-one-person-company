import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError } from "../../api/client.ts";
import { routinesApi, type EvalRun } from "../../api/routines.ts";
import { useApi } from "../../hooks/useApi.ts";
import { useToast } from "../../components/Toast.tsx";
import { formatDateTime } from "../../lib/time.ts";
import { EvalDrawer } from "./EvalDrawer.tsx";
import { formatDuration, statusClass, statusLabel } from "./evalFormat.ts";

const POLL_MS = 3000;

export function EvalsSection() {
  const { notify } = useToast();
  const { data: suitesData } = useApi(() => routinesApi.evalSuites(), []);
  const { data, error, refresh } = useApi(() => routinesApi.listEvals({ limit: 30 }), [], ["eval.updated"]);
  const [openId, setOpenId] = useState<string | null>(null);

  const [suite, setSuite] = useState("");
  const [model, setModel] = useState("");
  const [picked, setPicked] = useState<Set<string> | null>(null); // null = all
  const [starting, setStarting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const suites = suitesData?.suites ?? [];
  const activeSuite = suites.find((s) => s.name === (suite || suites[0]?.name));
  const runs = data?.runs ?? [];
  const anyRunning = runs.some((r) => r.status === "running");

  // Live updates arrive over SSE ("eval.updated"); polling covers a dropped stream.
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [anyRunning, refresh]);

  const openRun = useMemo(() => runs.find((r) => r.id === openId) ?? null, [runs, openId]);

  function toggleCase(id: string) {
    const all = activeSuite?.cases.map((c) => c.id) ?? [];
    const next = new Set(picked ?? all);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  }

  async function handleStart(e: FormEvent) {
    e.preventDefault();
    if (!activeSuite) return;
    setFormError(null);
    const all = activeSuite.cases.map((c) => c.id);
    const chosen = picked ? all.filter((id) => picked.has(id)) : all;
    if (chosen.length === 0) return setFormError("Pick at least one case.");
    setStarting(true);
    try {
      const { run } = await routinesApi.startEval({
        suite: activeSuite.name,
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(chosen.length < all.length ? { caseIds: chosen } : {}),
      });
      notify(`Eval run started (${chosen.length} case${chosen.length === 1 ? "" : "s"}).`, "success");
      setOpenId(run.id);
      refresh();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <section className="rt-section" aria-labelledby="evals-heading">
      <div className="rt-section-head">
        <div>
          <h2 id="evals-heading">Evals</h2>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Regression checks for an agent template. Run before and after changing prompts, rules or skills. Each case is a real model run
            (uses quota); cases run one at a time in a throwaway workspace with a test knowledge base.
          </p>
        </div>
      </div>

      <form className="rt-form-start" onSubmit={handleStart} aria-label="Start eval run">
        <div className="field">
          <label htmlFor="ev-suite">Suite</label>
          <select
            id="ev-suite"
            value={activeSuite?.name ?? ""}
            onChange={(e) => {
              setSuite(e.target.value);
              setPicked(null);
            }}
          >
            {suites.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ev-model">Model</label>
          <input id="ev-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder={activeSuite?.defaultModel ?? "template default"} />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 260 }}>
          <label id="ev-cases-label">Cases ({picked ? picked.size : (activeSuite?.cases.length ?? 0)} selected)</label>
          <div className="rt-case-pick rt-checks" role="group" aria-labelledby="ev-cases-label">
            {activeSuite?.cases.map((c) => (
              <label key={c.id} title={c.description}>
                <input type="checkbox" checked={picked ? picked.has(c.id) : true} onChange={() => toggleCase(c.id)} /> {c.id}
              </label>
            ))}
          </div>
        </div>
        <div className="field">
          <button type="submit" className="btn btn-primary" disabled={starting || !activeSuite || anyRunning}>
            {anyRunning ? "Run in progress…" : starting ? "Starting…" : "Start run"}
          </button>
        </div>
        {formError && (
          <p className="form-error" role="alert" style={{ flexBasis: "100%", margin: 0 }}>
            {formError}
          </p>
        )}
      </form>

      {error && <p className="form-error">{error}</p>}

      <div className="rt-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Suite</th>
              <th>Model</th>
              <th>Status</th>
              <th>Results</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <RunRow key={r.id} run={r} onOpen={() => setOpenId(r.id)} />
            ))}
            {data && runs.length === 0 && (
              <tr>
                <td colSpan={6} className="empty-state">
                  No eval runs yet. Start one above to get a baseline.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {openRun && <EvalDrawer run={openRun} onClose={() => setOpenId(null)} />}
    </section>
  );
}

function RunRow({ run, onOpen }: { run: EvalRun; onOpen: () => void }) {
  const s = run.summary;
  const duration = run.finishedAt ? formatDuration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) : "—";
  return (
    <tr className="rt-row-click" tabIndex={0} onClick={onOpen} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen()} aria-label={`Open eval run ${run.id}`}>
      <td>{formatDateTime(run.startedAt)}</td>
      <td>{run.suite}</td>
      <td>
        <code>{run.model}</code>
      </td>
      <td>
        <span className={statusClass(run.status)}>{statusLabel(run.status)}</span>
      </td>
      <td>
        {s ? (
          <span className="rt-counts">
            <span className="rt-ok">{s.pass} pass</span>
            <span className={s.fail ? "rt-bad" : "faint"}>{s.fail} fail</span>
            <span className={s.error ? "rt-warn" : "faint"}>{s.error} err</span>
          </span>
        ) : (
          <span className="faint">{run.results.length} case(s) done…</span>
        )}
      </td>
      <td>{duration}</td>
    </tr>
  );
}
