// agy-hq daemon configuration: agyhq.config.json (optional) merged over
// built-in defaults, then over environment variable overrides. Everything is
// zod-validated so a bad config file fails fast with a clear message.
//
// See the wave-2 task spec: dataDir/db/workspaces layout, admin token
// generation + persistence, build-artifact paths (hooks dist, mcp entry),
// worker/poll/timeout knobs, and quota throttle thresholds.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { EmailProviderConfig } from "@agyhq/channels";

// ---------------------------------------------------------------------------
// Repo root discovery (this repo has no .git — see environment note — so we
// walk up from cwd looking for the workspace root package.json instead).

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { workspaces?: unknown; name?: unknown };
        if (pkg.name === "agy-hq" || Array.isArray(pkg.workspaces)) return dir;
      } catch {
        // ignore and keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return startDir; // reached filesystem root; give up, use cwd
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Config file shape (all fields optional — merged over defaults)

const QuotaConfigZ = z
  .object({
    minRemainingFraction: z.number().min(0).max(1).optional(),
    pollIntervalMs: z.number().int().positive().optional(),
  })
  .partial();

// -- Phase 2: email / sender / webhooks / routing -----------------------------

const ImapConfigZ = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  secure: z.boolean(),
  user: z.string().min(1),
  pass: z.string(),
});

const EmailConfigFileZ = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none"), pollIntervalMs: z.number().int().positive().optional() }),
  z.object({
    kind: z.literal("maildir"),
    root: z.string().min(1),
    address: z.string().min(1),
    displayName: z.string().optional(),
    pollIntervalMs: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("imap-smtp"),
    address: z.string().min(1),
    displayName: z.string().optional(),
    imap: ImapConfigZ,
    smtp: ImapConfigZ,
    mailbox: z.string().optional(),
    /** Append a copy of every sent message here; omit/null = don't (e.g. Gmail saves SMTP sends itself). */
    sentFolder: z.string().nullable().optional(),
    /** Opt-in: also read the Sent folder, so the harness learns what humans answered from their own mail client. */
    syncSent: z.boolean().optional(),
    /** First sync: 0 (default) = only mail arriving after the first connection; N = also the last N days. */
    initialSyncDays: z.number().int().min(0).max(90).optional(),
    /** Cap on existing mail a first sync / UIDVALIDITY resync may pull in (default 200). */
    initialSyncMaxMessages: z.number().int().min(1).max(5000).optional(),
    pollIntervalMs: z.number().int().positive().optional(),
  }),
]);

const SenderConfigZ = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  companyAddressLine: z.string().min(1),
});

const RoutingConfigZ = z
  .object({
    replyKind: z.string().min(1),
    newLeadKind: z.string().min(1),
    followUpKind: z.string().min(1),
  })
  .partial();

const WebhookConfigZ = z.record(z.string(), z.object({ secret: z.string().min(1) }));

const ConfigFileZ = z
  .object({
    dataDir: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().positive(),
    adminToken: z.string().min(1),
    companyName: z.string().min(1),
    templatesRoot: z.string().min(1),
    kbRoot: z.string().min(1),
    agyBin: z.string().min(1),
    nodeBin: z.string().min(1),
    hooksDistDir: z.string().min(1),
    mcpEntry: z.string().min(1),
    workerConcurrency: z.number().int().positive(),
    pollIntervalMs: z.number().int().positive(),
    runTimeoutMs: z.number().int().positive(),
    quota: QuotaConfigZ,
    outboxDailyLimit: z.number().int().positive(),
    email: EmailConfigFileZ,
    sender: SenderConfigZ,
    unsubscribeMailto: z.string().min(1),
    webhooks: WebhookConfigZ,
    routing: RoutingConfigZ,
    uiDist: z.string().min(1),
    setupModel: z.string().min(1),
  })
  .partial();

export type ConfigFile = z.infer<typeof ConfigFileZ>;

/** `config.email`: an EmailProviderConfig plus the poll interval for the inbound poller. */
export type EmailConfig = EmailProviderConfig & { pollIntervalMs: number };

export interface SenderConfig {
  name: string;
  address: string;
  /** Physical address / identity line required by CAN-SPAM-style disclosure footers. */
  companyAddressLine: string;
}

export interface RoutingConfig {
  replyKind: string;
  newLeadKind: string;
  followUpKind: string;
}

