// Secrets at rest: AES-256-GCM with a 32-byte key kept at <dataDir>/secret.key (mode 600, created on first use).
//
// Used for the mailbox passwords the setup wizard stores in the DB. The key lives next to — but outside — the
// SQLite file, so a copied/backed-up agyhq.db alone does not reveal the passwords. This is encryption at rest, not
// a defence against someone who can read the whole data directory (they get the key too); the data directory is
// already the trust boundary (it also holds the admin token).
//
// Token format: "v1:" + base64url(iv(12) | authTag(16) | ciphertext). A caller-supplied `context` label is bound in
// as GCM additional data so a ciphertext cannot be pasted from one field into another.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SECRET_KEY_FILE = "secret.key";
const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface SecretBoxOptions {
  /** Called for non-fatal problems (e.g. a key file readable by group/others). Default: console.warn. */
  warn?: (message: string) => void;
}

export class SecretBox {
  readonly #keyPath: string;
  readonly #warn: (message: string) => void;
  #key: Buffer | null = null;

  constructor(dataDir: string, opts: SecretBoxOptions = {}) {
    this.#keyPath = path.join(dataDir, SECRET_KEY_FILE);
    this.#warn = opts.warn ?? ((m) => console.warn(`[agyhq] ${m}`));
  }

  get keyPath(): string {
    return this.#keyPath;
  }

  #loadKey(): Buffer {
    if (this.#key) return this.#key;
    fs.mkdirSync(path.dirname(this.#keyPath), { recursive: true });
    if (!fs.existsSync(this.#keyPath)) {
      const fresh = crypto.randomBytes(KEY_BYTES);
      try {
        // "wx": never overwrite a key another process created a moment ago.
        fs.writeFileSync(this.#keyPath, `${fresh.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    this.#checkPermissions();
    const raw = fs.readFileSync(this.#keyPath, "utf8").trim();
    const key = Buffer.from(raw, "base64");
    if (key.length !== KEY_BYTES) {
      throw new Error(`${this.#keyPath} is not a valid ${KEY_BYTES}-byte base64 key (delete it only if no secrets are stored yet)`);
    }
    this.#key = key;
    return key;
  }

  #checkPermissions(): void {
    if (process.platform === "win32") return;
    try {
      const mode = fs.statSync(this.#keyPath).mode & 0o777;
      if ((mode & 0o077) === 0) return;
      let fixed = false;
      try {
        fs.chmodSync(this.#keyPath, 0o600);
        fixed = true;
      } catch {
        // fall through to the warning
      }
      this.#warn(
        `${this.#keyPath} was readable by group/others (mode ${mode.toString(8)}); ${fixed ? "tightened to 600" : "could not tighten it — run: chmod 600 " + this.#keyPath}.`,
      );
    } catch {
      // stat failed: the read below will report the real problem
    }
  }

  encrypt(plaintext: string, context = ""): string {
    const key = this.#loadKey();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION}:${Buffer.concat([iv, tag, ct]).toString("base64url")}`;
  }

  /** Throws if the token is malformed, was tampered with, was made for another context, or the key changed. */
  decrypt(token: string, context = ""): string {
    const [version, payload] = token.split(":", 2);
    if (version !== VERSION || !payload) throw new Error("unsupported secret format");
    const buf = Buffer.from(payload, "base64url");
    if (buf.length < IV_BYTES + TAG_BYTES) throw new Error("secret is truncated");
    const key = this.#loadKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  }

  /** decrypt() that returns null instead of throwing (a lost/changed key must not crash the daemon). */
  tryDecrypt(token: string | null | undefined, context = ""): string | null {
    if (!token) return null;
    try {
      return this.decrypt(token, context);
    } catch {
      return null;
    }
  }
}
