// Setup wizard: thin typed wrappers over the admin routes in the "Setup wizard"
// contract at the end of packages/server/src/admin-types.ts.

import { request } from "./client.ts";
import type {
  EmailSettingsInput,
  EmailSettingsView,
  EmailTestResponse,
  GenerateSetupRequest,
  GeneratedRoleKbFile,
  GeneratedSetup,
  PutRoleKbRequest,
  RoleKbResponse,
  SenderSettingsInput,
  SetupJob,
  SetupJobStatus,
} from "@agyhq/server";

export type {
  EmailSettingsInput,
  EmailSettingsView,
  GenerateSetupRequest,
  GeneratedRoleKbFile,
  GeneratedSetup,
  PutRoleKbRequest,
  SenderSettingsInput,
  SetupJob,
  SetupJobStatus,
};
export type EmailTestResult = Extract<EmailTestResponse, { ok: true }>["data"];
export type RoleKbData = Extract<RoleKbResponse, { ok: true }>["data"];
export type SenderView = SenderSettingsInput & { source: "ui" | "config" };

const json = (body: unknown) => JSON.stringify(body);
const P = "/v1/admin/setup";

export const setupWizardApi = {
  // -- AI generation -------------------------------------------------------
  generate: (body: GenerateSetupRequest) => request<{ job: SetupJob }>(`${P}/generate`, { method: "POST", body: json(body) }),
  listJobs: () => request<{ jobs: SetupJob[] }>(`${P}/generate`, { method: "GET" }),
  getJob: (id: string) => request<{ job: SetupJob }>(`${P}/generate/${encodeURIComponent(id)}`, { method: "GET" }),
  cancelJob: (id: string) => request<{ job: SetupJob }>(`${P}/generate/${encodeURIComponent(id)}/cancel`, { method: "POST" }),

  // -- Role knowledge base -------------------------------------------------
  getRoleKb: (role = "sales-sdr") => request<RoleKbData>(`${P}/role-kb?role=${encodeURIComponent(role)}`, { method: "GET" }),
  putRoleKb: (body: PutRoleKbRequest) => request<RoleKbData>(`${P}/role-kb`, { method: "PUT", body: json(body) }),

  // -- Email connection ----------------------------------------------------
  getEmail: () => request<{ email: EmailSettingsView }>(`${P}/email`, { method: "GET" }),
  putEmail: (body: EmailSettingsInput) => request<{ email: EmailSettingsView }>(`${P}/email`, { method: "PUT", body: json(body) }),
  testEmail: (body: EmailSettingsInput) => request<EmailTestResult>(`${P}/email/test`, { method: "POST", body: json(body) }),

  // -- Sender identity -----------------------------------------------------
  getSender: () => request<{ sender: SenderView }>(`${P}/sender`, { method: "GET" }),
  putSender: (body: SenderSettingsInput) => request<{ sender: SenderView }>(`${P}/sender`, { method: "PUT", body: json(body) }),
};
