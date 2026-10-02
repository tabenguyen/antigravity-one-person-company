import { describe, it, expect } from "vitest";
import { parseQuotaOutput, readQuota } from "../src/quota.ts";
import * as path from "node:path";
import * as url from "node:url";

const FAKE_AGY = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "fixtures", "fake-agy.mjs");

const REAL_SAMPLE = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "ignored",
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: {
    name: "usage",
    data: {
      description: "d",
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.61, reset_time: "2026-10-07T02:28:26Z" },
            { id: "gemini-5h", window: "5h", remaining_fraction: 0.62, reset_time: "2026-10-01T04:24:32Z" },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [{ id: "3p-weekly", window: "weekly", remaining_fraction: 0.63, reset_time: "2026-10-06T18:37:34Z" }],
        },
      ],
    },
  },
});

describe("parseQuotaOutput", () => {
  it("parses the real captured /usage shape into flattened QuotaBucket[]", () => {
    const buckets = parseQuotaOutput(REAL_SAMPLE);
    expect(buckets).toEqual([
      { group: "Gemini Models", window: "weekly", remainingFraction: 0.61, resetTime: "2026-10-07T02:28:26Z" },
      { group: "Gemini Models", window: "5h", remainingFraction: 0.62, resetTime: "2026-10-01T04:24:32Z" },
      { group: "Claude and GPT models", window: "weekly", remainingFraction: 0.63, resetTime: "2026-10-06T18:37:34Z" },
    ]);
  });

  it("returns [] for invalid JSON rather than throwing", () => {
    expect(parseQuotaOutput("not json")).toEqual([]);
  });

  it("returns [] when command/data/groups is missing", () => {
    expect(parseQuotaOutput("{}")).toEqual([]);
    expect(parseQuotaOutput('{"command":{}}')).toEqual([]);
    expect(parseQuotaOutput('{"command":{"data":{}}}')).toEqual([]);
    expect(parseQuotaOutput('{"command":{"data":{"groups":"nope"}}}')).toEqual([]);
  });

  it("skips a malformed bucket but keeps the valid ones in the same group", () => {
    const raw = JSON.stringify({
      command: {
        data: {
          groups: [
            {
              name: "G",
              buckets: [{ window: "weekly" /* missing remaining_fraction */ }, { window: "5h", remaining_fraction: 0.5 }],
            },
          ],
        },
      },
    });
    expect(parseQuotaOutput(raw)).toEqual([{ group: "G", window: "5h", remainingFraction: 0.5, resetTime: null }]);
  });

  it("defaults group name and window when missing, and resetTime to null", () => {
    const raw = JSON.stringify({ command: { data: { groups: [{ buckets: [{ remaining_fraction: 0.9 }] }] } } });
    expect(parseQuotaOutput(raw)).toEqual([{ group: "unknown", window: "unknown", remainingFraction: 0.9, resetTime: null }]);
  });
});

describe("readQuota (against fake agy)", () => {
  it("returns parsed buckets from the fake binary's /usage response", async () => {
    const buckets = await readQuota(FAKE_AGY);
    expect(buckets.length).toBe(3);
    expect(buckets[0]).toEqual({
      group: "Gemini Models",
      window: "weekly",
      remainingFraction: 0.6149988770484924,
      resetTime: "2026-10-07T02:28:26Z",
    });
  });

  it("returns [] when the binary doesn't exist, never throws", async () => {
    await expect(readQuota("/nonexistent/binary/agy")).resolves.toEqual([]);
  });
});
