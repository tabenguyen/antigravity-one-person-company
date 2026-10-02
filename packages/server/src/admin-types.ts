// Request/response shapes for the admin API (bearer adminToken), exported so
// a future agy-ui can share them instead of re-declaring the wire format.
// Response bodies are always @agyhq/core's ApiEnvelope<T>.

import { z } from "zod";
import type {
  Agent,
  AgentRole,
  AgentStatus,
  ApiEnvelope,
  AuditEvent,
  Company,
  ContactView,
  KbHit,
  MemoryItem,
  OutboxItem,
  QuotaBucket,
  Task,
  TaskStatus,
  TrustTier,
} from "@agyhq/core";

const AgentRoleZ = z.enum(["sales-sdr", "account-manager", "chief-of-staff"]);
const TrustTierZ = z.enum(["shadow", "assisted", "autonomous"]);
const AgentStatusZ = z.enum(["active", "paused", "archived"]);
const TaskStatusZ = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "waiting_external",
  "done",
  "failed",
  "cancelled",
]);

// ---------------------------------------------------------------------------
// Agents

export const CreateAgentRequestZ = z.object({
  id: z.string().min(1),
  role: AgentRoleZ,
  displayName: z.string().min(1),
  model: z.string().min(1).optional(),
  trustTier: TrustTierZ.optional(),
  maxConcurrency: z.number().int().positive().optional(),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestZ>;

export const PatchAgentRequestZ = z
  .object({
    status: AgentStatusZ,
    trustTier: TrustTierZ,
    model: z.string().min(1),
    maxConcurrency: z.number().int().positive(),
    displayName: z.string().min(1),
  })
  .partial();
export type PatchAgentRequest = z.infer<typeof PatchAgentRequestZ>;

export interface ListAgentsQuery {
  status?: AgentStatus;
  role?: AgentRole;
}
export type ListAgentsResponse = ApiEnvelope<{ agents: Agent[] }>;
export type GetAgentResponse = ApiEnvelope<{ agent: Agent }>;
export type CreateAgentResponse = ApiEnvelope<{ agent: Agent }>;
export type RerenderAgentResponse = ApiEnvelope<{ agent: Agent; files: string[] }>;

// ---------------------------------------------------------------------------
// Tasks

export const CreateTaskRequestZ = z.object({
  agentId: z.string().min(1),
  kind: z.string().min(1),
  title: z.string().min(1),
  input: z.record(z.unknown()).optional(),
  priority: z.number().int().optional(),
  threadKey: z.string().optional(),
  conversationId: z.string().optional(),
  maxAttempts: z.number().int().positive().optional(),
  wakeAt: z.string().optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestZ>;

/** waiting_approval -> queued: the agent runs again with the reviewer's guidance in its prompt. */
export const ResumeTaskRequestZ = z.object({ guidance: z.string().trim().min(1) });
export type ResumeTaskRequest = z.infer<typeof ResumeTaskRequestZ>;

/** A finished task (done/failed/cancelled) gets a child task: same agent and kind, the reviewer's guidance in its prompt. */
export const FollowUpTaskRequestZ = z.object({ guidance: z.string().trim().min(1) });
export type FollowUpTaskRequest = z.infer<typeof FollowUpTaskRequestZ>;

/** waiting_approval -> done: the reviewer handled it themselves; the note becomes the result summary. */
export const CompleteTaskRequestZ = z.object({ note: z.string().trim().optional() });
export type CompleteTaskRequest = z.infer<typeof CompleteTaskRequestZ>;

export interface ListTasksQuery {
  agentId?: string;
  status?: TaskStatus[];
  limit?: number;
}
export type ListTasksResponse = ApiEnvelope<{ tasks: Task[] }>;
export type GetTaskResponse = ApiEnvelope<{ task: Task; audit: AuditEvent[] }>;
export type CreateTaskResponse = ApiEnvelope<{ task: Task }>;
export type TaskActionResponse = ApiEnvelope<{ task: Task }>;

// ---------------------------------------------------------------------------
// Outbox

export interface ListOutboxQuery {
  agentId?: string;
  status?: string[];
  limit?: number;
}
export type ListOutboxResponse = ApiEnvelope<{ items: OutboxItem[] }>;
export type OutboxActionResponse = ApiEnvelope<{ item: OutboxItem }>;

// ---------------------------------------------------------------------------
// Memory

export interface ListMemoryQuery {
  agentId?: string;
  subject?: string;
  status?: "pending" | "accepted" | "rejected";
}
export type ListMemoryResponse = ApiEnvelope<{ items: MemoryItem[] }>;
export type MemoryActionResponse = ApiEnvelope<{ item: MemoryItem }>;

// ---------------------------------------------------------------------------
// KB

export const KbSearchQueryZ = z.object({
  query: z.string().min(1),
  scopes: z.string().min(1), // comma-separated
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type KbSearchResponse = ApiEnvelope<{ results: KbHit[] }>;
export type KbSyncResponse = ApiEnvelope<{
  scanned: number;
  changed: number;
  deleted: number;
}>;

// ---------------------------------------------------------------------------
// Contacts

export const CreateContactRequestZ = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  title: z.string().optional(),
  phone: z.string().optional(),
  linkedinUrl: z.string().optional(),
  language: z.string().optional(),
  source: z.string().optional(),
  companyName: z.string().optional(),
  companyDomain: z.string().optional(),
  attributes: z.record(z.unknown()).optional(),
});
export type CreateContactRequest = z.infer<typeof CreateContactRequestZ>;

export const ImportContactsRequestZ = z.object({ contacts: z.array(CreateContactRequestZ).min(1) });
export type ImportContactsRequest = z.infer<typeof ImportContactsRequestZ>;

export type ListContactsResponse = ApiEnvelope<{ contacts: ContactView[] }>;
export type ContactResponse = ApiEnvelope<{ contact: ContactView; created: boolean }>;
export type ImportContactsResponse = ApiEnvelope<{ contacts: ContactView[] }>;

// ---------------------------------------------------------------------------
// Quota / audit

export type QuotaResponse = ApiEnvelope<{ at: string; buckets: QuotaBucket[] } | null>;

export interface ListAuditQuery {
  agentId?: string;
  taskId?: string;
  kind?: string[];
  since?: string;
  limit?: number;
}
export type ListAuditResponse = ApiEnvelope<{ events: AuditEvent[] }>;

export type { Company };

// ===========================================================================
// Phase 2 additions — CONTRACT shared by the daemon (implements) and agy-ui
// (consumes). All routes below are under bearer adminToken unless noted.
// ===========================================================================

import type { HqSettings, InboundClassification, InboundEvent, InboundStatus, Note, OutboxStatus } from "@agyhq/core";

// --- Outbox review ---------------------------------------------------------
// PATCH /v1/admin/outbox/:id            body EditOutboxRequest   → OutboxActionResponse   (only while pending_approval)
// POST  /v1/admin/outbox/:id/approve    body ApproveOutboxRequest → OutboxActionResponse  (→ approved, or held if agent is shadow tier)
// POST  /v1/admin/outbox/:id/reject     body RejectOutboxRequest  → OutboxActionResponse  (reason becomes accepted agent memory)
// POST  /v1/admin/outbox/:id/retry      → OutboxActionResponse                            (failed → approved)
// GET   /v1/admin/outbox?status=&agentId=&limit=  (status may be comma-separated)        → ListOutboxResponse
export const EditOutboxRequestZ = z
  .object({ subject: z.string().min(1).max(200).optional(), body: z.string().min(1).max(10000).optional() })
  .refine((v) => v.subject !== undefined || v.body !== undefined, "subject or body required");
export type EditOutboxRequest = z.infer<typeof EditOutboxRequestZ>;
export const ApproveOutboxRequestZ = z.object({ note: z.string().max(2000).optional(), reviewer: z.string().max(100).optional() });
export type ApproveOutboxRequest = z.infer<typeof ApproveOutboxRequestZ>;
export const RejectOutboxRequestZ = z.object({ reason: z.string().min(1).max(2000), reviewer: z.string().max(100).optional() });
export type RejectOutboxRequest = z.infer<typeof RejectOutboxRequestZ>;

// --- Inbound ---------------------------------------------------------------
// GET  /v1/admin/inbound?status=&classification=&limit=   → ListInboundResponse
// GET  /v1/admin/inbound/:id                              → GetInboundResponse
// POST /v1/inbound/webhook/:source   (NOT admin auth: header `x-agyhq-webhook-secret` must match
//      config.webhooks[source].secret)  body WebhookLeadRequest → ApiEnvelope<{ event: InboundEvent }>
export interface ListInboundQuery {
  status?: InboundStatus;
  classification?: InboundClassification;
  limit?: number;
}
export type ListInboundResponse = ApiEnvelope<{ events: InboundEvent[] }>;
export type GetInboundResponse = ApiEnvelope<{ event: InboundEvent }>;
export const WebhookLeadRequestZ = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  companyName: z.string().optional(),
  companyDomain: z.string().optional(),
  title: z.string().optional(),
  phone: z.string().optional(),
  message: z.string().max(10000).optional(),
  externalId: z.string().optional(), // dedupe key from the form provider
  fields: z.record(z.unknown()).optional(),
});
export type WebhookLeadRequest = z.infer<typeof WebhookLeadRequestZ>;

// --- Settings & status -----------------------------------------------------
// GET /v1/admin/settings → SettingsResponse ; PATCH /v1/admin/settings body Partial<HqSettings> → SettingsResponse
// POST /v1/admin/killswitch body KillSwitchRequest → SettingsResponse   (shortcut for outboundEnabled)
// GET /v1/admin/status → StatusResponse
export type SettingsResponse = ApiEnvelope<{ settings: HqSettings }>;
export const KillSwitchRequestZ = z.object({ outboundEnabled: z.boolean(), reason: z.string().max(500).optional() });
export type KillSwitchRequest = z.infer<typeof KillSwitchRequestZ>;
export interface DaemonStatus {
  version: string;
  startedAt: string;
  agyVersion: string | null;
  email: {
    provider: string; // "imap-smtp" | "maildir" | "none"
    address: string | null;
    ok: boolean;
    error: string | null;
    lastPollAt: string | null;
    lastSendAt: string | null;
  };
  outboundEnabled: boolean;
  outboundDisabledReason: string | null;
  inQuietHours: boolean;
  quotaThrottled: boolean;
  runningTasks: number;
}
export type StatusResponse = ApiEnvelope<{ status: DaemonStatus }>;

// --- Stats (dashboard) -----------------------------------------------------
// GET /v1/admin/stats?days=7 → StatsResponse
export interface AgentStats {
  agentId: string;
  tasksByStatus: Partial<Record<TaskStatus, number>>;
  outboxByStatus: Partial<Record<OutboxStatus, number>>;
  /** Over the window: approved+held / decided, edited / approved+held. */
  approvalRate: number | null;
  editRate: number | null;
  sent: number;
  repliesReceived: number;
  tokensUsed: number;
}
export type StatsResponse = ApiEnvelope<{ days: number; agents: AgentStats[]; inboundToday: number; sentToday: number }>;

// --- Contact detail / timeline ---------------------------------------------
// GET /v1/admin/contacts/:id → ContactDetailResponse
export type TimelineEntry =
  | { type: "note"; at: string; note: Note }
  | { type: "outbox"; at: string; item: OutboxItem }
  | { type: "inbound"; at: string; event: InboundEvent }
  | { type: "task"; at: string; task: Task };
export type ContactDetailResponse = ApiEnvelope<{ contact: ContactView; timeline: TimelineEntry[] }>;

// --- Task transcript ---------------------------------------------------------
// GET /v1/admin/tasks/:id/transcript → TranscriptResponse  (from the last run's agy transcript, steps simplified)
export interface TranscriptStep {
  index: number;
  at: string | null;
  source: string; // "USER" | "MODEL" | "SYSTEM_SDK" | ...
  type: string; // agy step type
  text: string; // truncated to ~4KB
}
export type TranscriptResponse = ApiEnvelope<{ steps: TranscriptStep[]; transcriptPath: string | null }>;

// --- KB documents (editable from the UI) ------------------------------------
// GET    /v1/admin/kb/docs?scope=          → ListKbDocsResponse (no bodies)
// GET    /v1/admin/kb/docs/:id             → GetKbDocResponse
// PUT    /v1/admin/kb/files  body PutKbFileRequest → GetKbDocResponse   (writes markdown file, re-syncs that doc)
// DELETE /v1/admin/kb/files  body DeleteKbFileRequest → ApiEnvelope<{ deleted: true }>
// Files live under config.kbRoot (scope "company") or templates/<role>/kb (scope "role:<role>"); relPath may not escape them.
export interface KbDocSummary {
  id: string;
  scope: string;
  title: string;
  sourcePath: string | null;
  relPath: string | null; // relative to its scope root, for editing
  updatedAt: string;
}
export type ListKbDocsResponse = ApiEnvelope<{ docs: KbDocSummary[] }>;
export type GetKbDocResponse = ApiEnvelope<{ doc: KbDocSummary & { body: string } }>;
export const PutKbFileRequestZ = z.object({
  scope: z.string().regex(/^(company|role:[a-z-]+)$/),
  relPath: z.string().regex(/^[\w\-./]+\.md$/),
  body: z.string().max(200_000),
});
export type PutKbFileRequest = z.infer<typeof PutKbFileRequestZ>;
export const DeleteKbFileRequestZ = PutKbFileRequestZ.pick({ scope: true, relPath: true });
export type DeleteKbFileRequest = z.infer<typeof DeleteKbFileRequestZ>;

// --- SSE (GET /v1/admin/events) event types emitted on the bus ---------------
// task.transition, run.event, run.finished, outbox.drafted, outbox.updated, memory.proposed,
// inbound.received, inbound.routed, settings.changed, status.changed — each `data:` is JSON with at least { id? , ... }.
export type SseEventType =
  | "task.transition"
  | "run.event"
  | "run.finished"
  | "outbox.drafted"
  | "outbox.updated"
  | "memory.proposed"
  | "inbound.received"
  | "inbound.routed"
  | "settings.changed"
  | "status.changed"
  | (string & {}); // other bus events (agent.*, kb.synced, quota.throttle, ...) — UIs should tolerate unknown types

// PATCH /v1/admin/settings body (strict: unknown keys rejected so a typo can't silently do nothing).
const validTimezone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
export const PatchSettingsRequestZ = z
  .object({
    outboundEnabled: z.boolean(),
    outboundDisabledReason: z.string().max(500).nullable(),
    quietHours: z
      .object({
        startHour: z.number().int().min(0).max(23),
        endHour: z.number().int().min(0).max(23),
        timezone: z.string().refine(validTimezone, "unknown IANA timezone"),
      })
      .nullable(),
    sendRatePerHour: z.number().int().min(0).max(10_000),
    autoTrip: z.object({ windowSize: z.number().int().min(1).max(10_000), maxBounceRate: z.number().min(0).max(1) }),
    defaultSdrAgentId: z.string().min(1).nullable(),
    autonomousRequiresPriorApproval: z.boolean(),
  })
  .partial()
  .strict();
export type PatchSettingsRequest = z.infer<typeof PatchSettingsRequestZ>;

// ===========================================================================
// Phase 3 additions — CONTRACT. Implemented in admin-readiness.ts,
// admin-quality.ts, admin-routines.ts (each registers its own routes).
// ===========================================================================

import type {
  AgentScorecard,
  CompanyProfile,
  EvalRun,
  LintFinding,
  PromotionCriteria,
  ReadinessReport,
  RejectionCategory,
  Routine,
} from "@agyhq/core";

// --- Readiness & setup (admin-readiness.ts) --------------------------------
// GET  /v1/admin/readiness                         → ReadinessResponse
// GET  /v1/admin/setup/company                     → CompanyProfileResponse (profile null if never saved)
// PUT  /v1/admin/setup/company  body CompanyProfileInput → CompanyProfileResponse
//      (persists in kv "company_profile", renders kb/company/*.md, re-syncs KB)
// POST /v1/admin/setup/email-test               → ApiEnvelope<{ ok: boolean; error: string | null; checkedAt: string }>
// The existing POST /v1/admin/killswitch with outboundEnabled:true is REFUSED (409 conflict, message lists
// failing checks) unless readiness.ready or body.force === true (force is audited).
export type ReadinessResponse = ApiEnvelope<{ readiness: ReadinessReport }>;
export const CompanyProfileInputZ = z.object({
  companyName: z.string().min(1).max(200),
  website: z.string().url().nullable().default(null),
  oneLiner: z.string().min(10).max(300),
  productDescription: z.string().min(20).max(20_000),
  targetCustomers: z.string().min(10).max(10_000),
  painPoints: z.string().min(10).max(10_000),
  differentiators: z.string().max(10_000).default(""),
  pricingPolicy: z.string().min(10).max(10_000),
  proofPoints: z.string().max(10_000).default(""),
  forbiddenClaims: z.string().max(10_000).default(""),
  meetingLink: z.string().url().nullable().default(null),
  languages: z.array(z.string().min(2).max(5)).min(1).default(["vi", "en"]),
});
export type CompanyProfileInput = z.input<typeof CompanyProfileInputZ>;
export type CompanyProfileResponse = ApiEnvelope<{ profile: CompanyProfile | null; files?: string[] }>;
export const KillSwitchForceRequestZ = KillSwitchRequestZ.extend({ force: z.boolean().optional() });

// --- Quality: lint, rejection categories, scorecards, promotion (admin-quality.ts) ---
// POST /v1/admin/outbox/:id/reject now also accepts { category?: RejectionCategory } (see RejectOutboxRequestZ;
//      category defaults to "other").
// POST /v1/admin/outbox/:id/relint                 → OutboxActionResponse (re-run lint, e.g. after KB changes)
// GET  /v1/admin/scorecards?days=14                → ScorecardsResponse
// GET  /v1/admin/promotion-criteria                → PromotionCriteriaResponse
// PUT  /v1/admin/promotion-criteria body Partial<PromotionCriteria> → PromotionCriteriaResponse (kv "promotion_criteria")
// POST /v1/admin/agents/:id/promote body PromoteAgentRequest → GetAgentResponse
//      (moves to scorecard.promotion.nextTier; 409 if not eligible unless force; audited)
export const RejectionCategoryZ = z.enum([
  "factual_error",
  "tone",
  "too_long",
  "not_personalized",
  "wrong_recipient",
  "bad_timing",
  "compliance",
  "other",
]) satisfies z.ZodType<RejectionCategory>;
export const RejectOutboxWithCategoryRequestZ = RejectOutboxRequestZ.extend({ category: RejectionCategoryZ.optional() });
export type RejectOutboxWithCategoryRequest = z.infer<typeof RejectOutboxWithCategoryRequestZ>;
export type ScorecardsResponse = ApiEnvelope<{ days: number; criteria: PromotionCriteria; scorecards: AgentScorecard[] }>;
export type PromotionCriteriaResponse = ApiEnvelope<{ criteria: PromotionCriteria }>;
export const PromoteAgentRequestZ = z.object({ force: z.boolean().optional(), note: z.string().max(1000).optional() });
export type PromoteAgentRequest = z.infer<typeof PromoteAgentRequestZ>;
export type { LintFinding };

// --- Routines & evals (admin-routines.ts) ------------------------------------
// GET    /v1/admin/routines?agentId=              → ListRoutinesResponse
// POST   /v1/admin/routines body CreateRoutineRequest → RoutineResponse
// PATCH  /v1/admin/routines/:id body PatchRoutineRequest → RoutineResponse
// DELETE /v1/admin/routines/:id                   → ApiEnvelope<{ deleted: true }>
// POST   /v1/admin/routines/:id/run               → RoutineResponse (run now, regardless of schedule)
// GET    /v1/admin/evals?suite=&limit=            → ListEvalRunsResponse
// GET    /v1/admin/evals/:id                      → EvalRunResponse
// POST   /v1/admin/evals body StartEvalRequest    → EvalRunResponse (starts async; poll or watch SSE "eval.updated")
export const CreateRoutineRequestZ = z.object({
  agentId: z.string().min(1),
  kind: z.enum(["prospecting", "pipeline_review", "custom_task"]),
  name: z.string().min(1).max(200),
  schedule: z.string().min(9).max(100), // 5-field cron
  timezone: z.string().default("Asia/Ho_Chi_Minh"),
  config: z.record(z.unknown()).default({}),
  enabled: z.boolean().default(true),
});
export type CreateRoutineRequest = z.input<typeof CreateRoutineRequestZ>;
export const PatchRoutineRequestZ = CreateRoutineRequestZ.omit({ agentId: true }).partial();
export type PatchRoutineRequest = z.input<typeof PatchRoutineRequestZ>;
export type ListRoutinesResponse = ApiEnvelope<{ routines: Routine[] }>;
export type RoutineResponse = ApiEnvelope<{ routine: Routine }>;
export const StartEvalRequestZ = z.object({
  suite: z.string().min(1).default("sales-sdr"),
  model: z.string().optional(), // default: the suite role's template defaultModel
  caseIds: z.array(z.string()).optional(), // subset
});
export type StartEvalRequest = z.input<typeof StartEvalRequestZ>;
export type ListEvalRunsResponse = ApiEnvelope<{ runs: EvalRun[] }>;
export type EvalRunResponse = ApiEnvelope<{ run: EvalRun }>;

// ===========================================================================
// Setup wizard — CONTRACT (backend: admin-setup-wizard.ts + setup/**; UI: pages/Setup/wizard/**)
// ===========================================================================

// --- 1. Generate company profile + role KB from a domain, using agy ----------
// POST /v1/admin/setup/generate      body GenerateSetupRequest → SetupJobResponse (202-style: job starts async)
// GET  /v1/admin/setup/generate      → ListSetupJobsResponse (newest first, last 20)
// GET  /v1/admin/setup/generate/:id  → SetupJobResponse
// POST /v1/admin/setup/generate/:id/cancel → SetupJobResponse
// SSE: "setup.job.updated" { jobId, status }  and  "setup.job.progress" { jobId, line } (one readable line per agy step)
// Only one running job at a time (409 conflict otherwise). Nothing is saved until the human applies the result
// through PUT /v1/admin/setup/company and PUT /v1/admin/setup/role-kb.
export const GenerateSetupRequestZ = z.object({
  domain: z
    .string()
    .min(3)
    .max(253)
    .transform((s) => s.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase())
    .refine((s) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s), "enter a domain like example.com"),
  extraUrls: z.array(z.string().url()).max(10).default([]), // e.g. pricing / about pages the human wants included
  notes: z.string().max(2000).optional(), // guidance, e.g. "pricing on /pricing is current; ignore the beta site"
  model: z.string().optional(), // default: config setup model or the sales-sdr template defaultModel
  language: z.enum(["vi", "en"]).default("vi"), // language of generated KB prose
});
export type GenerateSetupRequest = z.input<typeof GenerateSetupRequestZ>;

export interface GeneratedRoleKbFile {
  relPath: string; // e.g. "icp.md", "sales-playbook.md", "objection-handling.md"
  title: string;
  body: string; // markdown, no placeholders
}

export interface GeneratedSetup {
  profile: CompanyProfileInput; // validated against CompanyProfileInputZ before the job is marked done
  roleKb: { role: "sales-sdr"; files: GeneratedRoleKbFile[] };
  suggestedSender: { name: string | null; address: string | null; companyAddressLine: string | null; unsubscribeMailto: string | null };
  sources: { url: string; title: string | null }[]; // pages actually read
  conflicts: string[]; // contradictions found across pages (e.g. two different price lists)
  openQuestions: string[]; // facts the site doesn't state that a human should fill in
}

export type SetupJobStatus = "running" | "done" | "failed" | "cancelled";
export interface SetupJob {
  id: string;
  domain: string;
  model: string;
  status: SetupJobStatus;
  startedAt: string;
  finishedAt: string | null;
  progress: { at: string; line: string }[]; // last ~200 lines
  result: GeneratedSetup | null;
  error: string | null;
  usage: { inputTokens?: number; outputTokens?: number } | null;
}
export type SetupJobResponse = ApiEnvelope<{ job: SetupJob }>;
export type ListSetupJobsResponse = ApiEnvelope<{ jobs: SetupJob[] }>;

// --- 2. Role knowledge base (overrides templates/<role>/kb) ------------------
// GET /v1/admin/setup/role-kb?role=sales-sdr → RoleKbResponse
//     files = kbRoot/roles/<role>/*.md if any exist (source "override"), else the template kb (source "template")
// PUT /v1/admin/setup/role-kb body PutRoleKbRequest → RoleKbResponse
//     replaces kbRoot/roles/<role>/ with exactly these files, re-syncs the KB, audits "kb.edited".
// KB ingestion rule: if kbRoot/roles/<role>/ has any .md, those are scope role:<role> and the template kb for that role is NOT ingested.
export const PutRoleKbRequestZ = z.object({
  role: z.enum(["sales-sdr", "account-manager", "chief-of-staff"]),
  files: z
    .array(z.object({ relPath: z.string().regex(/^[\w-]+\.md$/), body: z.string().min(1).max(200_000) }))
    .min(1)
    .max(20),
});
export type PutRoleKbRequest = z.input<typeof PutRoleKbRequestZ>;
export type RoleKbResponse = ApiEnvelope<{
  role: string;
  source: "override" | "template";
  files: { relPath: string; title: string; body: string; hasPlaceholders: boolean }[];
}>;

// --- 3. Email connection (runtime, no restart) --------------------------------
// GET  /v1/admin/setup/email           → EmailSettingsResponse (passwords never returned)
// PUT  /v1/admin/setup/email body EmailSettingsInput → EmailSettingsResponse
//      Persisted in the DB (passwords encrypted with AES-256-GCM using <dataDir>/secret.key, mode 600);
//      overrides the config file's `email`; the daemon hot-swaps its provider (poller + sender) without a restart.
//      Omitted/empty pass = keep the stored one. Env AGYHQ_IMAP_PASS / AGYHQ_SMTP_PASS still win if set.
// POST /v1/admin/setup/email/test body EmailSettingsInput → EmailTestResponse (tests the given, unsaved settings;
//      missing passwords fall back to stored ones). Times out after ~20s.
const MailServerZ = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().min(1).max(320),
  pass: z.string().max(1000).optional(),
});
export const EmailSettingsInputZ = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("imap-smtp"),
    address: z.string().email(),
    displayName: z.string().max(200).optional(),
    imap: MailServerZ,
    smtp: MailServerZ,
    mailbox: z.string().max(200).default("INBOX"),
    sentFolder: z.string().max(200).nullable().default(null),
    pollIntervalMs: z.number().int().min(15_000).max(3_600_000).default(60_000),
  }),
  z.object({ kind: z.literal("maildir"), address: z.string().email(), displayName: z.string().max(200).optional(), root: z.string().min(1) }),
]);
export type EmailSettingsInput = z.input<typeof EmailSettingsInputZ>;
export interface EmailSettingsView {
  kind: "none" | "imap-smtp" | "maildir";
  address: string | null;
  displayName: string | null;
  imap: { host: string; port: number; secure: boolean; user: string; hasPassword: boolean } | null;
  smtp: { host: string; port: number; secure: boolean; user: string; hasPassword: boolean } | null;
  mailbox: string | null;
  sentFolder: string | null;
  pollIntervalMs: number | null;
  root: string | null;
  source: "ui" | "config"; // where the active settings come from
  passwordFromEnv: { imap: boolean; smtp: boolean };
}
export type EmailSettingsResponse = ApiEnvelope<{ email: EmailSettingsView }>;
export type EmailTestResponse = ApiEnvelope<{ imap: { ok: boolean; error: string | null }; smtp: { ok: boolean; error: string | null } }>;

// --- 4. Sender identity & unsubscribe (runtime, no restart) ------------------
// GET /v1/admin/setup/sender → SenderSettingsResponse ; PUT body SenderSettingsInput → SenderSettingsResponse
// Persisted in kv "sender_settings"; overrides config.sender / config.unsubscribeMailto everywhere (sender footer,
// List-Unsubscribe, readiness).
export const SenderSettingsInputZ = z.object({
  name: z.string().min(1).max(200),
  address: z.string().email(),
  companyAddressLine: z.string().min(5).max(500),
  unsubscribeMailto: z.string().email(),
});
export type SenderSettingsInput = z.infer<typeof SenderSettingsInputZ>;
export type SenderSettingsResponse = ApiEnvelope<{ sender: SenderSettingsInput & { source: "ui" | "config" } }>;
