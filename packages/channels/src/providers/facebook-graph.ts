// FacebookPageProvider over the Graph API (docs/FANPAGE.md section 3). Plain `fetch`, no SDK.
//
// The token goes in the `Authorization: Bearer` header and nowhere else: never in the query string (URLs end up in
// logs, proxies and error messages) and never in a request body. Every error message is scrubbed of it. The Graph API
// version comes from config. Nothing here is ever called by the test suite except through an injected `fetch`.

import type {
  FacebookPageProvider,
  FbComment,
  FbFetchResult,
  FbInspection,
  FbPageIdentity,
  FbPost,
  FbPostResult,
  FbReplyResult,
  OutgoingFbPost,
  OutgoingFbReply,
} from "@agyhq/core";

import { FacebookError, classifyGraphError, describeFacebookError } from "../facebook-errors.ts";
import { validateScheduleWindow } from "../facebook-schedule.ts";
import { appSecretProof } from "../facebook-signature.ts";

export interface GraphApiProviderOptions {
  pageId: string;
  accessToken: string;
  /** e.g. "v26.0". Comes from config; there is no built-in default so a version bump is a conscious edit. */
  apiVersion: string;
  /** @default "https://graph.facebook.com" */
  baseUrl?: string;
  /** Injectable for tests. @default globalThis.fetch */
  fetch?: typeof fetch;
  now?: () => Date;
  /** Per-request timeout. @default 20000 */
  timeoutMs?: number;
  /** Max pages of the Page feed followed per fetchNew. @default 4 */
  maxFeedPages?: number;
  /** Declared in config: the Graph API does not expose the app mode (docs/FANPAGE.md "Pending spike"). */
  appMode?: "development" | "live";
  /** The app secret (env AGYHQ_FB_APP_SECRET), optional. When set, every call carries `appsecret_proof`. Never logged or echoed. */
  appSecret?: string;
  /** The Meta app's id (not a secret). With `appSecret` it lets `inspect()` read the token's scopes via /debug_token. */
  appId?: string;
}

type Json = Record<string, unknown>;

const POST_FIELDS = "id,message,created_time,permalink_url,is_published,scheduled_publish_time";
const COMMENT_FIELDS = "id,message,created_time,from{id,name},parent{id},permalink_url,is_hidden";
// reverse_chronological: if a post has more than `limit` comments the newest are the ones we see.
const FEED_FIELDS = `${POST_FIELDS},comments.filter(stream).order(reverse_chronological).limit(100){${COMMENT_FIELDS}}`;

const ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Graph timestamps come as "2026-10-04T12:00:00+0000" (ISO-ish) or as unix seconds. */
function toIso(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v * 1000).toISOString();
  if (typeof v === "string" && v) {
    const t = new Date(v.replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
    return Number.isNaN(t.getTime()) ? null : t.toISOString();
  }
  return null;
}

export class GraphApiFacebookProvider implements FacebookPageProvider {
  readonly kind = "graph";
  readonly pageId: string;

  #token: string;
  #version: string;
  #base: string;
  #fetch: typeof fetch;
  #now: () => Date;
  #timeoutMs: number;
  #maxFeedPages: number;
  #appMode: "development" | "live" | "unknown";
  #appSecret: string | null;
  #appId: string | null;

  constructor(opts: GraphApiProviderOptions) {
    if (!opts.pageId) throw new FacebookError("facebook: pageId is required", { code: "invalid_request" });
    if (!opts.accessToken) throw new FacebookError("facebook: no access token (is the env var named by facebook.tokenEnv set?)", { code: "auth" });
    if (!opts.apiVersion) throw new FacebookError("facebook: apiVersion is required (e.g. v26.0)", { code: "invalid_request" });
    this.pageId = opts.pageId;
    this.#token = opts.accessToken;
    this.#version = opts.apiVersion.replace(/^\/+|\/+$/g, "");
    this.#base = (opts.baseUrl ?? "https://graph.facebook.com").replace(/\/+$/, "");
    this.#fetch = opts.fetch ?? globalThis.fetch;
    this.#now = opts.now ?? (() => new Date());
    this.#timeoutMs = opts.timeoutMs ?? 20_000;
    this.#maxFeedPages = opts.maxFeedPages ?? 4;
    this.#appMode = opts.appMode ?? "unknown";
    this.#appSecret = opts.appSecret ? opts.appSecret : null;
    this.#appId = opts.appId ? opts.appId : null;
  }

