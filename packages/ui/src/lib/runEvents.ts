// Folds the raw agy stream-json events forwarded over SSE (`run.event`) into one
// readable line per step: streamed text deltas are concatenated, tool steps show
// their tool (and MCP tool) name and final state.

export interface RunStepLine {
  index: number;
  kind: string; // step_type, or the agy event name for non-step events
  label: string;
  state: "ACTIVE" | "DONE" | "ERROR" | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function toolLabel(step: Obj): string {
  const info = isObj(step.tool_info) ? step.tool_info : {};
  const params = isObj(info.parameters) ? info.parameters : {};
  const name = String(step.tool_name ?? info.name ?? "tool");
  if (name === "call_mcp_tool" && typeof params.ToolName === "string") {
    return `${String(params.ServerName ?? "mcp")}/${params.ToolName}`;
  }
  const path = params.AbsolutePath ?? params.Url ?? params.query;
  return typeof path === "string" ? `${name} ${path}` : name;
}

export function summarizeRunEvents(events: unknown[], maxText = 300): RunStepLine[] {
  const steps = new Map<number, RunStepLine>();
  for (const wrapper of events) {
    const ev = isObj(wrapper) && isObj(wrapper.event) ? wrapper.event : null;
    if (!ev) continue;
    if (ev.event !== "step_update" || !isObj(ev.step_update)) {
      if (ev.event === "result") steps.set(Number.MAX_SAFE_INTEGER, { index: Number.MAX_SAFE_INTEGER, kind: "result", label: `run finished (${String(ev.status ?? "?")})`, state: "DONE" });
      continue;
    }
    const step = ev.step_update;
    const index = typeof step.step_index === "number" ? step.step_index : steps.size;
    const kind = String(step.step_type ?? "step");
    const state = (step.state as RunStepLine["state"]) ?? null;
    const prev = steps.get(index);
    let label: string;
    if (kind === "agent_response") {
      const delta = typeof step.text_delta === "string" ? step.text_delta : "";
      const text = (prev?.kind === "agent_response" ? prev.label : "") + delta;
      label = text.length > maxText ? `${text.slice(0, maxText)}…` : text;
    } else if (kind === "tool") {
      label = toolLabel(step);
    } else if (kind === "finish") {
      label = "returned structured result";
    } else {
      label = kind.replace(/_/g, " ");
    }
    steps.set(index, { index, kind, label, state });
  }
  return [...steps.values()].sort((a, b) => a.index - b.index).filter((s) => s.kind !== "user_input");
}
