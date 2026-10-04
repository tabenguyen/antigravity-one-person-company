// The Facebook config shape the daemon loads, and the factory that turns it into a live FacebookPageProvider (same
// role as config.ts for email). The access token is never part of the config file: the file names an env var
// (`tokenEnv`) and the factory reads it from the environment.

import type { FacebookPageProvider } from "@agyhq/core";

import { FacebookError } from "./facebook-errors.ts";
import { FACEBOOK_APP_SECRET_ENV } from "./facebook-signature.ts";
import { GraphApiFacebookProvider } from "./providers/facebook-graph.ts";
import { FakeFacebookProvider } from "./providers/facebook-fake.ts";

export type FacebookProviderConfig =
  | {
      kind: "graph";
      pageId: string;
      /** The Meta app's id. Not a secret, so it lives in the config file (shown by `hq facebook doctor`). */
      appId?: string;
      /** Graph API version, e.g. "v26.0". */
      apiVersion: string;
      /** Name of the env var holding the System User / Page access token. @default "AGYHQ_FB_PAGE_TOKEN" */
      tokenEnv?: string;
      /** Tests only: a token given directly (the config file loader never sets it). */
      accessToken?: string;
      /** Tests only: an app secret given directly; otherwise it comes from env AGYHQ_FB_APP_SECRET (optional). */
      appSecret?: string;
      /** Declared app mode (the Graph API does not expose it). */
      appMode?: "development" | "live";
      baseUrl?: string;
      timeoutMs?: number;
    }
  | { kind: "fake"; pageId?: string; pageName?: string }
  | { kind: "none" };

export const DEFAULT_FACEBOOK_TOKEN_ENV = "AGYHQ_FB_PAGE_TOKEN";

export interface FacebookProviderDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => Date;
}

export function createFacebookProvider(cfg: FacebookProviderConfig, deps: FacebookProviderDeps = {}): FacebookPageProvider | null {
  switch (cfg.kind) {
    case "graph": {
      const tokenEnv = cfg.tokenEnv ?? DEFAULT_FACEBOOK_TOKEN_ENV;
      const accessToken = cfg.accessToken ?? (deps.env ?? process.env)[tokenEnv] ?? "";
      if (!accessToken) throw new FacebookError(`facebook: environment variable ${tokenEnv} is not set (it must hold the access token)`, { code: "auth" });
      return new GraphApiFacebookProvider({
        pageId: cfg.pageId,
        apiVersion: cfg.apiVersion,
        accessToken,
        appMode: cfg.appMode,
        appSecret: cfg.appSecret ?? (deps.env ?? process.env)[FACEBOOK_APP_SECRET_ENV] ?? undefined,
        appId: cfg.appId,
        baseUrl: cfg.baseUrl,
        timeoutMs: cfg.timeoutMs,
        fetch: deps.fetch,
        now: deps.now,
      });
    }
    case "fake":
      return new FakeFacebookProvider({ pageId: cfg.pageId, pageName: cfg.pageName, now: deps.now });
    case "none":
      return null;
    default: {
      const exhaustive: never = cfg;
      throw new Error(`channels: unknown facebook provider kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
