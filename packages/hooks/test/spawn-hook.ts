import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  json: unknown;
}

export function distPath(name: string): string {
  return path.join(DIST_DIR, name);
}

export async function runHook(
  script: string,
  stdin: string,
  env: Record<string, string | undefined>,
  args: string[] = [],
  cwd?: string,
): Promise<SpawnResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distPath(script), ...args], {
      env: { ...env, PATH: process.env["PATH"] ?? "" },
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      let json: unknown = null;
      try {
        json = stdout.trim().length > 0 ? JSON.parse(stdout) : null;
      } catch {
        json = null;
      }
      resolve({ stdout, stderr, exitCode, json });
    });
    child.stdin.end(stdin);
  });
}