  /** True when every call is signed with `appsecret_proof`. */
  get sendsAppSecretProof(): boolean {
    return this.#appSecret !== null;
  }

  /** Secrets to scrub from any message that leaves this class. */
  #secrets(): string[] {
    return this.#appSecret ? [this.#token, this.#appSecret] : [this.#token];
  }

  // -------------------------------------------------------------------------
  // transport

  async #call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: { query?: Record<string, string>; form?: Record<string, string>; asApp?: boolean } = {},
  ): Promise<Json> {
    const url = new URL(`${this.#base}/${this.#version}/${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    // asApp: authenticate as the app ("{app-id}|{app-secret}", header only) for /debug_token; no proof, it already holds the secret.
    const bearer = opts.asApp && this.#appId && this.#appSecret ? `${this.#appId}|${this.#appSecret}` : this.#token;
    // The proof is an HMAC of the token, not the token: it may travel in the query string (the token itself never does).
    if (this.#appSecret && !opts.asApp) url.searchParams.set("appsecret_proof", appSecretProof(this.#token, this.#appSecret));
    const headers: Record<string, string> = { authorization: `Bearer ${bearer}`, accept: "application/json" };
    let body: string | undefined;
    if (opts.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(opts.form).toString();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      const reason = err instanceof Error ? (err.name === "AbortError" ? `timed out after ${this.#timeoutMs}ms` : err.message) : String(err);
      throw new FacebookError(describeFacebookError({ code: "network", message: `Graph API request failed: ${reason}` }, this.#secrets()), {
        code: "network",
        transient: true,
      });
    } finally {
      clearTimeout(timer);
    }
    let parsed: unknown = null;
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!res.ok || (parsed && typeof parsed === "object" && "error" in parsed)) throw classifyGraphError(res.status, parsed, this.#secrets());
    return (parsed && typeof parsed === "object" ? parsed : {}) as Json;
  }

  #id(value: string, what: string): string {
    if (!ID_RE.test(value)) throw new FacebookError(`facebook: invalid ${what} id`, { code: "invalid_request" });
    return encodeURIComponent(value);
  }

  // -------------------------------------------------------------------------
  // reading

  async fetchNew(cursor: string | null, opts: { limit?: number; lookbackDays?: number } = {}): Promise<FbFetchResult> {
    const now = this.#now();
    const lookbackDays = opts.lookbackDays ?? 14;
    const since = Math.floor((now.getTime() - lookbackDays * 86_400_000) / 1000);
    const posts: FbPost[] = [];
    const comments: FbComment[] = [];

    let after: string | null = null;
    for (let page = 0; page < this.#maxFeedPages; page++) {
      const query: Record<string, string> = { fields: FEED_FIELDS, since: String(since), limit: String(opts.limit ?? 25) };
      if (after) query["after"] = after;
      const body = await this.#call("GET", `${this.#id(this.pageId, "page")}/feed`, { query });
      for (const raw of (Array.isArray(body["data"]) ? body["data"] : []) as Json[]) {
        const post = this.#mapPost(raw);
        if (!post) continue;
        posts.push(post);
        const nested = raw["comments"] as { data?: Json[] } | undefined;
        for (const c of nested?.data ?? []) {
          const comment = this.#mapComment(c, post.id);
          if (comment) comments.push(comment);
        }
      }
      const paging = body["paging"] as { cursors?: { after?: string }; next?: string } | undefined;
      // Never follow paging.next verbatim: build the next request ourselves so the URL we call is always one we made.
      after = paging?.next && paging.cursors?.after ? paging.cursors.after : null;
      if (!after) break;
    }

    // First poll ever: remember "now" and replay nothing.
    if (cursor === null) return { posts: posts.filter((p) => p.isPublished), comments: [], cursor: now.toISOString() };

    const fresh = comments.filter((c) => c.createdTime >= cursor).sort((a, b) => a.createdTime.localeCompare(b.createdTime) || a.id.localeCompare(b.id));
    const newest = fresh.length > 0 ? fresh[fresh.length - 1]!.createdTime : cursor;
    return { posts: posts.filter((p) => p.isPublished), comments: fresh, cursor: newest > cursor ? newest : cursor };
  }

  #mapPost(raw: Json): FbPost | null {
    const id = str(raw["id"]);
    if (!id) return null;
    return {
      id,
      pageId: this.pageId,
      message: str(raw["message"]),
      permalinkUrl: str(raw["permalink_url"]),
      createdTime: toIso(raw["created_time"]) ?? this.#now().toISOString(),
      isPublished: raw["is_published"] !== false,
      scheduledPublishTime: toIso(raw["scheduled_publish_time"]),
    };
  }

  #mapComment(raw: Json, postId: string): FbComment | null {
    const id = str(raw["id"]);
    if (!id) return null;
    const from = raw["from"] as { id?: unknown; name?: unknown } | undefined;
    const parent = raw["parent"] as { id?: unknown } | undefined;
    const fromId = str(from?.id);
    return {
      id,
      postId,
      parentId: str(parent?.id),
      message: typeof raw["message"] === "string" ? raw["message"] : "",
      createdTime: toIso(raw["created_time"]) ?? this.#now().toISOString(),
      // `from` is optional by contract: Facebook may strip it (docs/FANPAGE-RESEARCH.md section 4, question 1).
      from: fromId ? { id: fromId, name: str(from?.name) } : null,
      permalinkUrl: str(raw["permalink_url"]),
      isHidden: raw["is_hidden"] === true,
    };
  }

  async listScheduledPosts(): Promise<FbPost[]> {
    const body = await this.#call("GET", `${this.#id(this.pageId, "page")}/scheduled_posts`, { query: { fields: POST_FIELDS, limit: "100" } });
    const posts: FbPost[] = [];
    for (const raw of (Array.isArray(body["data"]) ? body["data"] : []) as Json[]) {
      const post = this.#mapPost(raw);
      if (post) posts.push({ ...post, isPublished: false });
    }
    return posts.sort((a, b) => (a.scheduledPublishTime ?? "").localeCompare(b.scheduledPublishTime ?? ""));
  }

  // -------------------------------------------------------------------------
  // writing

  async createPost(post: OutgoingFbPost): Promise<FbPostResult> {
    const form: Record<string, string> = { message: post.message };
    if (post.link) form["link"] = post.link;
    let scheduledPublishTime: string | null = null;
    if (post.mode === "scheduled") {
      const at = validateScheduleWindow(post.scheduledPublishTime, this.#now()); // before any network call
      form["published"] = "false";
      form["scheduled_publish_time"] = String(Math.floor(at.getTime() / 1000));
      scheduledPublishTime = at.toISOString();
    } else if (post.mode === "preview") {
      form["published"] = "false"; // unpublished, no schedule: never shows in /feed, admins can open it
    } else {
      form["published"] = "true";
    }
    const body = await this.#call("POST", `${this.#id(this.pageId, "page")}/feed`, { form });
    const postId = str(body["id"]);
    if (!postId) throw new FacebookError("Graph API did not return a post id", { code: "api" });
    return { postId, mode: post.mode, scheduledPublishTime };
  }

  async cancelScheduledPost(postId: string): Promise<void> {
    const body = await this.#call("DELETE", this.#id(postId, "post"));
    if (body["success"] === false) throw new FacebookError("Graph API refused to delete the scheduled post", { code: "api" });
  }

  async replyToComment(reply: OutgoingFbReply): Promise<FbReplyResult> {
    const body = await this.#call("POST", `${this.#id(reply.commentId, "comment")}/comments`, { form: { message: reply.message } });
    const replyId = str(body["id"]);
    if (!replyId) throw new FacebookError("Graph API did not return a comment id for the reply", { code: "api" });
    return { replyId };
  }

  async hideComment(commentId: string): Promise<void> {
    const body = await this.#call("POST", this.#id(commentId, "comment"), { form: { is_hidden: "true" } });
    if (body["success"] === false) throw new FacebookError("Graph API did not hide the comment", { code: "api" });
  }

  // -------------------------------------------------------------------------
  // diagnostics

  async verify(): Promise<{ ok: true; page: FbPageIdentity } | { ok: false; error: string }> {
    try {
      const me = await this.#call("GET", "me", { query: { fields: "id,name" } });
      return { ok: true, page: { id: str(me["id"]) ?? this.pageId, name: str(me["name"]) } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async inspect(): Promise<FbInspection> {
    const notes: string[] = [];
    const out: FbInspection = { tokenValid: false, tokenError: null, page: null, granted: null, declined: [], appMode: this.#appMode, appSecretProof: this.sendsAppSecretProof, notes };

    let me: Json;
    try {
      me = await this.#call("GET", "me", { query: { fields: "id,name" } });
    } catch (err) {
      out.tokenError = err instanceof Error ? err.message : String(err);
      return out;
    }
    out.tokenValid = true;
    const meId = str(me["id"]);
    if (meId === this.pageId) {
      out.page = { id: meId, name: str(me["name"]) };
    } else {
      notes.push(`the token belongs to "${str(me["name"]) ?? meId}" (${meId}), not to the Page itself (system user or user token)`);
      try {
        const page = await this.#call("GET", this.#id(this.pageId, "page"), { query: { fields: "id,name" } });
        out.page = { id: str(page["id"]) ?? this.pageId, name: str(page["name"]) };
      } catch (err) {
        notes.push(`cannot read the configured Page ${this.pageId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // /debug_token lists the scopes of any token type (a Page token has no /me/permissions), but needs the app's own token.
    if (this.#appId && this.#appSecret) {
      try {
        // POST + method=GET keeps the inspected token in the body, never in the URL.
        const dbg = await this.#call("POST", "debug_token", { form: { method: "GET", input_token: this.#token }, asApp: true });
        const data = (dbg["data"] ?? {}) as Json;
        if (Array.isArray(data["scopes"])) {
          out.granted = (data["scopes"] as unknown[]).map(String);
          const expiresAt = typeof data["expires_at"] === "number" ? data["expires_at"] : null;
          if (expiresAt === 0) notes.push("the token does not expire");
          else if (expiresAt) notes.push(`the token expires ${new Date(expiresAt * 1000).toISOString()}`);
          return out;
        }
      } catch (err) {
        notes.push(`could not read the token's scopes via /debug_token: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    try {
      const perms = await this.#call("GET", "me/permissions");
      const rows = (Array.isArray(perms["data"]) ? perms["data"] : []) as { permission?: unknown; status?: unknown }[];
      if (rows.length === 0) {
        notes.push("this token type does not list its permissions (/me/permissions is empty)");
      } else {
        out.granted = rows.filter((r) => r.status === "granted").map((r) => String(r.permission));
        out.declined = rows.filter((r) => r.status !== "granted").map((r) => String(r.permission));
      }
    } catch (err) {
      notes.push(`could not read the token's permissions: ${err instanceof Error ? err.message : String(err)}`);
    }
    return out;
  }

  async close(): Promise<void> {
    // nothing to release
  }
}
