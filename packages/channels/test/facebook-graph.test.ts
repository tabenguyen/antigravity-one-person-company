import { describe, expect, it, vi } from "vitest";
import { FB_REQUIRED_PERMISSIONS } from "@agyhq/core";
import { FacebookError, FacebookScheduleWindowError, GraphApiFacebookProvider, FB_SCHEDULE_MAX_MS, FB_SCHEDULE_MIN_MS } from "../src/index.ts";

const TOKEN = "EAAB-super-secret-token-123";
const NOW = new Date("2026-10-04T12:00:00.000Z");

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
}

type Responder = (call: Call) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

/** A fetch that records every call and answers from `responder`. No network. */
function mockFetch(responder: Responder): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const { status = 200, body } = await responder(call);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function make(responder: Responder, extra: Partial<ConstructorParameters<typeof GraphApiFacebookProvider>[0]> = {}) {
  const m = mockFetch(responder);
  const provider = new GraphApiFacebookProvider({ pageId: "111", accessToken: TOKEN, apiVersion: "v21.0", fetch: m.fetch, now: () => NOW, ...extra });
  return { provider, calls: m.calls };
}

const form = (c: Call) => Object.fromEntries(new URLSearchParams(c.body ?? ""));
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000).toISOString();

describe("GraphApiFacebookProvider: transport", () => {
  it("sends the token only in the Authorization header, never in the URL or the body, and uses the configured version", async () => {
    const { provider, calls } = make(() => ({ body: { id: "111_9" } }));
    await provider.createPost({ message: "hello", mode: "scheduled", scheduledPublishTime: minutes(60 * 24) });
    await provider.replyToComment({ commentId: "c1", message: "thanks" });
    await provider.fetchNew(null).catch(() => {});
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) {
      expect(c.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
      expect(c.url.toString()).not.toContain(TOKEN);
      expect(c.url.searchParams.has("access_token")).toBe(false);
      expect(c.body ?? "").not.toContain(TOKEN);
      expect(c.url.pathname.startsWith("/v21.0/")).toBe(true);
      expect(c.url.origin).toBe("https://graph.facebook.com");
    }
  });

  it("refuses to be built without a token, page id or version", () => {
    expect(() => new GraphApiFacebookProvider({ pageId: "1", accessToken: "", apiVersion: "v21.0" })).toThrow(/no access token/);
    expect(() => new GraphApiFacebookProvider({ pageId: "", accessToken: "x", apiVersion: "v21.0" })).toThrow(/pageId/);
    expect(() => new GraphApiFacebookProvider({ pageId: "1", accessToken: "x", apiVersion: "" })).toThrow(/apiVersion/);
  });

  it("rejects ids that could change the request path", async () => {
    const { provider, calls } = make(() => ({ body: { success: true } }));
    await expect(provider.hideComment("123/../me")).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toHaveLength(0);
  });
});

