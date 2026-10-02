// `hq email doctor`: read-only preflight of the configured REAL mailbox, plus a dry run of what the harness would do
// with the latest mail. The mailbox part lives in @agyhq/channels (runMailboxDoctor); this layer adds the harness
// view: classification and would-route-to for each sampled message (planInbound — nothing is created), shadow-safety
// facts, and a plain pass/warn/fail checklist. Passwords are never part of the report.

import { runMailboxDoctor } from "@agyhq/channels";
import type { MailboxDoctorOptions, MailboxDoctorReport } from "@agyhq/channels";
import type { EmailSignals, InboundClassification, TrustTier } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import type { AgyhqConfig, EmailConfig } from "./config.ts";
import { planInbound, type PlannedAction } from "./inbound-plan.ts";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  title: string;
  detail: string;
}

export interface DoctorSampleView {
  providerId: string;
  arrivedAt: string | null;
  from: string | null;
  subject: string | null;
  /** First ~160 characters of the reply text (quoted history stripped). */
  preview: string;
  attachments: number;
  parseError: string | null;
  classification: InboundClassification | null;
  /** Which classification signals fired (auto-reply / bounce / unsubscribe / spam). */
  signals: string[];
  knownThread: boolean;
  alreadyIngested: boolean;
  route: { action: PlannedAction; agentId: string | null; agentRole: string | null; taskKind: string | null; summary: string } | null;
}

export interface EmailDoctorReport {
  generatedAt: string;
  mode: "daemon" | "local";
  /** No failing check. */
  ok: boolean;
  config: {
    kind: string;
    address: string | null;
    imap: { host: string; port: number; secure: boolean; user: string; hasPassword: boolean } | null;
    smtp: { host: string; port: number; secure: boolean; user: string; hasPassword: boolean } | null;
    mailbox: string | null;
    sentFolder: string | null;
    syncSent: boolean;
    initialSyncDays: number;
  };
  checks: DoctorCheck[];
  /** The raw mailbox findings (folders, counts, first-sync forecast) with the samples' bodies removed. */
  mailbox: Omit<MailboxDoctorReport, "samples"> | null;
  samples: DoctorSampleView[];
  /** What would happen to the sampled mail, e.g. { task: 6, ignore: 3 }. */
  routingSummary: Record<string, number>;
  safety: { outboundEnabled: boolean; agents: { id: string; role: string; trustTier: TrustTier; status: string }[]; nothingCanBeSent: boolean };
}

export interface EmailDoctorOptions {
  sample?: number;
  /** Send exactly one test email to this address (only when given). */
  sendTest?: string | null;
  mode?: "daemon" | "local";
  now?: () => Date;
  /** Test seam. */
  runMailbox?: (opts: MailboxDoctorOptions) => Promise<MailboxDoctorReport>;
}

const SIGNAL_NAMES: [keyof EmailSignals, string][] = [
  ["isAutoReply", "auto-reply"],
  ["isBounce", "bounce"],
  ["isUnsubscribe", "unsubscribe"],
  ["isLikelySpam", "spam"],
];

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function emptyConfigView(email: EmailConfig): EmailDoctorReport["config"] {
  return { kind: email.kind, address: null, imap: null, smtp: null, mailbox: null, sentFolder: null, syncSent: false, initialSyncDays: 0 };
}

export function configView(email: EmailConfig): EmailDoctorReport["config"] {
  if (email.kind !== "imap-smtp") return { ...emptyConfigView(email), address: "address" in email ? email.address : null };
  const server = (s: { host: string; port: number; secure: boolean; user: string; pass: string }) => ({
    host: s.host,
    port: s.port,
    secure: s.secure,
    user: s.user,
    hasPassword: s.pass.length > 0,
  });
  return {
    kind: email.kind,
    address: email.address,
    imap: server(email.imap),
    smtp: server(email.smtp),
    mailbox: email.mailbox ?? "INBOX",
    sentFolder: email.sentFolder ?? null,
    syncSent: email.syncSent === true,
    initialSyncDays: email.initialSyncDays ?? 0,
  };
}

