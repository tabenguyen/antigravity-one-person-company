import { describe, it, expect } from "vitest";
import { startDaemon } from "../src/main.ts";
import { makeTestConfig } from "./helpers.ts";

describe("startDaemon", () => {
  it(
    "reconciles config.port to the actually-bound port when configured with an ephemeral port (0)",
    async () => {
      // Regression test: the orchestrator builds AGYHQ_API_URL from
      // config.port fresh per task run. If config.port is left at the
      // requested value (0 = "let the OS pick") instead of the port actually
      // bound, every spawned `agy` process gets a dead
      // "http://127.0.0.1:0" and every hook/MCP call fails closed — caught
      // via the real end-to-end test (packages/server/test/real-e2e.test.ts):
      // zero tool.pre audit events, hooks' audit spool full of "fetch
      // failed". See the fix + comment in src/main.ts.
      const config = makeTestConfig({ port: 0 });
      const handle = await startDaemon(config);
      try {
        expect(handle.port).toBeGreaterThan(0);
        expect(config.port).toBe(handle.port);

        const res = await fetch(`http://${config.host}:${handle.port}/v1/admin/agents`, {
          headers: { authorization: `Bearer ${config.adminToken}` },
        });
        expect(res.status).toBe(200);
      } finally {
        await handle.stop();
      }
    },
    15_000,
  );
});
