// Phase 4 API: handoff, per-role KPIs, briefings. Wire types come from @agyhq/server / @agyhq/core (type-only).

import type { AuditEvent, Briefing, Contact, Task } from "@agyhq/core";
import type { HandoffContactRequest, KpiReport } from "@agyhq/server";
import { qs, request } from "./client.ts";

export type { Briefing, KpiReport };

export interface HandoffResult {
  contact: Contact;
  task: Task;
  fromAgentId: string | null;
  toAgentId: string;
}

export const coordinationApi = {
  kpis: (days = 7) => request<KpiReport>(`/v1/admin/kpis${qs({ days })}`, { method: "GET" }),
  listBriefings: (params: { limit?: number; agentId?: string } = {}) =>
    request<{ briefings: Briefing[] }>(`/v1/admin/briefings${qs({ limit: params.limit, agentId: params.agentId })}`, { method: "GET" }),
  getBriefing: (id: string) => request<{ briefing: Briefing }>(`/v1/admin/briefings/${encodeURIComponent(id)}`, { method: "GET" }),
  handoff: (contactId: string, body: HandoffContactRequest = {}) =>
    request<HandoffResult>(`/v1/admin/contacts/${encodeURIComponent(contactId)}/handoff`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** `contact.handoff` audit rows (newest first); the audit API has no contact filter, so callers filter on data.contactId. */
  listHandoffAudit: (limit = 200) =>
    request<{ events: AuditEvent[] }>(`/v1/admin/audit${qs({ kind: ["contact.handoff"], limit })}`, { method: "GET" }),
};
