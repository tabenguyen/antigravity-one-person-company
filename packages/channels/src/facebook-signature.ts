// Facebook's two HMAC-SHA256 uses of the app secret (docs/FANPAGE.md):
//
//   appsecret_proof      hex(HMAC-SHA256(key = app secret, message = access token)), sent with every Graph call so the dashboard's
//                        "Require App Secret" can be switched on (a leaked token alone is then useless).
//   X-Hub-Signature-256  "sha256=" + hex(HMAC-SHA256(key = app secret, message = raw webhook body)). The webhook endpoint is not
//                        part of v1; the verifier is here so it uses the same secret (AGYHQ_FB_APP_SECRET) when it arrives.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Name of the env var that holds the app secret (optional; never stored in the config file). */
export const FACEBOOK_APP_SECRET_ENV = "AGYHQ_FB_APP_SECRET";

export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(accessToken, "utf8").digest("hex");
}

/** Verify a webhook delivery: `signatureHeader` is the X-Hub-Signature-256 value, `rawBody` the exact bytes received. */
export function verifyWebhookSignature(rawBody: string | Uint8Array, signatureHeader: string | null | undefined, appSecret: string): boolean {
  if (!signatureHeader || !appSecret) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (!m) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(m[1]!, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
