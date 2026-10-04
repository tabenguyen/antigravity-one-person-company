import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDotEnv } from "../src/config.ts";

const dirs: string[] = [];
function repoWith(envText: string | null, mode = 0o600): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agyhq-dotenv-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "agy-hq", workspaces: ["packages/*"] }));
  if (envText !== null) {
    fs.writeFileSync(path.join(dir, ".env"), envText);
    fs.chmodSync(path.join(dir, ".env"), mode);
  }
  fs.mkdirSync(path.join(dir, "packages", "cli"), { recursive: true });
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("loadDotEnv", () => {
  it("loads <repoRoot>/.env from a subdirectory, reports names only, and never overrides the shell", () => {
    const root = repoWith('AGYHQ_FB_PAGE_TOKEN=fake-token\nAGYHQ_FB_APP_SECRET="fake secret"\n# comment\nAGYHQ_IMAP_PASS=from-file\n');
    const env: NodeJS.ProcessEnv = { AGYHQ_IMAP_PASS: "from-shell" };
    const r = loadDotEnv({ cwd: path.join(root, "packages", "cli"), env });
    expect(r).toMatchObject({ path: path.join(root, ".env"), warning: null });
    expect([...r!.loaded].sort()).toEqual(["AGYHQ_FB_APP_SECRET", "AGYHQ_FB_PAGE_TOKEN"]);
    expect(env).toEqual({ AGYHQ_FB_PAGE_TOKEN: "fake-token", AGYHQ_FB_APP_SECRET: "fake secret", AGYHQ_IMAP_PASS: "from-shell" });
    expect(JSON.stringify(r)).not.toContain("fake-token");
  });

  it("returns null when there is no .env", () => {
    expect(loadDotEnv({ cwd: repoWith(null), env: {} })).toBeNull();
  });

  it("warns when the file is readable by other users", () => {
    const r = loadDotEnv({ cwd: repoWith("A=1\n", 0o644), env: {} });
    expect(r?.warning).toMatch(/chmod 600/);
  });

  it("honours AGYHQ_ENV_FILE", () => {
    const root = repoWith(null);
    const file = path.join(root, "custom.env");
    fs.writeFileSync(file, "AGYHQ_FB_PAGE_TOKEN=x\n", { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { AGYHQ_ENV_FILE: file };
    expect(loadDotEnv({ cwd: root, env })?.loaded).toEqual(["AGYHQ_FB_PAGE_TOKEN"]);
  });
});
