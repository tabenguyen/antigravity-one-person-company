// FacebookRuntime: owns the live Facebook provider and the poller / sender built on it. The provider is built once from
// `config.facebook` (the token comes from the env var the config names). If it cannot be built (token env var missing)
// the daemon still starts: `configError` says why and nothing polls or sends.

import { createFacebookProvider } from "@agyhq/channels";
import type { FacebookPageProvider } from "@agyhq/core";
import type { Db } from "@agyhq/db";
import type { AgyhqConfig, FacebookConfig } from "../config.ts";
import type { EventBus } from "../event-bus.ts";
import { FacebookPoller } from "./poller.ts";
import { FacebookSender } from "./sender.ts";

/** Build the provider the config describes; a failure (typically: the token env var is not set) comes back as `error`, not as a throw. */
export function tryCreateProvider(cfg: FacebookConfig, env?: NodeJS.ProcessEnv): { provider: FacebookPageProvider | null; error: string | null } {
  try {
    return { provider: createFacebookProvider(cfg, { env }), error: null };
  } catch (err) {
    return { provider: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface FacebookRuntimeOptions {
  config: AgyhqConfig;
  db: Db;
  bus: EventBus;
  /** Tests: use this provider instead of building one from config. */
  provider?: FacebookPageProvider | null;
  env?: NodeJS.ProcessEnv;
}

export interface FacebookStatus {
  kind: FacebookConfig["kind"];
  /** A provider is live: polling and sending are possible. */
  configured: boolean;
  /** Why it is not (e.g. the token env var is not set). */
  configError: string | null;
  pageId: string | null;
  lastPollAt: string | null;
  lastPollError: string | null;
  lastSendAt: string | null;
  pollIntervalMs: number;
  scheduleLeadHours: number;
}

export class FacebookRuntime {
  readonly poller: FacebookPoller;
  readonly sender: FacebookSender;
  readonly #config: AgyhqConfig;
  #provider: FacebookPageProvider | null;
  #configError: string | null = null;

  constructor(opts: FacebookRuntimeOptions) {
    this.#config = opts.config;
    if (opts.provider !== undefined) {
      this.#provider = opts.provider;
    } else {
      const built = tryCreateProvider(opts.config.facebook, opts.env);
      this.#provider = built.provider;
      this.#configError = built.error;
    }
    this.poller = new FacebookPoller({ db: opts.db, bus: opts.bus, config: opts.config }, () => this.#provider);
    this.sender = new FacebookSender({ config: opts.config, db: opts.db, bus: opts.bus, provider: () => this.#provider });
  }

  get provider(): FacebookPageProvider | null {
    return this.#provider;
  }

  get configError(): string | null {
    return this.#configError;
  }

  /** The Page id: the live provider's, else the config's (so drafts have a target even when the channel is not live). */
  get pageId(): string | null {
    if (this.#provider) return this.#provider.pageId;
    const c = this.#config.facebook;
    return c.kind === "graph" ? c.pageId : c.kind === "fake" ? (c.pageId ?? "page-1") : null;
  }

  start(): void {
    if (!this.#provider) return;
    this.poller.start();
    this.sender.start();
  }

  async stop(): Promise<void> {
    await this.poller.stopAndDrain();
    this.sender.stop();
    const p = this.#provider;
    this.#provider = null;
    await p?.close().catch(() => {});
  }

  status(): FacebookStatus {
    const c = this.#config.facebook;
    return {
      kind: c.kind,
      configured: this.#provider !== null,
      configError: this.#configError,
      pageId: this.pageId,
      lastPollAt: this.poller.lastPollAt,
      lastPollError: this.poller.lastError,
      lastSendAt: this.sender.lastSendAt,
      pollIntervalMs: c.pollIntervalMs,
      scheduleLeadHours: c.scheduleLeadHours,
    };
  }
}
