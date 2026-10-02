// Email connection settings editable at runtime (setup wizard).
//
// Persistence: kv "email_settings". Passwords are stored encrypted (SecretBox, AES-256-GCM) and are never returned by
// any API — the view only says whether one exists. Effective config precedence, highest first:
//   1. env AGYHQ_IMAP_PASS / AGYHQ_SMTP_PASS (passwords only)
//   2. the UI-saved settings (kv)
//   3. the config file's `email` block
// "kind: none" saved from the UI is an explicit choice (it overrides a config file that has a mailbox).

import type { Db } from "@agyhq/db";
import { EmailSettingsInputZ, type EmailSettingsInput, type EmailSettingsView } from "../admin-types.ts";
import type { EmailConfig } from "../config.ts";
import type { SecretBox } from "./secrets.ts";

export const EMAIL_SETTINGS_KEY = "email_settings";
const AAD_IMAP = "email_settings.imap.pass";
const AAD_SMTP = "email_settings.smtp.pass";

export interface StoredMailServer {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** SecretBox token, or null when no password has been stored. */
  passEnc: string | null;
}

export type StoredEmailSettings =
  | { kind: "none"; updatedAt: string }
  | {
      kind: "imap-smtp";
      address: string;
      displayName: string | null;
      imap: StoredMailServer;
      smtp: StoredMailServer;
      mailbox: string;
      sentFolder: string | null;
      pollIntervalMs: number;
      updatedAt: string;
    }
  | { kind: "maildir"; address: string; displayName: string | null; root: string; pollIntervalMs: number; updatedAt: string };

export function loadStoredEmail(db: Db): StoredEmailSettings | null {
  const raw = db.kv.get<StoredEmailSettings>(EMAIL_SETTINGS_KEY);
  if (!raw || typeof raw !== "object" || !("kind" in raw)) return null;
  return raw;
}

export function saveStoredEmail(db: Db, stored: StoredEmailSettings): void {
  db.kv.set(EMAIL_SETTINGS_KEY, stored);
}

export interface PasswordEnv {
  imap: string | null;
  smtp: string | null;
}

export function passwordEnv(env: NodeJS.ProcessEnv = process.env): PasswordEnv {
  return { imap: env.AGYHQ_IMAP_PASS || null, smtp: env.AGYHQ_SMTP_PASS || null };
}

/** Trim string fields so " " padding never defeats validation; empty optional strings mean "unset". */
export function normalizeEmailInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const trimServer = (s: unknown) => {
    if (!s || typeof s !== "object") return s;
    const o = { ...(s as Record<string, unknown>) };
    for (const k of ["host", "user"]) if (typeof o[k] === "string") o[k] = (o[k] as string).trim();
    // passwords are NOT trimmed (they may legitimately contain edge spaces); empty string means "keep stored"
    if (o["pass"] === "") delete o["pass"];
    return o;
  };
  const o = { ...(raw as Record<string, unknown>) };
  for (const k of ["address", "displayName", "mailbox", "root"]) if (typeof o[k] === "string") o[k] = (o[k] as string).trim();
  if (o["displayName"] === "") delete o["displayName"];
  if (o["mailbox"] === "") delete o["mailbox"];
  if (typeof o["sentFolder"] === "string") o["sentFolder"] = (o["sentFolder"] as string).trim() || null;
  if ("imap" in o) o["imap"] = trimServer(o["imap"]);
  if ("smtp" in o) o["smtp"] = trimServer(o["smtp"]);
  return o;
}

export type ParsedEmailInput = ReturnType<typeof EmailSettingsInputZ.parse>;

export function parseEmailInput(raw: unknown): { ok: true; data: ParsedEmailInput } | { ok: false; message: string } {
  const parsed = EmailSettingsInputZ.safeParse(normalizeEmailInput(raw));
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
}

/** Passwords the user did not retype fall back to the stored ones. Returns null if none exists for a side. */
function mergeServer(
  given: { host: string; port: number; secure: boolean; user: string; pass?: string },
  prev: StoredMailServer | null,
  box: SecretBox,
  aad: string,
): StoredMailServer {
  const passEnc = given.pass ? box.encrypt(given.pass, aad) : (prev?.passEnc ?? null);
  return { host: given.host, port: given.port, secure: given.secure, user: given.user, passEnc };
}

/** Input -> what gets persisted (encrypting any newly supplied password, keeping the stored one otherwise). */
export function buildStored(input: ParsedEmailInput, prev: StoredEmailSettings | null, box: SecretBox, fallbackPollMs: number): StoredEmailSettings {
  const updatedAt = new Date().toISOString();
  if (input.kind === "none") return { kind: "none", updatedAt };
  if (input.kind === "maildir") {
    return { kind: "maildir", address: input.address, displayName: input.displayName ?? null, root: input.root, pollIntervalMs: fallbackPollMs, updatedAt };
  }
  const prevImap = prev?.kind === "imap-smtp" ? prev : null;
  return {
    kind: "imap-smtp",
    address: input.address,
    displayName: input.displayName ?? null,
    imap: mergeServer(input.imap, prevImap?.imap ?? null, box, AAD_IMAP),
    smtp: mergeServer(input.smtp, prevImap?.smtp ?? null, box, AAD_SMTP),
    mailbox: input.mailbox,
    sentFolder: input.sentFolder,
    pollIntervalMs: input.pollIntervalMs,
    updatedAt,
  };
}

