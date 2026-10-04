// appsecret_proof and webhook signatures (fake values only: no real token or app secret exists in this repo).
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  FACEBOOK_APP_SECRET_ENV,
  GraphApiFacebookProvider,
  appSecretProof,
  createFacebookProvider,
  verifyWebhookSignature,
} from "../src/index.ts";

const TOKEN = "FAKE-page-token-for-tests";
const SECRET = "fake-app-secret-for-tests";

function setup(appSecret?: string, respond: (url: URL) => { status?: number; body: unknown } = () => ({ body: { id: "111_1" } })) {
  const urls: URL[] = [];
  const fetchFn = vi.fn(async (input: URL | string) => {
    const url = new URL(String(input));
    urls.push(url);
    const { status = 200, body } = respond(url);
    return new Response(JSON.stringify(body), { status });
  });
  const provider = new GraphApiFacebookProvider({ pageId: "111", accessToken: TOKEN, apiVersion: "v21.0", appSecret, fetch: fetchFn as unknown as typeof fetch, now: () => new Date("2026-10-04T12:00:00Z") });
  return { provider, urls };
}

describe("appsecret_proof", () => {
  it("is hex(HMAC-SHA256(key = app secret, message = token)), computed independently", () => {
    const expected = createHmac("sha256", SECRET).update(TOKEN).digest("hex");
    expect(appSecretProof(TOKEN, SECRET)).toBe(expected);
    expect(appSecretProof(TOKEN, SECRET)).toMatch(/^[0-9a-f]{64}$/);
    expect(appSecretProof(TOKEN, "another-secret")).not.toBe(expected);
  });

  it("is sent on every call when an app secret is set, and the token and the secret stay out of the URL", async () => {
    const { provider, urls } = setup(SECRET);
    await provider.createPost({ message: "m", mode: "preview" });
    await provider.replyToComment({ commentId: "c1", message: "r" });
    await provider.hideComment("c1");
    await provider.cancelScheduledPost("111_5");
    await provider.listScheduledPosts();
    await provider.fetchNew(null);
    await provider.verify();
    const proof = createHmac("sha256", SECRET).update(TOKEN).digest("hex");
    expect(urls.length).toBeGreaterThanOrEqual(7);
    for (const u of urls) {
      expect(u.searchParams.get("appsecret_proof"), u.pathname).toBe(proof);
      expect(u.toString()).not.toContain(TOKEN);
      expect(u.toString()).not.toContain(SECRET);
      expect(u.searchParams.has("access_token")).toBe(false);
    }
    expect(provider.sendsAppSecretProof).toBe(true);
    expect((await provider.inspect()).appSecretProof).toBe(true);
  });

  it("is not sent without an app secret (the secret is optional)", async () => {
    const { provider, urls } = setup(undefined);
    await provider.hideComment("c1");
    expect(urls[0]!.searchParams.has("appsecret_proof")).toBe(false);
    expect(provider.sendsAppSecretProof).toBe(false);
    expect((await provider.inspect()).appSecretProof).toBe(false);
    expect(setup("").provider.sendsAppSecretProof).toBe(false);
  });

  it("scrubs the app secret as well as the token from error messages", async () => {
    const { provider } = setup(SECRET, () => ({ status: 400, body: { error: { message: `bad appsecret_proof, secret ${SECRET} token ${TOKEN}`, code: 100 } } }));
    const err = (await provider.hideComment("c1").catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain(SECRET);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("***");
  });

  it("the factory reads AGYHQ_FB_APP_SECRET from the environment (and the token from AGYHQ_FB_PAGE_TOKEN by default)", async () => {
    expect(FACEBOOK_APP_SECRET_ENV).toBe("AGYHQ_FB_APP_SECRET");
    const urls: URL[] = [];
    const fetchFn = vi.fn(async (input: URL | string) => {
      urls.push(new URL(String(input)));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    const env = { AGYHQ_FB_PAGE_TOKEN: TOKEN, AGYHQ_FB_APP_SECRET: SECRET };
    const p = createFacebookProvider({ kind: "graph", pageId: "111", apiVersion: "v21.0", appId: "999" }, { env, fetch: fetchFn as unknown as typeof fetch })!;
    await p.hideComment("c1");
    expect(urls[0]!.searchParams.get("appsecret_proof")).toBe(appSecretProof(TOKEN, SECRET));

    urls.length = 0;
    const unsigned = createFacebookProvider({ kind: "graph", pageId: "111", apiVersion: "v21.0" }, { env: { AGYHQ_FB_PAGE_TOKEN: TOKEN }, fetch: fetchFn as unknown as typeof fetch })!;
    await unsigned.hideComment("c1");
    expect(urls[0]!.searchParams.has("appsecret_proof")).toBe(false);
  });
});

describe("verifyWebhookSignature (X-Hub-Signature-256), for the webhook endpoint that is not v1", () => {
  const body = JSON.stringify({ object: "page", entry: [{ id: "111", changes: [{ field: "feed" }] }] });
  const sign = (b: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(b).digest("hex")}`;

  it("accepts the right signature over the exact bytes and rejects everything else", () => {
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
    expect(verifyWebhookSignature(Buffer.from(body), sign(body), SECRET)).toBe(true);
    expect(verifyWebhookSignature(`${body} `, sign(body), SECRET)).toBe(false); // body changed
    expect(verifyWebhookSignature(body, sign(body, "other"), SECRET)).toBe(false); // wrong secret
    expect(verifyWebhookSignature(body, sign(body).replace("sha256=", "sha1="), SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "sha256=abc", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, null, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, sign(body), "")).toBe(false); // no secret configured: nothing verifies
  });
});