describe("GraphApiFacebookProvider: posting", () => {
  it("schedules with published=false and a unix scheduled_publish_time", async () => {
    const at = minutes(60 * 24);
    const { provider, calls } = make(() => ({ body: { id: "111_222" } }));
    const res = await provider.createPost({ message: "Xin chào", link: "https://example.com/a", mode: "scheduled", scheduledPublishTime: at });
    expect(res).toEqual({ postId: "111_222", mode: "scheduled", scheduledPublishTime: at });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/v21.0/111/feed");
    expect(form(calls[0]!)).toEqual({
      message: "Xin chào",
      link: "https://example.com/a",
      published: "false",
      scheduled_publish_time: String(Math.floor(new Date(at).getTime() / 1000)),
    });
  });

  it("creates an unpublished preview (published=false, no schedule) and an immediate post (published=true)", async () => {
    const { provider, calls } = make(() => ({ body: { id: "111_1" } }));
    await provider.createPost({ message: "draft", mode: "preview" });
    await provider.createPost({ message: "live", mode: "immediate" });
    expect(form(calls[0]!)).toEqual({ message: "draft", published: "false" });
    expect(form(calls[1]!)).toEqual({ message: "live", published: "true" });
  });

  it("validates the 10 minute .. 75 day window before any request is made", async () => {
    const { provider, calls } = make(() => ({ body: { id: "x" } }));
    const tooSoon = provider.createPost({ message: "m", mode: "scheduled", scheduledPublishTime: minutes(9) });
    await expect(tooSoon).rejects.toBeInstanceOf(FacebookScheduleWindowError);
    await expect(tooSoon).rejects.toMatchObject({ code: "schedule_window", transient: false });
    await expect(provider.createPost({ message: "m", mode: "scheduled", scheduledPublishTime: minutes(75 * 24 * 60 + 1) })).rejects.toMatchObject({ code: "schedule_window" });
    await expect(provider.createPost({ message: "m", mode: "scheduled", scheduledPublishTime: null })).rejects.toMatchObject({ code: "schedule_window" });
    await expect(provider.createPost({ message: "m", mode: "scheduled", scheduledPublishTime: "not a date" })).rejects.toMatchObject({ code: "schedule_window" });
    expect(calls).toHaveLength(0);
  });

  it("accepts the window edges (exactly 10 minutes and exactly 75 days)", async () => {
    const { provider, calls } = make(() => ({ body: { id: "111_1" } }));
    await provider.createPost({ message: "m", mode: "scheduled", scheduledPublishTime: new Date(NOW.getTime() + FB_SCHEDULE_MIN_MS).toISOString() });
    await provider.createPost({ message: "m", mode: "scheduled", scheduledPublishTime: new Date(NOW.getTime() + FB_SCHEDULE_MAX_MS).toISOString() });
    expect(calls).toHaveLength(2);
  });

  it("lists scheduled posts, cancels one with DELETE, replies with POST /comments and hides with is_hidden", async () => {
    const at = Math.floor(new Date(minutes(120)).getTime() / 1000);
    const { provider, calls } = make((c) => {
      if (c.url.pathname.endsWith("/scheduled_posts")) return { body: { data: [{ id: "111_5", message: "later", created_time: "2026-10-04T11:00:00+0000", scheduled_publish_time: at, is_published: false }] } };
      if (c.method === "DELETE") return { body: { success: true } };
      if (c.url.pathname.endsWith("/comments")) return { body: { id: "c9_r1" } };
      return { body: { success: true } };
    });
    const scheduled = await provider.listScheduledPosts();
    expect(scheduled).toMatchObject([{ id: "111_5", message: "later", isPublished: false, scheduledPublishTime: new Date(at * 1000).toISOString() }]);
    await provider.cancelScheduledPost("111_5");
    expect(await provider.replyToComment({ commentId: "c9", message: "cảm ơn bạn" })).toEqual({ replyId: "c9_r1" });
    await provider.hideComment("c10");
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "GET /v21.0/111/scheduled_posts",
      "DELETE /v21.0/111_5",
      "POST /v21.0/c9/comments",
      "POST /v21.0/c10",
    ]);
    expect(form(calls[2]!)).toEqual({ message: "cảm ơn bạn" });
    expect(form(calls[3]!)).toEqual({ is_hidden: "true" });
  });

  it("treats {success:false} on hide/delete as a failure", async () => {
    const { provider } = make(() => ({ body: { success: false } }));
    await expect(provider.hideComment("c1")).rejects.toBeInstanceOf(FacebookError);
    await expect(provider.cancelScheduledPost("p1")).rejects.toBeInstanceOf(FacebookError);
  });
});

