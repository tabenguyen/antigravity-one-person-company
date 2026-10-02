import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SecretBox } from "../src/setup/secrets.ts";
import { makeTempDataDir } from "./helpers.ts";

describe("SecretBox", () => {
  it("round-trips, creates a 32-byte key with mode 600 on first use, and never writes plaintext", () => {
    const dir = makeTempDataDir();
    const box = new SecretBox(dir);
    expect(fs.existsSync(path.join(dir, "secret.key"))).toBe(false); // lazy
    const token = box.encrypt("hunter2 pässwörd", "ctx");
    expect(token.startsWith("v1:")).toBe(true);
    expect(token).not.toContain("hunter2");
    expect(box.decrypt(token, "ctx")).toBe("hunter2 pässwörd");

    const keyPath = path.join(dir, "secret.key");
    expect(Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64")).toHaveLength(32);
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);

    // a second box over the same dir reads the same key; ciphertexts are salted per call
    expect(new SecretBox(dir).decrypt(token, "ctx")).toBe("hunter2 pässwörd");
    expect(box.encrypt("x", "ctx")).not.toBe(box.encrypt("x", "ctx"));
  });

  it("rejects tampering, the wrong context and a different key; tryDecrypt returns null", () => {
    const box = new SecretBox(makeTempDataDir());
    const token = box.encrypt("secret", "imap");
    expect(() => box.decrypt(token, "smtp")).toThrow();
    const flipped = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`;
    expect(() => box.decrypt(flipped, "imap")).toThrow();
    expect(() => box.decrypt("garbage", "imap")).toThrow();
    expect(box.tryDecrypt(flipped, "imap")).toBeNull();
    expect(box.tryDecrypt(null)).toBeNull();
    expect(() => new SecretBox(makeTempDataDir()).decrypt(token, "imap")).toThrow(); // other data dir = other key
  });

  it("warns about (and tightens) a group/world-readable key file, and rejects a malformed one", () => {
    const dir = makeTempDataDir();
    const first = new SecretBox(dir);
    first.encrypt("x");
    const keyPath = path.join(dir, "secret.key");
    fs.chmodSync(keyPath, 0o644);
    const warnings: string[] = [];
    const box = new SecretBox(dir, { warn: (m) => warnings.push(m) });
    box.encrypt("y");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/readable by group\/others/);
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);

    fs.writeFileSync(keyPath, "short\n", { mode: 0o600 });
    expect(() => new SecretBox(dir).encrypt("z")).toThrow(/not a valid 32-byte/);
  });
});
