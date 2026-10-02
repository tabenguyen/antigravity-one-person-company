// Typed fetch client for the admin API (bearer adminToken). Every response
// body is @agyhq/core's ApiEnvelope<T>; this unwraps it and throws ApiError
// with a readable message on failure. A 401 is broadcast via authEvents so
// the app can fall back to the token form from anywhere.

import { getToken } from "../auth/token.ts";
import { emitUnauthorized } from "./authEvents.ts";
import type {
  Agent,
  AgentRole,
  AgentStatus,
  AgentStats,
  ApiEnvelope,
  ApiErrorCode,
  AuditEvent,
  AuditKind,
  ContactView,
  CreateAgentRequest,
  CreateContactRequest,
  CreateTaskRequest,
  DaemonStatus,
  DeleteKbFileRequest,
  EditOutboxRequest,
  ApproveOutboxRequest,
  RejectOutboxRequest,
  HqSettings,
  ImportContactsRequest,
  InboundClassification,
  InboundEvent,
  InboundStatus,
  KbDocSummary,
  KbHit,
  KillSwitchRequest,
  MemoryItem,
  MemoryStatus,
  OutboxItem,
  OutboxStatus,
  PatchAgentRequest,
  PutKbFileRequest,
  QuotaBucket,
  Task,
  TaskStatus,
  TimelineEntry,
  TranscriptStep,
} from "./types.ts";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export function qs(params: Record<string, string | number | boolean | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

/** Low-level typed request; feature modules (api/readiness.ts, ...) build on it. */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch (err) {
    throw new ApiError("internal", `Network error: ${err instanceof Error ? err.message : String(err)}`, 0);
  }

  let body: ApiEnvelope<T> | undefined;
  try {
    body = (await res.json()) as ApiEnvelope<T>;
  } catch {
    body = undefined;
  }

  if (!body) {
    throw new ApiError("internal", `Request failed with status ${res.status}`, res.status);
  }
  if (!body.ok) {
    if (body.error.code === "unauthorized") emitUnauthorized();
    throw new ApiError(body.error.code, body.error.message, res.status);
  }
  return body.data;
}

/** Fetches a binary endpoint (e.g. an attachment download) with the admin token; errors come back as the JSON envelope. */
export async function requestBlob(path: string): Promise<Blob> {
  const token = getToken();
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  let res: Response;
  try {
    res = await fetch(path, { headers });
  } catch (err) {
    throw new ApiError("internal", `Network error: ${err instanceof Error ? err.message : String(err)}`, 0);
  }
  if (res.ok) return res.blob();
  const body = (await res.json().catch(() => undefined)) as ApiEnvelope<unknown> | undefined;
  if (body && !body.ok) {
    if (body.error.code === "unauthorized") emitUnauthorized();
    throw new ApiError(body.error.code, body.error.message, res.status);
  }
  throw new ApiError("internal", `Request failed with status ${res.status}`, res.status);
}

const get = <T>(path: string) => request<T>(path, { method: "GET" });
const post = <T>(path: string, payload?: unknown) =>
  request<T>(path, { method: "POST", body: payload === undefined ? undefined : JSON.stringify(payload) });
const patch = <T>(path: string, payload: unknown) =>
  request<T>(path, { method: "PATCH", body: JSON.stringify(payload) });
const put = <T>(path: string, payload: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(payload) });
const del = <T>(path: string, payload?: unknown) =>
  request<T>(path, { method: "DELETE", body: payload === undefined ? undefined : JSON.stringify(payload) });