describe("GraphApiFacebookProvider: polling", () => {
  const feed = {
    data: [
      {
        id: "111_1",
        message: "Ra mắt tính năng mới",
        created_time: "2026-10-03T08:00:00+0000",
        permalink_url: "https://facebook.com/111/posts/1",
        is_published: true,
        comments: {
          data: [
            { id: "c3", message: "newest, no author", created_time: "2026-10-04T11:30:00+0000" },
            { id: "c2", message: "đã trả lời chưa?", created_time: "2026-10-04T10:00:00+0000", from: { id: "u7", name: "Lan" }, parent: { id: "c1" } },
            { id: "c1", message: "old", created_time: "2026-10-03T09:00:00+0000", from: { id: "u1", name: "An" } },
          ],
        },
      },
    ],
  };

  it("a null cursor replays nothing and returns 'now' as the cursor", async () => {
    const { provider } = make(() => ({ body: feed }));
    const res = await provider.fetchNew(null);
    expect(res.comments).toEqual([]);
    expect(res.cursor).toBe(NOW.toISOString());
    expect(res.posts).toHaveLength(1);
  });

  it("returns comments at or after the cursor, oldest first, maps a missing author to null and advances the cursor", async () => {
    const { provider, calls } = make(() => ({ body: feed }));
    const res = await provider.fetchNew("2026-10-04T00:00:00.000Z");
    expect(res.comments.map((c) => c.id)).toEqual(["c2", "c3"]);
    expect(res.comments[0]).toMatchObject({ postId: "111_1", parentId: "c1", from: { id: "u7", name: "Lan" }, message: "đã trả lời chưa?" });
    expect(res.comments[1]!.from).toBeNull();
    expect(res.cursor).toBe("2026-10-04T11:30:00.000Z");
    const q = calls[0]!.url.searchParams;
    expect(q.get("fields")).toContain("comments.filter(stream)");
    expect(q.get("since")).toBe(String(Math.floor((NOW.getTime() - 14 * 86_400_000) / 1000)));

    const again = await provider.fetchNew(res.cursor);
    expect(again.comments.map((c) => c.id)).toEqual(["c3"]); // overlap by design: the daemon dedupes by id
    expect(again.cursor).toBe(res.cursor);
  });

  it("pages with paging.cursors.after on a URL it builds itself, never paging.next", async () => {
    let n = 0;
    const { provider, calls } = make(() => {
      n += 1;
      return n === 1
        ? { body: { data: [{ id: "111_1", created_time: "2026-10-04T01:00:00+0000" }], paging: { cursors: { after: "CURSOR2" }, next: "https://graph.facebook.com/v21.0/111/feed?access_token=LEAK&after=CURSOR2" } } }
        : { body: { data: [{ id: "111_2", created_time: "2026-10-04T02:00:00+0000" }] } };
    });
    const res = await provider.fetchNew("2026-10-01T00:00:00.000Z");
    expect(res.posts.map((p) => p.id)).toEqual(["111_1", "111_2"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url.searchParams.get("after")).toBe("CURSOR2");
    expect(calls[1]!.url.toString()).not.toContain("LEAK");
  });
});

describe("GraphApiFacebookProvider: errors", () => {
  const graphError = (code: number, message: string, extra: Record<string, unknown> = {}, status = 400) => () => ({ status, body: { error: { message, type: "OAuthException", code, fbtrace_id: "TRACE1", ...extra } } });

  it.each([
    [190, 401, "auth", false],
    [200, 403, "permission", false],
    [10, 403, "permission", false],
    [4, 400, "rate_limit", true],
    [613, 400, "rate_limit", true],
    [100, 400, "invalid_request", false],
    [2, 500, "api", true],
  ])("maps Graph code %i (HTTP %i) to %s (transient: %s)", async (fbCode, status, code, transient) => {
    const { provider } = make(graphError(fbCode, "boom", {}, status));
    await expect(provider.hideComment("c1")).rejects.toMatchObject({ name: "FacebookError", code, transient, fbCode, fbtraceId: "TRACE1" });
  });

  it("maps 'object does not exist' (code 100, subcode 33) to not_found", async () => {
    const { provider } = make(graphError(100, "Unsupported post request. Object does not exist", { error_subcode: 33 }));
    await expect(provider.replyToComment({ commentId: "gone", message: "x" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("never echoes the token, even if Graph does, and appends an actionable hint", async () => {
    const { provider } = make(graphError(190, `Invalid OAuth access token ${TOKEN}.`, {}, 401));
    const err = await provider.hideComment("c1").catch((e: Error) => e);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).toContain("***");
    expect((err as Error).message).toMatch(/System User token/);
  });

  it("turns a network failure into a transient 'network' error without the token", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError(`fetch failed for ${TOKEN}`);
    });
    const provider = new GraphApiFacebookProvider({ pageId: "111", accessToken: TOKEN, apiVersion: "v21.0", fetch: fetchFn as unknown as typeof fetch });
    const err = (await provider.hideComment("c1").catch((e: unknown) => e)) as FacebookError;
    expect(err).toMatchObject({ code: "network", transient: true });
    expect(err.message).not.toContain(TOKEN);
  });

  it("verify() reports a bad token as a value, not a throw", async () => {
    const { provider } = make(graphError(190, "expired", {}, 401));
    const v = await provider.verify();
    expect(v.ok).toBe(false);
  });
});

describe("GraphApiFacebookProvider: inspect (hq facebook doctor)", () => {
  it("reads the Page identity from /me and the granted / declined permissions", async () => {
    const { provider, calls } = make((c) => {
      if (c.url.pathname.endsWith("/me/permissions")) {
        return { body: { data: [...FB_REQUIRED_PERMISSIONS.slice(0, 4).map((permission) => ({ permission, status: "granted" })), { permission: "pages_show_list", status: "declined" }] } };
      }
      return { body: { id: "111", name: "Acme Page" } };
    }, { appMode: "development" });
    const r = await provider.inspect();
    expect(r).toMatchObject({ tokenValid: true, page: { id: "111", name: "Acme Page" }, appMode: "development", declined: ["pages_show_list"] });
    expect(r.granted).toEqual(FB_REQUIRED_PERMISSIONS.slice(0, 4));
    expect(calls.every((c) => !c.url.toString().includes(TOKEN))).toBe(true);
  });

  it("notes a system-user token and resolves the configured Page separately", async () => {
    const { provider } = make((c) => {
      if (c.url.pathname === "/v21.0/me") return { body: { id: "su-1", name: "Agyhq System User" } };
      if (c.url.pathname === "/v21.0/111") return { body: { id: "111", name: "Acme Page" } };
      return { body: { data: [] } };
    });
    const r = await provider.inspect();
    expect(r.page).toEqual({ id: "111", name: "Acme Page" });
    expect(r.granted).toBeNull();
    expect(r.appMode).toBe("unknown");
    expect(r.notes.join(" ")).toMatch(/system user or user token/);
    expect(r.notes.join(" ")).toMatch(/does not list its permissions/);
  });

  it("reports an invalid token without throwing", async () => {
    const { provider } = make(() => ({ status: 401, body: { error: { message: "Error validating access token: Session has expired", code: 190 } } }));
    const r = await provider.inspect();
    expect(r).toMatchObject({ tokenValid: false, page: null, granted: null });
    expect(r.tokenError).toMatch(/Session has expired/);
  });
});

describe("GraphApiFacebookProvider: inspect via /debug_token (appId + app secret)", () => {
  const SECRET = "app-secret-xyz";

  it("reads a Page token's scopes and expiry from /debug_token, authenticated as the app, token kept out of the URL", async () => {
    const { provider, calls } = make(
      (c) => {
        if (c.url.pathname === "/v21.0/debug_token") {
          return { body: { data: { is_valid: true, type: "PAGE", expires_at: 0, scopes: [...FB_REQUIRED_PERMISSIONS, "pages_manage_metadata"] } } };
        }
        return { body: { id: "111", name: "Acme Page" } };
      },
      { appId: "999", appSecret: SECRET },
    );
    const r = await provider.inspect();
    expect(r.granted).toEqual([...FB_REQUIRED_PERMISSIONS, "pages_manage_metadata"]);
    expect(r.notes).toContain("the token does not expire");
    const dbg = calls.find((c) => c.url.pathname.endsWith("/debug_token"))!;
    expect(dbg.method).toBe("POST");
    expect(dbg.headers["authorization"]).toBe(`Bearer 999|${SECRET}`);
    expect(form(dbg)).toEqual({ method: "GET", input_token: TOKEN });
    expect(dbg.url.searchParams.has("appsecret_proof")).toBe(false);
    expect(calls.some((c) => c.url.pathname.endsWith("/me/permissions"))).toBe(false);
    expect(calls.every((c) => !c.url.toString().includes(TOKEN) && !c.url.toString().includes(SECRET))).toBe(true);
  });

  it("falls back to /me/permissions when /debug_token fails, and scrubs the secret from the note", async () => {
    const { provider } = make(
      (c) => {
        if (c.url.pathname.endsWith("/debug_token")) return { status: 400, body: { error: { message: `bad app token 999|${SECRET}`, code: 190 } } };
        if (c.url.pathname.endsWith("/me/permissions")) return { body: { data: [] } };
        return { body: { id: "111", name: "Acme Page" } };
      },
      { appId: "999", appSecret: SECRET },
    );
    const r = await provider.inspect();
    expect(r.granted).toBeNull();
    expect(r.notes.join(" ")).toMatch(/debug_token/);
    expect(r.notes.join(" ")).not.toContain(SECRET);
  });
});