/** Stored settings -> the config shape EmailProvider/EmailPoller consume. Env passwords win. */
export function storedToConfig(stored: StoredEmailSettings, fileEmail: EmailConfig, box: SecretBox, env: PasswordEnv): EmailConfig {
  if (stored.kind === "none") return { kind: "none", pollIntervalMs: fileEmail.pollIntervalMs };
  if (stored.kind === "maildir") {
    return { kind: "maildir", root: stored.root, address: stored.address, displayName: stored.displayName ?? undefined, pollIntervalMs: stored.pollIntervalMs };
  }
  return {
    kind: "imap-smtp",
    address: stored.address,
    displayName: stored.displayName ?? undefined,
    imap: { host: stored.imap.host, port: stored.imap.port, secure: stored.imap.secure, user: stored.imap.user, pass: env.imap ?? box.tryDecrypt(stored.imap.passEnc, AAD_IMAP) ?? "" },
    smtp: { host: stored.smtp.host, port: stored.smtp.port, secure: stored.smtp.secure, user: stored.smtp.user, pass: env.smtp ?? box.tryDecrypt(stored.smtp.passEnc, AAD_SMTP) ?? "" },
    mailbox: stored.mailbox,
    sentFolder: stored.sentFolder,
    pollIntervalMs: stored.pollIntervalMs,
  };
}

export interface ResolvedEmail {
  config: EmailConfig;
  source: "ui" | "config";
  stored: StoredEmailSettings | null;
}

/** UI settings if saved, else the config-file email (whose passwords loadConfig already env-overrode). */
export function resolveEmail(fileEmail: EmailConfig, db: Db, box: SecretBox, env: PasswordEnv): ResolvedEmail {
  const stored = loadStoredEmail(db);
  if (!stored) return { config: fileEmail, source: "config", stored: null };
  return { config: storedToConfig(stored, fileEmail, box, env), source: "ui", stored };
}

/** The (unsaved) input -> a config to test: omitted passwords fall back to the stored ones, env still wins. */
export function inputToTestConfig(input: ParsedEmailInput, stored: StoredEmailSettings | null, fileEmail: EmailConfig, box: SecretBox, env: PasswordEnv): EmailConfig {
  const asStored = buildStored(input, stored, box, fileEmail.pollIntervalMs);
  return storedToConfig(asStored, fileEmail, box, env);
}

/**
 * Identity of the mailbox being polled. If it changes, the poll cursor (an IMAP uidvalidity:uid / maildir filename of
 * the OLD mailbox) means nothing and is reset; a password/SMTP/poll-interval change keeps the same identity and cursor.
 */
export function mailboxIdentity(cfg: EmailConfig): string {
  if (cfg.kind === "none") return "none";
  if (cfg.kind === "maildir") return `maildir|${(cfg.address ?? "").toLowerCase()}|${cfg.root ?? ""}`;
  return `imap|${(cfg.address ?? "").toLowerCase()}|${(cfg.imap?.host ?? "").toLowerCase()}:${cfg.imap?.port ?? ""}|${(cfg.imap?.user ?? "").toLowerCase()}|${cfg.mailbox ?? "INBOX"}`;
}

export function buildView(resolved: ResolvedEmail, env: PasswordEnv): EmailSettingsView {
  const { config, source } = resolved;
  const passwordFromEnv = { imap: Boolean(env.imap), smtp: Boolean(env.smtp) };
  const base: EmailSettingsView = {
    kind: config.kind,
    address: null,
    displayName: null,
    imap: null,
    smtp: null,
    mailbox: null,
    sentFolder: null,
    pollIntervalMs: null,
    root: null,
    source,
    passwordFromEnv,
  };
  if (config.kind === "none") return base;
  if (config.kind === "maildir") {
    return { ...base, address: config.address, displayName: config.displayName ?? null, root: config.root, pollIntervalMs: config.pollIntervalMs };
  }
  // hasPassword reads the stored token (not the decrypted value) so a lost key shows "no password" via config.pass === "".
  const server = (s: { host: string; port: number; secure: boolean; user: string; pass: string }) => ({
    host: s.host,
    port: s.port,
    secure: s.secure,
    user: s.user,
    hasPassword: s.pass.length > 0,
  });
  return {
    ...base,
    address: config.address,
    displayName: config.displayName ?? null,
    imap: server(config.imap),
    smtp: server(config.smtp),
    mailbox: config.mailbox ?? "INBOX",
    sentFolder: config.sentFolder ?? null,
    pollIntervalMs: config.pollIntervalMs,
  };
}

export type { EmailSettingsInput };
