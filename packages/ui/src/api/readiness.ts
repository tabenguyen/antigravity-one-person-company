// Phase 3: go-live readiness + guided company setup. Thin typed wrappers over
// the admin routes in packages/server/src/admin-readiness.ts.

import { request } from "./client.ts";
import type { CompanyProfile, HqSettings, ReadinessCheck, ReadinessReport } from "@agyhq/core";
import type { CompanyProfileInput } from "@agyhq/server";

export type { CompanyProfile, ReadinessReport, ReadinessCheck, CompanyProfileInput };

export interface EmailTestResult {
  ok: boolean;
  error: string | null;
  checkedAt: string;
}

export interface KillSwitchBody {
  outboundEnabled: boolean;
  reason?: string;
  /** Override failing readiness checks (audited server-side). */
  force?: boolean;
}

export const readinessApi = {
  readiness: () => request<{ readiness: ReadinessReport }>("/v1/admin/readiness", { method: "GET" }),
  getCompany: () => request<{ profile: CompanyProfile | null }>("/v1/admin/setup/company", { method: "GET" }),
  putCompany: (body: CompanyProfileInput) =>
    request<{ profile: CompanyProfile; files?: string[] }>("/v1/admin/setup/company", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  emailTest: () => request<EmailTestResult>("/v1/admin/setup/email-test", { method: "POST" }),
  /** Same route as api.killSwitch, but accepts `force` (api.killSwitch's type predates the readiness gate). */
  killSwitch: (body: KillSwitchBody) =>
    request<{ settings: HqSettings }>("/v1/admin/killswitch", { method: "POST", body: JSON.stringify(body) }),
};