export const api = {
  // -- Status / settings -----------------------------------------------
  status: () => get<{ status: DaemonStatus }>("/v1/admin/status"),
  getSettings: () => get<{ settings: HqSettings }>("/v1/admin/settings"),
  updateSettings: (patchBody: Partial<HqSettings>) => patch<{ settings: HqSettings }>("/v1/admin/settings", patchBody),
  killSwitch: (body: KillSwitchRequest) => post<{ settings: HqSettings }>("/v1/admin/killswitch", body),

  // -- Stats --------------------------------------------------------------
  stats: (days?: number) => get<{ days: number; agents: AgentStats[]; inboundToday: number; sentToday: number }>(
    `/v1/admin/stats${qs({ days })}`,
  ),

  // -- Agents ---------------------------------------------------------------
  listAgents: (params?: { status?: AgentStatus; role?: AgentRole }) =>
    get<{ agents: Agent[] }>(`/v1/admin/agents${qs({ status: params?.status, role: params?.role })}`),
  getAgent: (id: string) => get<{ agent: Agent }>(`/v1/admin/agents/${encodeURIComponent(id)}`),
  createAgent: (body: CreateAgentRequest) => post<{ agent: Agent }>("/v1/admin/agents", body),
  patchAgent: (id: string, body: PatchAgentRequest) =>
    patch<{ agent: Agent }>(`/v1/admin/agents/${encodeURIComponent(id)}`, body),
  rerenderAgent: (id: string) => post<{ agent: Agent; files: string[] }>(`/v1/admin/agents/${encodeURIComponent(id)}/rerender`),
  rerenderAllAgents: () => post<{ results: unknown[] }>("/v1/admin/agents/rerender-all"),

  // -- Tasks ------------------------------------------------------------
  listTasks: (params?: { agentId?: string; status?: TaskStatus[]; limit?: number }) =>
    get<{ tasks: Task[] }>(
      `/v1/admin/tasks${qs({ agentId: params?.agentId, status: params?.status, limit: params?.limit })}`,
    ),
  createTask: (body: CreateTaskRequest) => post<{ task: Task }>("/v1/admin/tasks", body),
  getTask: (id: string) => get<{ task: Task; audit: AuditEvent[] }>(`/v1/admin/tasks/${encodeURIComponent(id)}`),
  cancelTask: (id: string) => post<{ task: Task }>(`/v1/admin/tasks/${encodeURIComponent(id)}/cancel`),
  retryTask: (id: string) => post<{ task: Task }>(`/v1/admin/tasks/${encodeURIComponent(id)}/retry`),
  resumeTask: (id: string, guidance: string) =>
    post<{ task: Task }>(`/v1/admin/tasks/${encodeURIComponent(id)}/resume`, { guidance }),
  followUpTask: (id: string, guidance: string) =>
    post<{ task: Task }>(`/v1/admin/tasks/${encodeURIComponent(id)}/follow-up`, { guidance }),
  completeTask: (id: string, note?: string) =>
    post<{ task: Task }>(`/v1/admin/tasks/${encodeURIComponent(id)}/complete`, { note }),
  taskTranscript: (id: string) =>
    get<{ steps: TranscriptStep[]; transcriptPath: string | null }>(`/v1/admin/tasks/${encodeURIComponent(id)}/transcript`),

  // -- Outbox -------------------------------------------------------------
  listOutbox: (params?: { agentId?: string; status?: OutboxStatus[]; limit?: number }) =>
    get<{ items: OutboxItem[] }>(
      `/v1/admin/outbox${qs({ agentId: params?.agentId, status: params?.status, limit: params?.limit })}`,
    ),
  editOutbox: (id: string, body: EditOutboxRequest) =>
    patch<{ item: OutboxItem }>(`/v1/admin/outbox/${encodeURIComponent(id)}`, body),
  approveOutbox: (id: string, body?: ApproveOutboxRequest) =>
    post<{ item: OutboxItem }>(`/v1/admin/outbox/${encodeURIComponent(id)}/approve`, body ?? {}),
  rejectOutbox: (id: string, body: RejectOutboxRequest) =>
    post<{ item: OutboxItem }>(`/v1/admin/outbox/${encodeURIComponent(id)}/reject`, body),
  retryOutbox: (id: string) => post<{ item: OutboxItem }>(`/v1/admin/outbox/${encodeURIComponent(id)}/retry`),

  // -- Memory -------------------------------------------------------------
  listMemory: (params?: { agentId?: string; subject?: string; status?: MemoryStatus }) =>
    get<{ items: MemoryItem[] }>(
      `/v1/admin/memory${qs({ agentId: params?.agentId, subject: params?.subject, status: params?.status })}`,
    ),
  acceptMemory: (id: string) => post<{ item: MemoryItem }>(`/v1/admin/memory/${encodeURIComponent(id)}/accept`),
  rejectMemory: (id: string) => post<{ item: MemoryItem }>(`/v1/admin/memory/${encodeURIComponent(id)}/reject`),

  // -- KB -------------------------------------------------------------------
  syncKb: () => post<{ scanned: number; changed: number; deleted: number }>("/v1/admin/kb/sync"),
  searchKb: (query: string, scopes: string, limit?: number) =>
    get<{ results: KbHit[] }>(`/v1/admin/kb/search${qs({ query, scopes, limit })}`),
  listKbDocs: (scope?: string) => get<{ docs: KbDocSummary[] }>(`/v1/admin/kb/docs${qs({ scope })}`),
  getKbDoc: (id: string) => get<{ doc: KbDocSummary & { body: string } }>(`/v1/admin/kb/docs/${encodeURIComponent(id)}`),
  putKbFile: (body: PutKbFileRequest) => put<{ doc: KbDocSummary & { body: string } }>("/v1/admin/kb/files", body),
  deleteKbFile: (body: DeleteKbFileRequest) => del<{ deleted: true }>("/v1/admin/kb/files", body),

  // -- Contacts ---------------------------------------------------------
  listContacts: (params?: { query?: string; email?: string; id?: string; limit?: number }) =>
    get<{ contacts: ContactView[] }>(
      `/v1/admin/contacts${qs({ query: params?.query, email: params?.email, id: params?.id, limit: params?.limit })}`,
    ),
  getContact: (id: string) =>
    get<{ contact: ContactView; timeline: TimelineEntry[] }>(`/v1/admin/contacts/${encodeURIComponent(id)}`),
  createContact: (body: CreateContactRequest) => post<{ contact: ContactView; created: boolean }>("/v1/admin/contacts", body),
  importContacts: (body: ImportContactsRequest) => post<{ contacts: ContactView[] }>("/v1/admin/contacts/import", body),

  // -- Inbound ----------------------------------------------------------
  listInbound: (params?: { status?: InboundStatus; classification?: InboundClassification; limit?: number }) =>
    get<{ events: InboundEvent[] }>(
      `/v1/admin/inbound${qs({ status: params?.status, classification: params?.classification, limit: params?.limit })}`,
    ),
  getInbound: (id: string) => get<{ event: InboundEvent }>(`/v1/admin/inbound/${encodeURIComponent(id)}`),
  inboundAttachment: (id: string, index: number) =>
    requestBlob(`/v1/admin/inbound/${encodeURIComponent(id)}/attachments/${index}`),

  // -- Quota / audit --------------------------------------------------------
  quota: () => get<{ at: string; buckets: QuotaBucket[] } | null>("/v1/admin/quota"),
  listAudit: (params?: { agentId?: string; taskId?: string; kind?: AuditKind[]; since?: string; limit?: number }) =>
    get<{ events: AuditEvent[] }>(
      `/v1/admin/audit${qs({
        agentId: params?.agentId,
        taskId: params?.taskId,
        kind: params?.kind,
        since: params?.since,
        limit: params?.limit,
      })}`,
    ),
};

export function eventsUrl(token: string | null): string {
  return `/v1/admin/events${token ? `?access_token=${encodeURIComponent(token)}` : ""}`;
}
