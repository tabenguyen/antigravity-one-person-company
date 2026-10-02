// Regenerates the README demo screenshots in docs/images/ from fictional data:
// seeds a throwaway dataDir (.demo/), starts a separate daemon on its own port,
// applies the demo company profile, then captures the UI with Playwright.
// Your real dataDir and daemon are never touched.
//
//   npm run demo:screenshots                    all shots
//   npm run demo:screenshots -- --only sent     one shot (inbound | sent | contact)
//   npm run demo:screenshots -- --keep          leave the demo daemon running to look around
//
// Env: DEMO_PORT (default 7318), DEMO_CHROMIUM_PATH (use an existing Chromium instead of
// Playwright's own; otherwise run `npx playwright install chromium` once).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Page } from "playwright";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORK = path.join(REPO, ".demo");
const DATA = path.join(WORK, "data");
const OUT = path.join(REPO, "docs/images");
const FIXTURES = path.join(REPO, "scripts/demo/fixtures");
const PORT = Number(process.env.DEMO_PORT ?? 7318);
const BASE = `http://127.0.0.1:${PORT}`;
const HERO_EMAIL = "thuha@spahoasen.example";

const { values: args } = parseArgs({ options: { only: { type: "string" }, keep: { type: "boolean" } } });

/** Each shot: output file, how to get the page into the right state, and an optional crop height (CSS px). */
const SHOTS: Record<string, { file: string; clipHeight?: number; go: (page: Page, ctx: { contactId: string }) => Promise<void> }> = {
  inbound: {
    file: "demo-1-inbound.png",
    clipHeight: 760,
    go: async (page) => {
      await page.goto(`${BASE}/inbound`);
      await page.getByText("Spa Hoa Sen có đang mất khách").first().waitFor();
      await page.getByText("Routed to").waitFor();
    },
  },
  sent: {
    file: "demo-2-auto-reply-sent.png",
    go: async (page) => {
      await page.goto(`${BASE}/inbox`);
      await page.getByRole("tab", { name: "Sent" }).click();
      await page.getByText("policy:autonomous").first().waitFor();
      await page.getByText("Contact:").waitFor();
    },
  },
  contact: {
    file: "demo-3-contact-timeline.png",
    clipHeight: 740,
    go: async (page, { contactId }) => {
      await page.goto(`${BASE}/contacts/${contactId}`);
      await page.getByText("Timeline").waitFor();
    },
  },
};

function run(cmd: string, cmdArgs: string[]): void {
  const r = spawnSync(cmd, cmdArgs, { cwd: REPO, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} exited with ${r.status}`);
}

async function portInUse(): Promise<boolean> {
  try {
    await fetch(BASE, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function waitForDaemon(daemon: ChildProcess): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (daemon.exitCode !== null) throw new Error(`demo daemon exited early; see ${path.join(WORK, "server.log")}`);
    if (await portInUse()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`demo daemon did not answer on ${BASE}; see ${path.join(WORK, "server.log")}`);
}

async function api<T>(token: string, method: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; data: T; error?: unknown };
  if (!res.ok || !json.ok) throw new Error(`${method} ${route} failed: ${JSON.stringify(json.error ?? json)}`);
  return json.data;
}

function writeConfig(): string {
  const config = {
    dataDir: DATA,
    port: PORT,
    companyName: "BookNhanh",
    kbRoot: path.join(WORK, "kb"),
    templatesRoot: path.join(REPO, "templates"),
    hooksDistDir: path.join(REPO, "packages/hooks/dist"),
    mcpEntry: path.join(REPO, "packages/mcp/dist/company-mcp.mjs"),
    uiDist: path.join(REPO, "packages/ui/dist"),
    email: { kind: "maildir", root: path.join(WORK, "maildir"), address: "mai@booknhanh.example" },
    sender: { name: "Mai - BookNhanh", address: "mai@booknhanh.example", companyAddressLine: "BookNhanh, TP. Hồ Chí Minh" },
    unsubscribeMailto: "unsubscribe@booknhanh.example",
  };
  const file = path.join(WORK, "agyhq.config.json");
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

async function main(): Promise<void> {
  const names = args.only ? [args.only] : Object.keys(SHOTS);
  for (const n of names) if (!SHOTS[n]) throw new Error(`unknown shot "${n}" (expected one of: ${Object.keys(SHOTS).join(", ")})`);
  if (!fs.existsSync(path.join(REPO, "packages/ui/dist/index.html"))) throw new Error("UI not built — run `npm run build` first");
  if (await portInUse()) throw new Error(`port ${PORT} is already in use — stop that process or set DEMO_PORT`);

  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK, "kb"), { recursive: true });
  const configFile = writeConfig();
  run("npx", ["tsx", "scripts/demo/seed.ts", DATA]);

  const log = fs.openSync(path.join(WORK, "server.log"), "w");
  const daemon = spawn("npx", ["tsx", "packages/cli/src/main.ts", "serve", "--config", configFile], {
    cwd: REPO,
    stdio: ["ignore", log, log],
    detached: true,
  });
  const stopDaemon = () => {
    if (daemon.pid && daemon.exitCode === null) process.kill(-daemon.pid, "SIGTERM");
  };

  let failed = true;
  try {
    await waitForDaemon(daemon);
    const token = fs.readFileSync(path.join(DATA, "admin-token"), "utf8").trim();
    const readFixture = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
    await api(token, "PUT", "/v1/admin/setup/company", readFixture("company-profile.json"));
    await api(token, "PUT", "/v1/admin/setup/role-kb", readFixture("role-kb.json"));
    await api(token, "POST", "/v1/admin/killswitch", { outboundEnabled: true });
    const { contacts } = await api<{ contacts: { id: string }[] }>(
      token,
      "GET",
      `/v1/admin/contacts?email=${encodeURIComponent(HERO_EMAIL)}`,
    );
    const contactId = contacts[0]!.id;

    const browser = await chromium.launch(process.env.DEMO_CHROMIUM_PATH ? { executablePath: process.env.DEMO_CHROMIUM_PATH } : {});
    try {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 2,
        colorScheme: "light",
        locale: "vi-VN",
        timezoneId: "Asia/Ho_Chi_Minh",
      });
      await ctx.addInitScript((t) => localStorage.setItem("agyhq_admin_token", t), token);
      const page = await ctx.newPage();
      fs.mkdirSync(OUT, { recursive: true });
      for (const name of names) {
        const shot = SHOTS[name]!;
        await shot.go(page, { contactId });
        await page.waitForTimeout(500); // let SSE-driven refreshes settle
        const file = path.join(OUT, shot.file);
        await page.screenshot({ path: file, clip: shot.clipHeight ? { x: 0, y: 0, width: 1440, height: shot.clipHeight } : undefined });
        console.log(`saved ${path.relative(REPO, file)}`);
      }
    } finally {
      await browser.close();
    }

    failed = false;
    if (args.keep) {
      console.log(`demo daemon still running at ${BASE} (admin token in .demo/data/admin-token); Ctrl+C to stop`);
      process.on("SIGINT", () => {
        stopDaemon();
        process.exit(0);
      });
      await new Promise(() => {});
    }
  } finally {
    if (failed || !args.keep) stopDaemon();
  }
}

main().catch((err) => {
  console.error(`demo:screenshots: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
