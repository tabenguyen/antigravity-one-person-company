// EmailRuntime: owns the live email provider and the inbound poller so the mailbox can be changed from the setup
// wizard without restarting the daemon.
//
// Everyone that needs the provider (Sender, EmailPoller, admin status, readiness verifier/monitor) reads it through
// `runtime.provider` / a getter, never a captured reference. `apply(cfg)` swaps atomically from their point of view:
//   1. build the NEW provider first (if that throws nothing has changed),
//   2. bump the generation (an in-flight poll of the old provider discards its results and never writes the cursor),
//   3. reset the poll cursor iff the mailbox identity changed (see mailboxIdentity()),
//   4. close the old provider, mirror the effective config into `config.email`, restart the poller.
//
// Cursor semantics: same mailbox (address/host/user/mailbox/root) => keep the cursor, so nothing is skipped or
// re-ingested (a password or SMTP change is invisible to inbound). Different mailbox => cursor reset to null, which
// every provider treats as "only mail that arrives from now on" — we never backfill a mailbox's history, and mail that
// arrived in the new mailbox before the swap is not processed (documented in the README). Message-ID dedupe makes a
// duplicate impossible either way.

import { createEmailProvider } from "@agyhq/channels";
import type { EmailProvider } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import type { AgyhqConfig, EmailConfig } from "../config.ts";
import type { EventBus } from "../event-bus.ts";
import { EMAIL_INBOX_CURSOR_KEY, EMAIL_SENT_CURSOR_KEY, EmailPoller } from "../inbound.ts";
import { mailboxIdentity, passwordEnv, resolveEmail, type PasswordEnv } from "./email-settings.ts";
import type { SecretBox } from "./secrets.ts";

export const EMAIL_CURSOR_KEY = EMAIL_INBOX_CURSOR_KEY;
const IDENTITY_KV = "email_cursor_identity";

export interface EmailRuntimeOptions {
  config: AgyhqConfig;
  db: Db;
  bus: EventBus;
  box: SecretBox;
  /** Initial provider (tests); default: built from the effective config. */
  provider?: EmailProvider | null;
  /** Test seam: how a provider is built from a config. */
  createProvider?: (cfg: EmailConfig) => EmailProvider | null;
  env?: NodeJS.ProcessEnv;
}

export class EmailRuntime {
  readonly #config: AgyhqConfig;
  readonly #db: Db;
  readonly #bus: EventBus;
  readonly #box: SecretBox;
  readonly #create: (cfg: EmailConfig) => EmailProvider | null;
  readonly #env: NodeJS.ProcessEnv;
  /** The config file's email block (passwords already env-overridden by loadConfig), captured before any swap. */
  readonly #fileEmail: EmailConfig;
  readonly poller: EmailPoller;

  #provider: EmailProvider | null;
  #current: EmailConfig;
  #source: "ui" | "config";
  #generation = 0;
  #started = false;

  constructor(opts: EmailRuntimeOptions) {
    this.#config = opts.config;
    this.#db = opts.db;
    this.#bus = opts.bus;
    this.#box = opts.box;
    this.#env = opts.env ?? process.env;
    this.#create = opts.createProvider ?? ((cfg) => createEmailProvider(cfg));
    this.#fileEmail = opts.config.email;

    const resolved = resolveEmail(this.#fileEmail, this.#db, this.#box, passwordEnv(this.#env));
    this.#current = resolved.config;
    this.#source = resolved.source;
    this.#provider = opts.provider !== undefined ? opts.provider : this.#create(resolved.config);
    this.#config.email = resolved.config;
    this.#syncCursorIdentity(resolved.config);

    this.poller = new EmailPoller(
      { db: this.#db, bus: this.#bus, config: this.#config },
      { provider: () => this.#provider, intervalMs: () => this.#current.pollIntervalMs, generation: () => this.#generation },
    );
  }

  get provider(): EmailProvider | null {
    return this.#provider;
  }

  /** The effective config (UI settings, else config file) with env password overrides applied. */
  get current(): EmailConfig {
    return this.#current;
  }

  get source(): "ui" | "config" {
    return this.#source;
  }

  get passwordEnv(): PasswordEnv {
    return passwordEnv(this.#env);
  }

  get fileEmail(): EmailConfig {
    return this.#fileEmail;
  }

  get box(): SecretBox {
    return this.#box;
  }

  start(): void {
    this.#started = true;
    this.poller.start();
  }

  /** Stops polling and closes the provider (daemon shutdown). */
  async stop(): Promise<void> {
    this.#started = false;
    this.#generation++;
    await this.poller.stopAndDrain();
    const old = this.#provider;
    this.#provider = null;
    await old?.close().catch(() => {});
  }

  /**
   * Switch to `cfg` (call this BEFORE persisting the settings so a provider that cannot be built is rejected with the
   * old setup still running). `source` is where the settings now come from.
   */
  async apply(cfg: EmailConfig, source: "ui" | "config" = "ui"): Promise<void> {
    const next = this.#create(cfg); // may throw: nothing has changed yet
    const old = this.#provider;
    this.#generation++;
    this.#syncCursorIdentity(cfg);
    this.#provider = next;
    this.#current = cfg;
    this.#source = source;
    this.#config.email = cfg;
    if (old && old !== next) await old.close().catch(() => {});
    if (this.#started) this.poller.restart();
    this.#bus.emit("status.changed", { email: cfg.kind });
  }

  /** Re-resolve from the DB (UI settings, else config file) and apply — used after the stored settings changed. */
  async reload(): Promise<void> {
    const resolved = resolveEmail(this.#fileEmail, this.#db, this.#box, passwordEnv(this.#env));
    await this.apply(resolved.config, resolved.source);
  }

  #syncCursorIdentity(cfg: EmailConfig): void {
    const identity = mailboxIdentity(cfg);
    const prev = this.#db.kv.get<{ identity: string }>(IDENTITY_KV)?.identity ?? null;
    if (prev !== null && prev !== identity) {
      this.#db.channelCursors.set(EMAIL_CURSOR_KEY, null);
      this.#db.channelCursors.set(EMAIL_SENT_CURSOR_KEY, null);
    }
    if (prev !== identity) this.#db.kv.set(IDENTITY_KV, { identity });
  }
}
