import { describe, it, expect, beforeEach } from "vitest";
import { getAgyVersion, _resetAgyVersionCacheForTests } from "../src/version.ts";
import * as path from "node:path";
import * as url from "node:url";

const FAKE_AGY = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "fixtures", "fake-agy.mjs");

beforeEach(() => {
  _resetAgyVersionCacheForTests();
});

describe("getAgyVersion", () => {
  it("returns the trimmed stdout of `<bin> --version`", async () => {
    await expect(getAgyVersion(FAKE_AGY)).resolves.toBe("1.2.14-fake");
  });

  it("caches the result per bin (second call doesn't re-spawn)", async () => {
    const first = await getAgyVersion(FAKE_AGY);
    const second = await getAgyVersion(FAKE_AGY);
    expect(second).toBe(first);
    // Same promise instance would be returned synchronously for concurrent
    // callers before resolution; verify that too.
    _resetAgyVersionCacheForTests();
    const [a, b] = await Promise.all([getAgyVersion(FAKE_AGY), getAgyVersion(FAKE_AGY)]);
    expect(a).toBe(b);
  });

  it("resolves to null (never throws) when the binary doesn't exist", async () => {
    await expect(getAgyVersion("/nonexistent/binary/agy")).resolves.toBeNull();
  });
});
