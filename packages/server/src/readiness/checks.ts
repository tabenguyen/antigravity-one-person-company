// Go-live readiness engine: pure function over (config, db, email verifier).
// Every check returns pass | warn | fail with an actionable `detail` and the UI
// route (`fixPath`) that fixes it. Only "fail" blocks enabling outbound.

import path from "node:path";
import type { CompanyProfile, ReadinessCheck, ReadinessReport, ReadinessStatus } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import type { AgyhqConfig } from "../config.ts";
import { loadCompanyProfile } from "./company.ts";
import { findPlaceholder } from "./placeholders.ts";
import { effectiveSender } from "../setup/sender-settings.ts";

export type VerifyResult = { ok: true } | { ok: false; error: string };

export interface ReadinessDeps {
  config: AgyhqConfig;
  db: Db;
  /** Probe the email provider (callers decide whether to cache). Never needs to throw. */
  verifyEmail: () => Promise<VerifyResult>;
  now?: () => Date;
}

/** Quota buckets below this remaining fraction raise a warning. */
export const QUOTA_WARN_FRACTION = 0.2;
/** Send rates above this per hour raise a warning (warm-up guidance). */
export const SEND_RATE_WARN = 50;

const MAX_FILES_LISTED = 5;

function check(id: string, title: string, status: ReadinessStatus, detail: string, fixPath: string | null): ReadinessCheck {
  return { id, title, status, detail, fixPath };
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function isPlaceholderAddress(value: string): boolean {
  return /yourcompany\.com/i.test(value) || /@example\.(com|org|net)$/i.test(value);
}

// -- individual checks --------------------------------------------------------

function companyProfileCheck(profile: CompanyProfile | null): ReadinessCheck {
  return profile
    ? check("company.profile", "Company profile saved", "pass", `Saved for ${profile.companyName}.`, "/setup#company")
    : check(
        "company.profile",
        "Company profile saved",
        "fail",
        "No company profile yet. Fill in the Company profile form so agents know what you sell, to whom, and what they must never claim.",
        "/setup#company",
      );
}

function kbChecks(deps: ReadinessDeps): ReadinessCheck[] {
  const { db, config } = deps;
  const docs = db.kb.listDocuments();
  const companyDocs = docs.filter((d) => d.scope === "company");

  const present =
    companyDocs.length > 0
      ? check("kb.company_present", "Company knowledge base present", "pass", `${companyDocs.length} company document(s) indexed.`, "/setup#company")
      : check(
          "kb.company_present",
          "Company knowledge base present",
          "fail",
          "No company-wide knowledge base documents are indexed. Saving the company profile generates them.",
          "/setup#company",
        );

  // A role's starter KB is only a risk once an agent of that role is working: roles nobody runs may keep TODO sections.
  const activeRoles = new Set(db.agents.list({ status: "active" }).map((a) => `role:${a.role}`));
  const offenders: string[] = [];
  let offenderCount = 0;
  for (const doc of docs) {
    if (doc.scope !== "company" && !activeRoles.has(doc.scope)) continue;
    const hit = findPlaceholder(doc.body);
    if (!hit) continue;
    offenderCount++;
    if (offenders.length < MAX_FILES_LISTED) {
      const label =
        doc.scope === "company"
          ? path.relative(config.kbRoot, doc.sourcePath) || path.basename(doc.sourcePath)
          : `${doc.scope}/${path.basename(doc.sourcePath)}`;
      offenders.push(`${label} line ${hit.line} (${hit.marker}): "${hit.text}"`);
    }
  }
  const more = offenderCount > offenders.length ? ` …and ${offenderCount - offenders.length} more.` : "";
  const clean =
    offenderCount === 0
      ? check("kb.no_placeholders", "Knowledge base has no placeholder text", "pass", "No example/TODO placeholder text found in company or role knowledge base.", "/knowledge")
      : check(
          "kb.no_placeholders",
          "Knowledge base has no placeholder text",
          "fail",
          `${offenderCount} knowledge base file(s) still contain placeholder text that agents would quote as real claims. Replace it with real content or delete the file: ${offenders.join("; ")}.${more}`,
          "/knowledge",
        );

  return [present, clean];
}

function senderChecks(config: AgyhqConfig, db: Db): ReadinessCheck[] {
  const problems: string[] = [];
  // UI-saved sender settings (Setup wizard) win over the config file — the same helper the Sender uses.
  const sender = effectiveSender(config, db);
  const { name, address, companyAddressLine } = sender;
  if (!name.trim() || /^Your Company/i.test(name.trim())) problems.push(`sender.name is "${name}"`);
  if (!address.trim()) problems.push("sender.address is empty");
  else if (isPlaceholderAddress(address)) problems.push(`sender.address is the example "${address}"`);
  else if (!EMAIL_RE.test(address.trim())) problems.push(`sender.address "${address}" is not a valid email address`);
  if (!companyAddressLine.trim()) problems.push("sender.companyAddressLine is empty");
  else if (/123 Main St/i.test(companyAddressLine) || /^Your Company/i.test(companyAddressLine.trim())) {
    problems.push(`sender.companyAddressLine is the example "${companyAddressLine}"`);
  }
  const identity =
    problems.length === 0
      ? check("sender.identity", "Sender identity configured", "pass", `Sending as ${name} <${address}>.`, "/setup#email")
      : check(
          "sender.identity",
          "Sender identity configured",
          "fail",
          `Set a real sender on the Setup page (the footer of every email shows your name and postal address): ${problems.join("; ")}.`,
          "/setup#email",
        );

  const raw = sender.unsubscribeMailto.trim().replace(/^mailto:/i, "");
  let unsubDetail: string | null = null;
  if (!raw) unsubDetail = "unsubscribeMailto is empty";
  else if (isPlaceholderAddress(raw)) unsubDetail = `unsubscribeMailto is the example "${sender.unsubscribeMailto}"`;
  else if (!EMAIL_RE.test(raw)) unsubDetail = `unsubscribeMailto "${sender.unsubscribeMailto}" is not a valid email address`;
  const unsub =
    unsubDetail === null
      ? check("unsubscribe.mailto", "Unsubscribe address configured", "pass", `Recipients can unsubscribe via ${raw}.`, "/setup#email")
      : check(
          "unsubscribe.mailto",
          "Unsubscribe address configured",
          "fail",
          `${unsubDetail}. Set a mailbox you monitor as the unsubscribe address on the Setup page; every email must offer a working opt-out.`,
          "/setup#email",
        );
  return [identity, unsub];
}

async function emailChecks(deps: ReadinessDeps): Promise<ReadinessCheck[]> {
  const kind = deps.config.email.kind;
  let provider: ReadinessCheck;
  if (kind === "none") {
    provider = check(
      "email.provider",
      "Email provider configured",
      "fail",
      'No email provider (email.kind is "none"). Connect a mailbox on the Setup page (no restart needed).',
      "/setup#email",
    );
  } else if (kind === "maildir") {
    provider = check(
      "email.provider",
      "Email provider configured",
      "warn",
      "maildir is a local development provider: nothing reaches a real mailbox. Use imap-smtp for a real shadow run.",
      "/setup#email",
    );
  } else {
    provider = check("email.provider", "Email provider configured", "pass", `Using ${kind}.`, "/setup#email");
  }

  let verified: ReadinessCheck;
  if (kind === "none") {
    verified = check("email.verified", "Email connection verified", "fail", "Skipped: no email provider is configured.", "/setup#email");
  } else {
    let result: VerifyResult;
    try {
      result = await deps.verifyEmail();
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    verified = result.ok
      ? check("email.verified", "Email connection verified", "pass", "The provider accepted a connection test.", "/setup#email")
      : check(
          "email.verified",
          "Email connection verified",
          "fail",
          `Connection test failed: ${result.error}. Check host, port, credentials and use "Test connection".`,
          "/setup#email",
        );
  }
  return [provider, verified];
}

function agentChecks(deps: ReadinessDeps): ReadinessCheck[] {
  const { db } = deps;
  const settings = db.settings.get();
  const agents = db.agents.list();
  const sdrs = agents.filter((a) => a.role === "sales-sdr" && a.status === "active");
  const ams = agents.filter((a) => a.role === "account-manager" && a.status === "active");

  const present =
    sdrs.length > 0
      ? check("agents.sdr_present", "Active Sales SDR agent", "pass", `Active: ${sdrs.map((a) => a.id).join(", ")}.`, "/agents")
      : ams.length > 0 // an account-manager-only setup (no outbound prospecting) is a valid way to start
        ? check("agents.sdr_present", "Active Sales SDR agent", "warn", `No active sales-sdr agent; only account manager(s) ${ams.map((a) => a.id).join(", ")} can draft email.`, "/agents")
        : check("agents.sdr_present", "Active Sales SDR agent", "fail", "No active sales-sdr agent. Create one on the Agents page (start in shadow tier).", "/agents");

  const autonomous = agents.filter((a) => a.trustTier === "autonomous");
  const trust =
    autonomous.length === 0
      ? check("agents.trust", "Agents start under human review", "pass", "No agent is autonomous; every draft needs human approval.", "/agents")
      : check(
          "agents.trust",
          "Agents start under human review",
          "warn",
          `Autonomous agent(s) can send without review: ${autonomous.map((a) => a.id).join(", ")}. Keep new agents in shadow or assisted until their scorecard qualifies them.`,
          "/agents",
        );

  const defaultId = settings.defaultSdrAgentId;
  let defaultSdr: ReadinessCheck;
  if (!defaultId) {
    defaultSdr = check("settings.default_sdr", "Default SDR for new leads", "warn", "No default SDR agent is set, so inbound mail from unknown senders has no owner. Choose one in Settings.", "/settings");
  } else if (!agents.some((a) => a.id === defaultId)) {
    defaultSdr = check("settings.default_sdr", "Default SDR for new leads", "warn", `Default SDR "${defaultId}" no longer exists. Choose another in Settings.`, "/settings");
  } else {
    defaultSdr = check("settings.default_sdr", "Default SDR for new leads", "pass", `New leads go to ${defaultId}.`, "/settings");
  }
  const checks = [present, trust, defaultSdr];

  // Phase 4 roles: only mentioned once they are in use (or a stale default points at nothing).
  for (const spec of [
    { key: "defaultAmAgentId", role: "account-manager", id: "settings.default_am", title: "Default Account Manager for won deals", what: "handoffs (Won -> Account Manager) and customer messages" },
    { key: "defaultCosAgentId", role: "chief-of-staff", id: "settings.default_cos", title: "Default Chief of Staff for triage", what: "inbound mail nobody owns" },
  ] as const) {
    const roleAgents = agents.filter((a) => a.role === spec.role && a.status === "active");
    const configured = settings[spec.key];
    const current = configured ? agents.find((a) => a.id === configured) : null;
    if (configured && (!current || current.status !== "active")) {
      checks.push(check(spec.id, spec.title, "warn", `${spec.key} "${configured}" is not an active ${spec.role} agent. Choose another in Settings.`, "/settings"));
    } else if (!configured && roleAgents.length > 0) {
      checks.push(check(spec.id, spec.title, "warn", `${roleAgents.map((a) => a.id).join(", ")} exists but no default is set, so ${spec.what} have no owner. Choose one in Settings.`, "/settings"));
    } else if (configured) {
      checks.push(check(spec.id, spec.title, "pass", `${configured} handles ${spec.what}.`, "/settings"));
    }
  }
  return checks;
}

function settingsChecks(deps: ReadinessDeps): ReadinessCheck[] {
  const settings = deps.db.settings.get();
  const quiet = settings.quietHours
    ? check(
        "settings.quiet_hours",
        "Quiet hours enabled",
        "pass",
        `No sending ${settings.quietHours.startHour}:00–${settings.quietHours.endHour}:00 ${settings.quietHours.timezone}.`,
        "/settings",
      )
    : check("settings.quiet_hours", "Quiet hours enabled", "warn", "Quiet hours are off, so emails can go out at any hour. Enable them in Settings.", "/settings");

  const rate =
    settings.sendRatePerHour > SEND_RATE_WARN
      ? check(
          "settings.rate",
          "Send rate is conservative",
          "warn",
          `Send rate is ${settings.sendRatePerHour}/hour (above ${SEND_RATE_WARN}). A new mailbox should warm up slowly; lower it in Settings.`,
          "/settings",
        )
      : check("settings.rate", "Send rate is conservative", "pass", `Send rate is ${settings.sendRatePerHour}/hour.`, "/settings");
  return [quiet, rate];
}

function quotaCheck(deps: ReadinessDeps): ReadinessCheck {
  const snap = deps.db.quota.latest();
  if (!snap) return check("quota", "Model quota headroom", "pass", "No quota snapshot recorded yet.", "/dashboard");
  const low = snap.buckets.filter((b) => b.remainingFraction < QUOTA_WARN_FRACTION);
  if (low.length === 0) return check("quota", "Model quota headroom", "pass", "All quota buckets have more than 20% remaining.", "/dashboard");
  return check(
    "quota",
    "Model quota headroom",
    "warn",
    `Low quota: ${low.map((b) => `${b.group} (${b.window}) ${Math.round(b.remainingFraction * 100)}% left`).join(", ")}. Agents may be throttled.`,
    "/dashboard",
  );
}

// -- entry point ---------------------------------------------------------------

export async function computeReadiness(deps: ReadinessDeps): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [
    companyProfileCheck(loadCompanyProfile(deps.db)),
    ...kbChecks(deps),
    ...senderChecks(deps.config, deps.db),
    ...(await emailChecks(deps)),
    ...agentChecks(deps),
    ...settingsChecks(deps),
    quotaCheck(deps),
  ];
  return {
    ready: checks.every((c) => c.status !== "fail"),
    checks,
    at: (deps.now?.() ?? new Date()).toISOString(),
  };
}

export function failingChecks(report: ReadinessReport): ReadinessCheck[] {
  return report.checks.filter((c) => c.status === "fail");
}