function safetyFacts(db: Db): EmailDoctorReport["safety"] {
  const outboundEnabled = db.settings.get().outboundEnabled;
  const agents = db.agents
    .list()
    .filter((a) => a.status !== "archived")
    .map((a) => ({ id: a.id, role: a.role, trustTier: a.trustTier, status: a.status as string }));
  const nonShadow = agents.filter((a) => a.trustTier !== "shadow");
  return { outboundEnabled, agents, nothingCanBeSent: !outboundEnabled || nonShadow.length === 0 };
}

export async function runEmailDoctor(
  deps: { config: AgyhqConfig; db: Db },
  email: EmailConfig,
  opts: EmailDoctorOptions = {},
): Promise<EmailDoctorReport> {
  const now = opts.now ? opts.now() : new Date();
  const mode = opts.mode ?? "daemon";
  const cfg = configView(email);
  const safety = safetyFacts(deps.db);
  const checks: DoctorCheck[] = [];
  const base: Omit<EmailDoctorReport, "checks" | "ok"> = { generatedAt: now.toISOString(), mode, config: cfg, safety, mailbox: null, samples: [], routingSummary: {} };
  const finish = (): EmailDoctorReport => ({ ...base, checks, ok: !checks.some((c) => c.status === "fail") });

  if (email.kind !== "imap-smtp") {
    checks.push({
      id: "config.kind",
      status: "fail",
      title: "A real mailbox is configured",
      detail: email.kind === "none" ? "email.kind is \"none\": nothing is read or sent. Configure imap-smtp (Setup page or agyhq.config.json)." : `email.kind is "${email.kind}" (a local test provider); the doctor only inspects imap-smtp mailboxes.`,
    });
    return finish();
  }

  const missing = [!email.imap.pass ? "IMAP" : null, !email.smtp.pass ? "SMTP" : null].filter(Boolean);
  if (missing.length > 0) {
    checks.push({
      id: "config.password",
      status: "fail",
      title: "Mailbox passwords are set",
      detail: `No ${missing.join(" / ")} password is configured. Set AGYHQ_IMAP_PASS / AGYHQ_SMTP_PASS in the environment (or save them in the Setup page).`,
    });
    return finish();
  }
  checks.push({ id: "config.password", status: "pass", title: "Mailbox passwords are set", detail: "IMAP and SMTP passwords are present (never printed)." });

  const sendTest = opts.sendTest?.trim() ? { to: opts.sendTest.trim() } : null;
  const run = opts.runMailbox ?? runMailboxDoctor;
  const mb = await run({
    address: email.address,
    displayName: email.displayName,
    imap: email.imap,
    smtp: email.smtp,
    mailbox: email.mailbox,
    sentFolder: email.sentFolder,
    syncSent: email.syncSent,
    initialSyncDays: email.initialSyncDays,
    initialSyncMaxMessages: email.initialSyncMaxMessages,
    sample: opts.sample,
    sendTest,
    now: () => now,
  });
  const { samples: rawSamples, ...mailbox } = mb;
  base.mailbox = mailbox;

  // ---- IMAP -------------------------------------------------------------
  checks.push(
    mb.imap.ok
      ? { id: "imap.login", status: "pass", title: "IMAP login", detail: `Logged in to ${mb.imap.host}:${mb.imap.port} as ${mb.imap.user} (${mb.imap.tookMs} ms).` }
      : { id: "imap.login", status: "fail", title: "IMAP login", detail: mb.imap.error ?? "login failed" },
  );
  if (mb.imap.ok) {
    checks.push(
      mb.mailbox.error
        ? { id: "imap.mailbox", status: "fail", title: `Mailbox "${mb.mailbox.name}" opens read-only`, detail: mb.mailbox.error }
        : {
            id: "imap.mailbox",
            status: "pass",
            title: `Mailbox "${mb.mailbox.name}" opens read-only`,
            detail: `${mb.mailbox.exists ?? "?"} messages, UIDVALIDITY ${mb.mailbox.uidValidity}. It is opened with EXAMINE and read with BODY.PEEK: nothing is marked seen, moved or deleted.`,
          },
    );

    // sent folder
    const sent = mb.folders.sent;
    if (mb.folders.error) {
      checks.push({ id: "imap.sent_folder", status: "warn", title: "Sent folder", detail: `Could not list folders: ${mb.folders.error}` });
    } else if (sent?.ok) {
      checks.push({
        id: "imap.sent_folder",
        status: "pass",
        title: "Sent folder",
        detail: `Found "${sent.path}" (${sent.via === "configured" ? "configured" : sent.via === "special-use" ? "marked \\Sent by the server" : "matched by name"}). ${cfg.syncSent ? "Sent-folder sync is ON: mail your team sends from their own mail client is recorded." : "Sent-folder sync is OFF (syncSent): the agents will not learn what your team replies from their own mail client."}`,
      });
    } else {
      checks.push({
        id: "imap.sent_folder",
        status: cfg.syncSent ? "fail" : "warn",
        title: "Sent folder",
        detail: `${sent?.error ?? "not found"}. Folders on the server: ${(sent && !sent.ok ? sent.available : mb.folders.all.map((f) => f.path)).slice(0, 25).join(", ") || "(none)"}.`,
      });
    }

    // first sync
    const fs = mb.firstSync;
    const windows = fs.windows.map((w) => `${w.days}d: ${w.count}`).join(", ");
    if (fs.error) {
      checks.push({ id: "sync.first", status: "warn", title: "First sync", detail: `Could not forecast: ${fs.error}` });
    } else if (fs.policy.initialSyncDays === 0) {
      checks.push({
        id: "sync.first",
        status: "pass",
        title: "First sync ingests nothing old",
        detail: `initialSyncDays=0: only mail that arrives after the first connection is processed; the ${fs.totalInMailbox ?? "?"} messages already there are never touched. Arrived recently, for reference (approx): ${windows || "n/a"}. Set initialSyncDays to also process the last N days.`,
      });
    } else {
      checks.push({
        id: "sync.first",
        status: fs.wouldIngest > 100 ? "warn" : "pass",
        title: `First sync reads the last ${fs.policy.initialSyncDays} day(s)`,
        detail: `About ${fs.wouldIngest} existing message(s) would be ingested on the first poll (cap ${fs.policy.initialSyncMaxMessages}); each unanswered one becomes an agent task. Arrived recently (approx): ${windows}.`,
      });
    }

    // parse
    const failed = rawSamples.filter((s) => s.parseError);
    if (rawSamples.length === 0) {
      checks.push({ id: "mail.parse", status: "warn", title: "Latest messages parse", detail: "No messages to sample (the mailbox is empty or sampling was off)." });
    } else {
      checks.push(
        failed.length === 0
          ? { id: "mail.parse", status: "pass", title: "Latest messages parse", detail: `${rawSamples.length} message(s) fetched with BODY.PEEK and parsed (subjects, bodies, attachments).` }
          : { id: "mail.parse", status: "warn", title: "Latest messages parse", detail: `${failed.length} of ${rawSamples.length} could not be parsed: ${failed.map((f) => f.parseError).slice(0, 3).join("; ")}` },
      );
    }
  }

  // ---- classification + dry-run routing ------------------------------------
  const planCtx = { db: deps.db, config: deps.config };
  const samples: DoctorSampleView[] = rawSamples.map((s) => {
    if (!s.parsed) {
      return { providerId: s.providerId, arrivedAt: s.arrivedAt, from: null, subject: null, preview: "", attachments: 0, parseError: s.parseError, classification: null, signals: [], knownThread: false, alreadyIngested: false, route: null };
    }
    const plan = planInbound(planCtx, s.parsed);
    return {
      providerId: s.providerId,
      arrivedAt: s.arrivedAt,
      from: s.parsed.from ? `${s.parsed.from.name ? `${s.parsed.from.name} ` : ""}<${s.parsed.from.address}>` : null,
      subject: s.parsed.subject,
      preview: truncate(s.parsed.replyText || s.parsed.text, 160),
      attachments: s.parsed.attachments.length,
      parseError: null,
      classification: plan.classification,
      signals: plan.signals ? SIGNAL_NAMES.filter(([k]) => plan.signals![k]).map(([, n]) => n) : [],
      knownThread: plan.knownThread,
      alreadyIngested: plan.alreadyIngested,
      route: plan.route,
    };
  });
  base.samples = samples;
  for (const s of samples) {
    const key = s.route ? (s.route.action === "task" ? `task:${s.route.taskKind}` : s.route.action) : "unparsed";
    base.routingSummary[key] = (base.routingSummary[key] ?? 0) + 1;
  }

  if (samples.length > 0) {
    const tasks = samples.filter((s) => s.route?.action === "task");
    const parked = samples.filter((s) => s.route?.action === "parked");
    const newLeads = samples.filter((s) => s.classification === "new_lead" && s.route?.action === "task");
    const summary = Object.entries(base.routingSummary).map(([k, n]) => `${n}x ${k}`).join(", ");
    if (parked.length > 0) {
      checks.push({ id: "routing.dry_run", status: "warn", title: "Dry-run routing", detail: `${parked.length} of ${samples.length} sampled message(s) would stay unrouted (${parked[0]!.route!.summary}). Would happen to the sample: ${summary}.` });
    } else if (newLeads.length * 2 > samples.length && samples.length >= 4) {
      checks.push({
        id: "routing.dry_run",
        status: "warn",
        title: "Dry-run routing",
        detail: `${newLeads.length} of ${samples.length} sampled messages would each become a NEW LEAD with a research task (newsletters, notifications and personal mail count too). This looks like a busy general mailbox; for the shadow run prefer a dedicated sales address. Would happen to the sample: ${summary}.`,
      });
    } else {
      checks.push({ id: "routing.dry_run", status: "pass", title: "Dry-run routing", detail: `${tasks.length} of ${samples.length} sampled message(s) would create an agent task. Would happen to the sample: ${summary}. Nothing was created.` });
    }
  }

  // ---- SMTP -------------------------------------------------------------
  checks.push(
    mb.smtp.ok
      ? { id: "smtp.auth", status: "pass", title: "SMTP authentication", detail: `Connected to ${mb.smtp.host}:${mb.smtp.port} and authenticated as ${mb.smtp.user} (${mb.smtp.tookMs} ms). Nothing was sent.` }
      : { id: "smtp.auth", status: "fail", title: "SMTP authentication", detail: mb.smtp.error ?? "SMTP check failed" },
  );
  if (sendTest) {
    const st = mb.sendTest;
    checks.push(
      st.attempted && !st.error
        ? { id: "smtp.send_test", status: "pass", title: "Test email sent", detail: `Exactly one message was sent to ${st.to} (${st.response ?? "accepted"}; Message-ID <${st.messageId}>). Check that it arrived.` }
        : { id: "smtp.send_test", status: "fail", title: "Test email", detail: st.error ?? "not sent" },
    );
    if (st.attempted) {
      deps.db.audit.append({ kind: "email.test_sent", agentId: null, taskId: null, conversationId: null, data: { to: st.to, messageId: st.messageId, ok: !st.error } });
    }
  }

  // ---- shadow safety --------------------------------------------------------
  const nonShadow = safety.agents.filter((a) => a.trustTier !== "shadow");
  if (safety.agents.length === 0) {
    checks.push({ id: "safety.shadow", status: "warn", title: "Shadow safety", detail: `No agents exist yet. Create them in the shadow tier (the default). Outbound kill switch is ${safety.outboundEnabled ? "ON" : "off"}.` });
  } else if (nonShadow.length === 0) {
    checks.push({ id: "safety.shadow", status: "pass", title: "Shadow safety", detail: `All ${safety.agents.length} agent(s) are in the shadow tier: their approved drafts are parked in "held" and can never reach SMTP${safety.outboundEnabled ? " (the kill switch is on, but only for non-shadow agents)" : "; the outbound kill switch is also off"}.` });
  } else {
    checks.push({
      id: "safety.shadow",
      status: safety.outboundEnabled ? "fail" : "warn",
      title: "Shadow safety",
      detail: `${nonShadow.map((a) => `${a.id} (${a.trustTier})`).join(", ")} ${nonShadow.length === 1 ? "is" : "are"} NOT in the shadow tier. ${safety.outboundEnabled ? "The outbound kill switch is ON: their approved drafts WILL be emailed." : "The outbound kill switch is off, so nothing is sent yet, but approved drafts will go out as soon as it is turned on."}`,
    });
  }

  return finish();
}
