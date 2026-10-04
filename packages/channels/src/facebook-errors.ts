// Typed errors for the Facebook Page channel, plus turning a Graph API failure into a message a non-technical owner can
// act on without ever echoing the token. Same spirit as errors.ts (email): the original Graph text is always kept, a hint
// is appended when we recognise the failure.

import { scrubSecrets } from "./errors.ts";

export type FacebookErrorCode =
  | "auth" // token missing, expired, revoked, or the user lost their Page role
  | "permission" // token is fine but lacks a permission / the app has no access to this object
  | "rate_limit" // app/page/user call limit
  | "schedule_window" // scheduled time outside 10 minutes .. 75 days (checked client-side)
  | "not_found" // the post / comment does not exist (any more)
  | "invalid_request" // Graph rejected the parameters
  | "network" // no response at all
  | "api"; // anything else Graph (or a proxy) answered with

export interface FacebookErrorInfo {
  code: FacebookErrorCode;
  /** Retrying the same call later may work (rate limit, network, Graph 5xx / is_transient). */
  transient?: boolean;
  httpStatus?: number | null;
  /** Graph `error.code` / `error.error_subcode` / `error.fbtrace_id`. */
  fbCode?: number | null;
  fbSubcode?: number | null;
  fbtraceId?: string | null;
}

export class FacebookError extends Error {
  readonly code: FacebookErrorCode;
  readonly transient: boolean;
  readonly httpStatus: number | null;
  readonly fbCode: number | null;
  readonly fbSubcode: number | null;
  readonly fbtraceId: string | null;

  constructor(message: string, info: FacebookErrorInfo) {
    super(message);
    this.name = "FacebookError";
    this.code = info.code;
    this.transient = info.transient ?? false;
    this.httpStatus = info.httpStatus ?? null;
    this.fbCode = info.fbCode ?? null;
    this.fbSubcode = info.fbSubcode ?? null;
    this.fbtraceId = info.fbtraceId ?? null;
  }
}

/** Thrown before any request is made when a scheduled time is outside what Facebook accepts. */
export class FacebookScheduleWindowError extends FacebookError {
  constructor(message: string) {
    super(message, { code: "schedule_window" });
    this.name = "FacebookScheduleWindowError";
  }
}

interface GraphErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
  is_transient?: boolean;
}

const AUTH_CODES = new Set([102, 190]);
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/** Map a Graph error response (HTTP status + the `error` object of the body) to a typed FacebookError. */
export function classifyGraphError(httpStatus: number, body: unknown, secrets: readonly string[] = []): FacebookError {
  const e = ((body && typeof body === "object" ? (body as { error?: GraphErrorBody }).error : undefined) ?? {}) as GraphErrorBody;
  const fbCode = typeof e.code === "number" ? e.code : null;
  const fbSubcode = typeof e.error_subcode === "number" ? e.error_subcode : null;
  const raw = e.message || `Graph API answered HTTP ${httpStatus}`;

  let code: FacebookErrorCode = "api";
  let transient = e.is_transient === true || httpStatus >= 500;
  if (fbCode !== null && AUTH_CODES.has(fbCode)) code = "auth";
  else if (httpStatus === 401) code = "auth";
  else if (fbCode === 10 || (fbCode !== null && fbCode >= 200 && fbCode <= 299) || httpStatus === 403) code = "permission";
  else if ((fbCode !== null && RATE_LIMIT_CODES.has(fbCode)) || (fbCode !== null && fbCode >= 80000 && fbCode <= 80014) || httpStatus === 429) {
    code = "rate_limit";
    transient = true;
  } else if (httpStatus === 404 || (fbCode === 100 && fbSubcode === 33)) code = "not_found";
  else if (fbCode === 100 || httpStatus === 400) code = "invalid_request";

  const err = new FacebookError("", { code, transient, httpStatus, fbCode, fbSubcode, fbtraceId: e.fbtrace_id ?? null });
  err.message = describeFacebookError({ code, message: raw, fbCode, fbtraceId: e.fbtrace_id ?? null }, secrets);
  return err;
}

const HINTS: Partial<Record<FacebookErrorCode, string>> = {
  auth: "The access token is invalid, expired or was revoked. Create a new System User token (or a new Page token) in Meta Business Suite and put it in the env var named by facebook.tokenEnv. See docs/FANPAGE-RESEARCH.md section 1.",
  permission:
    "The token lacks a permission or the app cannot reach this object. Check the five Page permissions with `hq facebook doctor`; in Development mode the app only sees data from people with a role on the app.",
  rate_limit: "Facebook's call limit was hit. It is retried automatically; lower facebook.pollIntervalMs frequency if it keeps happening.",
  not_found: "The post or comment no longer exists (deleted, or hidden by its author).",
  schedule_window: "Facebook only accepts scheduled posts between 10 minutes and 75 days ahead.",
  network: "Could not reach graph.facebook.com. Check the internet connection / proxy; it is retried automatically.",
};

/** "<original text> [(fb code, trace id)] - <hint>", secret-free and capped at ~600 chars. */
export function describeFacebookError(
  err: { code: FacebookErrorCode; message: string; fbCode?: number | null; fbtraceId?: string | null },
  secrets: readonly string[] = [],
): string {
  const detail = [err.fbCode != null ? `code ${err.fbCode}` : null, err.fbtraceId ? `trace ${err.fbtraceId}` : null].filter(Boolean).join(", ");
  let text = detail ? `${err.message} (${detail})` : err.message;
  const hint = HINTS[err.code];
  if (hint && !text.includes(hint)) text = `${text} - ${hint}`;
  text = scrubSecrets(text, secrets);
  return text.length > 600 ? `${text.slice(0, 597)}...` : text;
}

/** True for failures a retry may fix. Anything that is not a FacebookError (a bug, a bad argument) is not. */
export function isTransientFacebookError(err: unknown): boolean {
  return err instanceof FacebookError && err.transient;
}