export interface AgyhqConfig {
  /** Absolute. Everything the daemon writes (db, workspaces, admin-token) lives under here. */
  dataDir: string;
  /** Absolute. `<dataDir>/agyhq.db`. */
  dbPath: string;
  /** Absolute. `<dataDir>/workspaces` — one subdirectory per agent id. */
  workspacesRoot: string;
  host: string;
  port: number;
  adminToken: string;
  companyName: string;
  /** Absolute. */
  templatesRoot: string;
  /** Absolute. Company-wide KB markdown root. */
  kbRoot: string;
  agyBin: string;
  nodeBin: string;
  /** Absolute. Built @agyhq/hooks dist directory. */
  hooksDistDir: string;
  /** Absolute. Built @agyhq/mcp company-mcp.mjs entrypoint. */
  mcpEntry: string;
  workerConcurrency: number;
  pollIntervalMs: number;
  runTimeoutMs: number;
  quota: { minRemainingFraction: number; pollIntervalMs: number };
  outboxDailyLimit: number;
  /** Where this config was loaded from, if anywhere (for diagnostics / `hq` CLI). */
  configPath: string | null;

  // -- Phase 2 -----------------------------------------------------------
  email: EmailConfig;
  sender: SenderConfig;
  /** e.g. "unsubscribe@acme.com" — used to build the List-Unsubscribe mailto link and footer text. */
  unsubscribeMailto: string;
  /** Per-webhook-source shared secret, checked via `x-agyhq-webhook-secret` on POST /v1/inbound/webhook/:source. */
  webhooks: Record<string, { secret: string }>;
  routing: RoutingConfig;
  /** Absolute. Built agy-ui static assets, served at "/" with SPA fallback when the dir exists. */
  uiDist: string;
  /** Model the setup wizard's company researcher uses (default: the sales-sdr template's defaultModel). */
  setupModel?: string;
}

const DEFAULTS = {
  dataDir: "./data",
  host: "127.0.0.1",
  port: 7317,
  companyName: "Your Company",
  workerConcurrency: 3,
  pollIntervalMs: 1000,
  runTimeoutMs: 600_000,
  quota: { minRemainingFraction: 0.15, pollIntervalMs: 300_000 },
  outboxDailyLimit: 50,
  emailPollIntervalMs: 60_000,
  unsubscribeMailto: "",
  routing: { replyKind: "sdr.handle_reply", newLeadKind: "sdr.research_lead", followUpKind: "sdr.follow_up" },
} as const;

export interface LoadConfigOptions {
  /** Explicit --config path; else AGYHQ_CONFIG env; else <repoRoot>/agyhq.config.json if present. */
  configPath?: string;
  /** For tests: override cwd used for repo-root discovery / relative path resolution. */
  cwd?: string;
  /** For tests: override process.env. */
  env?: NodeJS.ProcessEnv;
}

function resolveConfigPath(opts: LoadConfigOptions, env: NodeJS.ProcessEnv, repoRoot: string): string | null {
  const explicit = opts.configPath ?? env.AGYHQ_CONFIG;
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.resolve(repoRoot, explicit);
  const defaultPath = path.join(repoRoot, "agyhq.config.json");
  return fs.existsSync(defaultPath) ? defaultPath : null;
}

