import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createUiStaticMiddleware } from "../src/static-ui.ts";

function setup() {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-ui-"));
  fs.mkdirSync(path.join(dist, "assets"));
  fs.writeFileSync(path.join(dist, "index.html"), "<html>app</html>");
  fs.writeFileSync(path.join(dist, "assets", "index.js"), "console.log(1)");
  const app = new Hono();
  app.use("*", createUiStaticMiddleware(dist));
  app.get("/v1/admin/ping", (c) => c.text("pong"));
  return app;
}

describe("static UI middleware", () => {
  it("serves assets, falls back to index.html for client routes, and never shadows the API", async () => {
    const app = setup();
    const asset = await app.request("/assets/index.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");

    const deepLink = await app.request("/tasks/tsk_123");
    expect(deepLink.status).toBe(200);
    expect(await deepLink.text()).toContain("app");

    expect(await (await app.request("/v1/admin/ping")).text()).toBe("pong");
  });

  it("404s missing files instead of returning HTML as a script", async () => {
    const app = setup();
    expect((await app.request("/tasks/assets/index.js")).status).toBe(404);
    expect((await app.request("/assets/missing.css")).status).toBe(404);
  });
});
