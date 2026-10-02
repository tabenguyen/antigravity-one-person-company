// ApiEnvelope response helpers shared by every route in this router.

import type { Context } from "hono";
import type { ApiErrorCode } from "@agyhq/core";

export const STATUS_BY_CODE: Record<ApiErrorCode, 400 | 401 | 403 | 404 | 409 | 500> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  conflict: 409,
  internal: 500,
};

export function ok<T>(c: Context, data: T, status: 200 | 201 = 200): Response {
  return c.json({ ok: true, data }, status);
}

export function err(c: Context, code: ApiErrorCode, message: string): Response {
  return c.json({ ok: false, error: { code, message } }, STATUS_BY_CODE[code]);
}
