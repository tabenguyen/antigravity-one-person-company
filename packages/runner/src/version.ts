// agy version probe, cached per binary path (agy auto-updates — FINDINGS.md
// #13 — so the harness should record the version actually used per run
// rather than assuming one).

import { spawn } from "node:child_process";
import { resolveAgyBin } from "./bin.ts";

const versionCache = new Map<string, Promise<string | null>>();

/** Resolves to the trimmed stdout of `<agyBin> --version`, or null if the
 *  binary can't be spawned, exits non-zero, or prints nothing. Never throws.
 *  Cached per resolved binary path for the lifetime of the process. */
export function getAgyVersion(agyBin?: string): Promise<string | null> {
  const bin = resolveAgyBin(agyBin);
  let cached = versionCache.get(bin);
  if (!cached) {
    cached = probeVersion(bin);
    versionCache.set(bin, cached);
  }
  return cached;
}

function probeVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const trimmed = out.trim();
      resolve(trimmed.length > 0 ? trimmed : null);
    });
  });
}

/** Test-only escape hatch: clears the version cache so tests can probe a
 *  fresh (e.g. fake) binary without stale state from an earlier test. */
export function _resetAgyVersionCacheForTests(): void {
  versionCache.clear();
}
