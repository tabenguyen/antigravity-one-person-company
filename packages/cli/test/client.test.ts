import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { HqClient, HqApiError } from "../src/client.ts";

describe("HqClient", () => {
  let server: ServerType;
  let baseUrl: string;
  let tempCwd: string;

  beforeAll(async () => {
    const app = new Hono();
    app.get("/v1/admin/ping", (c) => c.json({ ok: true, data: { pong: true } }));
    app.get("/v1/admin/boom", (c) => c.json({ ok: false, error: { code: "internal", message: "kaboom" } }, 500));
    app.post("/v1/admin/echo", async (c) => c.json({ ok: true, data: await c.req.json() }));

    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(info.port));
    });
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    process.env.AGYHQ_ADMIN_TOKEN = "unused-in-these-tests";
    tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-cli-test-"));
  });

  afterEach(() => {
    delete process.env.AGYHQ_ADMIN_TOKEN;
  });

  it("GET returns the envelope's data on success", async () => {
    const client = new HqClient({ url: baseUrl, token: "t", cwd: tempCwd });
    const data = await client.get<{ pong: boolean }>("/v1/admin/ping");
    expect(data).toEqual({ pong: true });
  });

  it("POST sends a JSON body and returns the envelope's data", async () => {
    const client = new HqClient({ url: baseUrl, token: "t", cwd: tempCwd });
    const data = await client.post<{ a: number }>("/v1/admin/echo", { a: 1 });
    expect(data).toEqual({ a: 1 });
  });

  it("throws HqApiError with the server's code/message on an error envelope", async () => {
    const client = new HqClient({ url: baseUrl, token: "t", cwd: tempCwd });
    await expect(client.get("/v1/admin/boom")).rejects.toMatchObject({
      name: "HqApiError",
      code: "internal",
      message: "kaboom",
    });
  });

  it("throws a network HqApiError when the daemon is unreachable", async () => {
    const client = new HqClient({ url: "http://127.0.0.1:1", token: "t", cwd: tempCwd });
    await expect(client.get("/v1/admin/ping")).rejects.toBeInstanceOf(HqApiError);
  });
});
