// Test harness re-exports so the CLI test can host a real admin API in-process.
import { openDb } from "@agyhq/db";
import { createAdminApi, EventBus, loadConfig, type AgyhqConfig } from "@agyhq/server";

export { createAdminApi, EventBus };

export function openDbForTest() {
  const db = openDb(":memory:");
  const makeConfig = (overrides: Partial<AgyhqConfig>): AgyhqConfig => ({
    ...loadConfig({ env: { AGYHQ_ADMIN_TOKEN: "x", AGYHQ_DATA_DIR: "/tmp/hq-cli-test-data" }, cwd: "/tmp" }),
    ...overrides,
  });
  return { db, makeConfig };
}
