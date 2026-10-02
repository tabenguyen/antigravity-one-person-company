// Quota polling via `agy --print "/usage" --output-format json`.
//
// Shape verified once, against agy 1.2.14, in
// spike/04-concurrency-sdk/runs/probe-usage-0-1790827702790/stdout.json:
//
//   { ..., "command": { "name": "usage", "data": { "groups": [
//       { "name": "Gemini Models", "buckets": [
//           { "id": "gemini-weekly", "window": "weekly",
//             "remaining_fraction": 0.61, "reset_time": "2026-10-07T...Z" },
//           ...
//       ]},
//       ...
//   ]}}}
//
// This costs no quota/tokens to poll (FINDINGS.md spike 04, point 3).

import { spawn } from "node:child_process";
import type { QuotaBucket } from "@agyhq/core";
import { resolveAgyBin } from "./bin.ts";

/** Resolves to the per-model-group quota buckets, or [] if the binary can't
 *  be spawned, exits non-zero, or the output doesn't parse. Never throws. */
export async function readQuota(agyBin?: string): Promise<QuotaBucket[]> {
  const bin = resolveAgyBin(agyBin);
  const stdout = await runUsageCommand(bin);
  if (stdout === null) return [];
  return parseQuotaOutput(stdout);
}

function runUsageCommand(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(bin, ["--print", "/usage", "--output-format", "json"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(null);
      return;
    }
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      resolve(code === 0 ? out : null);
    });
  });
}

interface RawUsageBucket {
  window?: unknown;
  remaining_fraction?: unknown;
  reset_time?: unknown;
}

interface RawUsageGroup {
  name?: unknown;
  buckets?: unknown;
}

/** Parses the `/usage --output-format json` response body into core
 *  QuotaBucket[]. Exported for direct unit testing. Defensive at every
 *  level — any missing/malformed piece of the shape is skipped rather than
 *  thrown, since this shape was observed only once in the spike. */
export function parseQuotaOutput(raw: string): QuotaBucket[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];

  const command = (parsed as Record<string, unknown>).command;
  if (typeof command !== "object" || command === null) return [];

  const data = (command as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) return [];

  const groups = (data as Record<string, unknown>).groups;
  if (!Array.isArray(groups)) return [];

  const result: QuotaBucket[] = [];
  for (const g of groups) {
    if (typeof g !== "object" || g === null) continue;
    const group = g as RawUsageGroup;
    const groupName = typeof group.name === "string" ? group.name : "unknown";
    const buckets = group.buckets;
    if (!Array.isArray(buckets)) continue;

    for (const b of buckets) {
      if (typeof b !== "object" || b === null) continue;
      const bucket = b as RawUsageBucket;
      if (typeof bucket.remaining_fraction !== "number") continue;
      result.push({
        group: groupName,
        window: typeof bucket.window === "string" ? bucket.window : "unknown",
        remainingFraction: bucket.remaining_fraction,
        resetTime: typeof bucket.reset_time === "string" ? bucket.reset_time : null,
      });
    }
  }
  return result;
}
