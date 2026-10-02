import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { renderResearcherWorkspace } from "../src/setup/researcher-workspace.ts";
import { makeTempDataDir } from "./helpers.ts";

let dir: string;
let brain: string;
let gate: string;
const CONV = "11111111-2222-3333-4444-555555555555";

beforeAll(() => {
  const root = fs.realpathSync(makeTempDataDir());
  dir = path.join(root, "setup-workspace");
  brain = path.join(root, "brain");
  fs.mkdirSync(path.join(brain, CONV, ".system_generated", "steps", "4"), { recursive: true });
  fs.writeFileSync(path.join(brain, CONV, ".system_generated", "steps", "4", "content.md"), "page");
  fs.mkdirSync(path.join(brain, "other-conversation"), { recursive: true });
  fs.writeFileSync(path.join(root, "secret.txt"), "nope");
  fs.symlinkSync(root, path.join(dir.replace(/setup-workspace$/, ""), "link-out")); // dir for symlink escapes
  renderResearcherWorkspace({ dir, nodeBin: process.execPath, brainRoot: brain, dnsCheck: false });
  gate = path.join(dir, ".agents", "hooks", "setup-gate.mjs");
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(dir, "evil-link.md"));
});

function run(stdin: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [gate], { input: stdin, env: { PATH: process.env.PATH ?? "", ANTIGRAVITY_CONVERSATION_ID: CONV, ...env }, encoding: "utf8" });
  return { out: JSON.parse(r.stdout || "{}") as { decision?: string; reason?: string }, code: r.status };
}
const call = (name: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  run(JSON.stringify({ conversationId: CONV, toolCall: { name, args }, ...extra }));

describe("researcher PreToolUse gate", () => {
  it("renders a workspace with limited tools, no MCP config and a hook pointing at the gate", () => {
    const agent = fs.readFileSync(path.join(dir, ".agents", "agents", "company-researcher.md"), "utf8");
    expect(agent).toMatch(/tools:\n {2}- read_url_content\n {2}- search_web\n {2}- view_file\n {2}- list_dir\n/);
    expect(agent).not.toMatch(/run_command|write_to_file|call_mcp_tool/);
    expect(fs.existsSync(path.join(dir, ".agents", "mcp_config.json"))).toBe(false);
    const hooks = JSON.parse(fs.readFileSync(path.join(dir, ".agents", "hooks.json"), "utf8"));
    expect(hooks["agyhq-setup"].PreToolUse[0].hooks[0].command).toContain("setup-gate.mjs");
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toMatch(/untrusted/);
  });

  it("allows the research tools", () => {
    expect(call("finish", { whatever: 1 }).out).toEqual({ decision: "allow" });
    expect(call("search_web", { query: "acme pricing" }).out).toEqual({ decision: "allow" });
    expect(call("read_url_content", { Url: "http://93.184.216.34/pricing" }).out).toEqual({ decision: "allow" });
  });

  it("denies every other tool, including MCP and shell", () => {
    for (const name of ["run_command", "write_to_file", "call_mcp_tool", "grep_search", "browser_subagent", "invoke_subagent", "replace_file_content", "send_message", ""]) {
      const r = call(name, { CommandLine: "ls" });
      expect(r.out.decision, name).toBe("deny");
    }
  });

  it("view_file / list_dir only inside the workspace or this conversation's brain dir", () => {
    const steps = path.join(brain, CONV, ".system_generated", "steps", "4", "content.md");
    expect(call("view_file", { AbsolutePath: steps }).out.decision).toBe("allow");
    expect(call("view_file", { AbsolutePath: path.join(dir, "AGENTS.md") }).out.decision).toBe("allow");
    expect(call("list_dir", { DirectoryPath: path.join(brain, CONV) }).out.decision).toBe("allow");
    expect(call("list_dir", { DirectoryPath: dir }).out.decision).toBe("allow");
    // outside / other conversations / traversal / relative / symlink escape / wrong arg name
    expect(call("view_file", { AbsolutePath: "/etc/passwd" }).out.decision).toBe("deny");
    expect(call("view_file", { AbsolutePath: path.join(brain, "other-conversation", "x") }).out.decision).toBe("deny");
    expect(call("view_file", { AbsolutePath: path.join(dir, "..", "secret.txt") }).out.decision).toBe("deny");
    expect(call("view_file", { AbsolutePath: path.join(brain, CONV, "..", "other-conversation", "x") }).out.decision).toBe("deny");
    expect(call("view_file", { AbsolutePath: "AGENTS.md" }).out.decision).toBe("deny");
    expect(call("view_file", { AbsolutePath: path.join(dir, "evil-link.md") }).out.decision).toBe("deny");
    expect(call("view_file", { Path: path.join(dir, "AGENTS.md") }).out.decision).toBe("deny");
    expect(call("list_dir", { DirectoryPath: path.dirname(dir) }).out.decision).toBe("deny");
    expect(call("list_dir", {}).out.decision).toBe("deny");
    expect(call("view_file", { AbsolutePath: path.join(process.env.HOME ?? "/", ".ssh", "id_rsa") }).out.decision).toBe("deny");
  });

  it("brain access needs a well-formed conversation id (env, else payload)", () => {
    const f = path.join(brain, CONV, ".system_generated", "steps", "4", "content.md");
    const noEnv = run(JSON.stringify({ toolCall: { name: "view_file", args: { AbsolutePath: f } } }), { ANTIGRAVITY_CONVERSATION_ID: "" });
    expect(noEnv.out.decision).toBe("deny");
    const viaPayload = run(JSON.stringify({ conversationId: CONV, toolCall: { name: "view_file", args: { AbsolutePath: f } } }), { ANTIGRAVITY_CONVERSATION_ID: "" });
    expect(viaPayload.out.decision).toBe("allow");
    const evil = run(JSON.stringify({ toolCall: { name: "view_file", args: { AbsolutePath: path.join(brain, "x", "y") } } }), { ANTIGRAVITY_CONVERSATION_ID: ".." });
    expect(evil.out.decision).toBe("deny");
  });

  it("read_url_content: public http(s) only (no loopback, private, link-local, credentials, odd schemes)", () => {
    const urls = [
      "http://localhost:7317/v1/admin/status",
      "http://127.0.0.1/",
      "http://2130706433/", // decimal loopback, normalised by URL
      "http://[::1]/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.20.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/",
      "http://[::ffff:127.0.0.1]/",
      "http://printer.local/",
      "http://intranet/",
      "https://user:pw@93.184.216.34/",
      "file:///etc/passwd",
      "ftp://93.184.216.34/",
      "not a url",
    ];
    for (const Url of urls) expect(call("read_url_content", { Url }).out.decision, Url).toBe("deny");
    expect(call("read_url_content", {}).out.decision).toBe("deny");
  });

  it("with DNS checking on, a hostname that does not resolve is denied (fail closed)", () => {
    const strict = path.join(dir, "strict-gate.mjs");
    renderResearcherWorkspace({ dir, nodeBin: process.execPath, brainRoot: brain, dnsCheck: true });
    fs.copyFileSync(path.join(dir, ".agents", "hooks", "setup-gate.mjs"), strict);
    const r = spawnSync(process.execPath, [strict], {
      input: JSON.stringify({ toolCall: { name: "read_url_content", args: { Url: "https://no-such-host.invalid/" } } }),
      encoding: "utf8",
    });
    expect(JSON.parse(r.stdout).decision).toBe("deny");
    renderResearcherWorkspace({ dir, nodeBin: process.execPath, brainRoot: brain, dnsCheck: false });
  });

  it("fails closed on garbage input", () => {
    for (const input of ["", "not json", "null", "[]", "{}", '{"toolCall":{"args":{}}}', '{"toolCall":{"name":42}}']) {
      const r = run(input);
      expect(r.out.decision, JSON.stringify(input)).toBe("deny");
      expect(r.code).toBe(0);
    }
  });
});
