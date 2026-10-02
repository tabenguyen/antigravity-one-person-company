// Shared "read the request body as JSON, tolerating an empty body" helper.

import type { Context } from "hono";

export async function readJsonBody(c: Context): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    const text = await c.req.text();
    return { ok: true, body: text.length > 0 ? JSON.parse(text) : {} };
  } catch {
    return { ok: false };
  }
}