function readConfigFile(configPath: string): ConfigFile {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(`agyhq.config.json at ${configPath} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = ConfigFileZ.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`agyhq.config.json at ${configPath} failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Generate (if absent) and persist the admin token to `<dataDir>/admin-token`, mode 600. Returns the token. */
function ensureAdminTokenFile(dataDir: string): string {
  const tokenPath = path.join(dataDir, "admin-token");
  if (fs.existsSync(tokenPath)) {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  }
  const token = randomBytes(32).toString("base64url");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    // best-effort on platforms where chmod semantics differ
  }
  return token;
}

/** Load, validate and resolve the full daemon config. Never throws for a missing optional config file. */
export function loadConfig(opts: LoadConfigOptions = {}): AgyhqConfig {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = findRepoRoot(cwd);

  const configPath = resolveConfigPath(opts, env, repoRoot);
  const file = configPath ? readConfigFile(configPath) : {};

  const dataDirRaw = file.dataDir ?? env.AGYHQ_DATA_DIR ?? DEFAULTS.dataDir;
  const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.resolve(repoRoot, dataDirRaw);

  const host = env.AGYHQ_HOST ?? file.host ?? DEFAULTS.host;
  const port = Number(env.AGYHQ_PORT ?? file.port ?? DEFAULTS.port);
  const companyName = env.AGYHQ_COMPANY_NAME ?? file.companyName ?? DEFAULTS.companyName;

  const templatesRootRaw = file.templatesRoot ?? path.join(repoRoot, "templates");
  const templatesRoot = path.isAbsolute(templatesRootRaw) ? templatesRootRaw : path.resolve(repoRoot, templatesRootRaw);

  const kbRootRaw = file.kbRoot ?? path.join(repoRoot, "kb");
  const kbRoot = path.isAbsolute(kbRootRaw) ? kbRootRaw : path.resolve(repoRoot, kbRootRaw);

  const agyBin = env.AGY_BIN ?? file.agyBin ?? "agy";
  const nodeBin = file.nodeBin ?? process.execPath;

  const hooksDistDirRaw = file.hooksDistDir ?? path.join(repoRoot, "packages/hooks/dist");
  const hooksDistDir = path.isAbsolute(hooksDistDirRaw) ? hooksDistDirRaw : path.resolve(repoRoot, hooksDistDirRaw);

  const mcpEntryRaw = file.mcpEntry ?? path.join(repoRoot, "packages/mcp/dist/company-mcp.mjs");
  const mcpEntry = path.isAbsolute(mcpEntryRaw) ? mcpEntryRaw : path.resolve(repoRoot, mcpEntryRaw);

  const workerConcurrency = file.workerConcurrency ?? DEFAULTS.workerConcurrency;
  const pollIntervalMs = file.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
  const runTimeoutMs = file.runTimeoutMs ?? DEFAULTS.runTimeoutMs;
  const quota = {
    minRemainingFraction: file.quota?.minRemainingFraction ?? DEFAULTS.quota.minRemainingFraction,
    pollIntervalMs: file.quota?.pollIntervalMs ?? DEFAULTS.quota.pollIntervalMs,
  };
  const outboxDailyLimit = file.outboxDailyLimit ?? DEFAULTS.outboxDailyLimit;

  const adminToken = env.AGYHQ_ADMIN_TOKEN ?? file.adminToken ?? ensureAdminTokenFile(dataDir);

  // -- Phase 2 -------------------------------------------------------------

  const emailFile = file.email ?? { kind: "none" as const };
  const emailPollIntervalMs = emailFile.pollIntervalMs ?? DEFAULTS.emailPollIntervalMs;
  let email: EmailConfig;
  if (emailFile.kind === "imap-smtp") {
    email = {
      ...emailFile,
      imap: { ...emailFile.imap, pass: env.AGYHQ_IMAP_PASS ?? emailFile.imap.pass },
      smtp: { ...emailFile.smtp, pass: env.AGYHQ_SMTP_PASS ?? emailFile.smtp.pass },
      pollIntervalMs: emailPollIntervalMs,
    };
  } else {
    email = { ...emailFile, pollIntervalMs: emailPollIntervalMs } as EmailConfig;
  }

  const sender: SenderConfig = {
    name: file.sender?.name ?? companyName,
    address: file.sender?.address ?? "",
    companyAddressLine: file.sender?.companyAddressLine ?? "",
  };

  const unsubscribeMailto = file.unsubscribeMailto ?? DEFAULTS.unsubscribeMailto;
  const webhooks = file.webhooks ?? {};
  const routing: RoutingConfig = { ...DEFAULTS.routing, ...file.routing };

  const uiDistRaw = file.uiDist ?? path.join(repoRoot, "packages/ui/dist");
  const uiDist = path.isAbsolute(uiDistRaw) ? uiDistRaw : path.resolve(repoRoot, uiDistRaw);

  return {
    dataDir,
    dbPath: path.join(dataDir, "agyhq.db"),
    workspacesRoot: path.join(dataDir, "workspaces"),
    host,
    port,
    adminToken,
    companyName,
    templatesRoot,
    kbRoot,
    agyBin,
    nodeBin,
    hooksDistDir,
    mcpEntry,
    workerConcurrency,
    pollIntervalMs,
    runTimeoutMs,
    quota,
    outboxDailyLimit,
    configPath,
    email,
    sender,
    unsubscribeMailto,
    webhooks,
    routing,
    uiDist,
    setupModel: env.AGYHQ_SETUP_MODEL ?? file.setupModel,
  };
}

/**
 * Fail fast with a clear message if the build artifacts the workspace
 * renderer embeds absolute paths to (hooks dist, mcp entry) don't exist yet.
 * Call this once at daemon startup, after loadConfig(), before anything
 * provisions or renders a workspace.
 */
export function assertBuildArtifacts(config: AgyhqConfig): void {
  const missing: string[] = [];
  if (!fs.existsSync(config.hooksDistDir)) missing.push(`hooksDistDir (${config.hooksDistDir})`);
  if (!fs.existsSync(config.mcpEntry)) missing.push(`mcpEntry (${config.mcpEntry})`);
  if (missing.length > 0) {
    throw new Error(
      `agy-hq build artifacts missing: ${missing.join(", ")}. Run "npm run build" from the repo root first.`,
    );
  }
}
