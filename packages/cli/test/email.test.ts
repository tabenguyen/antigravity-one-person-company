import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GMAIL_FOLDERS, buildEml, startMailServers, type TestMailServers } from "../../channels/test/support/mail-servers.ts";
import { cmdEmail, EMAIL_HELP } from "../src/commands/email.ts";

let servers: TestMailServers;
let dir: string;
beforeEach(async () => {
  servers = await startMailServers({ folders: GMAIL_FOLDERS });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-email-cli-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await servers.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function capture() {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation(() => {});
  return out;
}

function writeConfig(pass = servers.imapConfig.pass) {
  const file = path.join(dir, "agyhq.config.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      dataDir: path.join(dir, "data"),
      adminToken: "t",
      email: {
        kind: "imap-smtp",
        address: servers.imapConfig.user,
        imap: { ...servers.imapConfig, pass },
        smtp: servers.smtpConfig,
      },
    }),
  );
  return file;
}

describe("hq email doctor", () => {
  it("prints help and rejects bad flags", async () => {
    const out = capture();
    await cmdEmail(["--help"], { json: false });
    expect(out.join("\n")).toBe(EMAIL_HELP);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await expect(cmdEmail(["doctor", "--sample", "99"], { json: false })).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("--local checks the mailbox from the config file, prints a readable report and no password", async () => {
    servers.imap.deliver({ raw: await buildEml({ subject: "Báo giá", text: "xin báo giá", messageId: "<a@x>" }) });
    const out = capture();
    await cmdEmail(["doctor", "--local", "--sample", "3"], { json: false, configPath: writeConfig() });
    const text = out.join("\n");
    expect(text).toMatch(/✓ IMAP login/);
    expect(text).toMatch(/Báo giá/);
    expect(text).toMatch(/new_lead/);
    expect(text).not.toContain(servers.imapConfig.pass);
    expect(servers.smtp.received).toHaveLength(0);
  });

  it("exits 1 on a failing check and sends only with --send-test", async () => {
    const out = capture();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await expect(cmdEmail(["doctor", "--local"], { json: false, configPath: writeConfig("wrong-pass-123") })).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(out.join("\n")).toMatch(/✗ IMAP login/);
    expect(out.join("\n")).not.toContain("wrong-pass-123");

    exit.mockRestore();
    await cmdEmail(["doctor", "--local", "--send-test", "me@example.com"], { json: true, configPath: writeConfig() });
    expect(servers.smtp.received).toHaveLength(1);
  });
});
