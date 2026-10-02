// A minimal mock of the agy-hq daemon's hook routes, for integration-testing
// the BUILT dist/*.mjs scripts as real child processes. Node builtins only.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { HEADERS, HOOK_ROUTES, type ApiEnvelope } from "@agyhq/core";

export interface RecordedRequest {
  route: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export type RouteHandler = (body: unknown) => { status?: number; envelope: ApiEnvelope<unknown> } | "timeout" | "hang";

export interface MockDaemon {
  url: string;
  requests: RecordedRequest[];
  setHandler(route: string, handler: RouteHandler): void;
  close(): Promise<void>;
}

const ALL_ROUTES = Object.values(HOOK_ROUTES);

export async function startMockDaemon(): Promise<MockDaemon> {
  const requests: RecordedRequest[] = [];
  const handlers = new Map<string, RouteHandler>();

  const server = http.createServer((req, res) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      let body: unknown = null;
      try {
        body = data.length > 0 ? JSON.parse(data) : null;
      } catch {
        body = null;
      }
      const route = req.url ?? "";
      requests.push({ route, method: req.method ?? "", headers: req.headers, body });

      const handler = handlers.get(route);
      if (!handler) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: { code: "not_found", message: "no handler" } }));
        return;
      }
      const result = handler(body);
      if (result === "hang") {
        // Never respond — used to test client-side timeout handling.
        return;
      }
      if (result === "timeout") {
        // Respond, but slowly enough to blow past any reasonable test timeout.
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, data: {} }));
        }, 60_000);
        return;
      }
      res.writeHead(result.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(result.envelope));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  // Default: every route allows/no-ops, so tests only override what they care about.
  for (const route of ALL_ROUTES) {
    handlers.set(route, () => ({ envelope: { ok: true, data: {} } }));
  }

  return {
    url,
    requests,
    setHandler(route, handler) {
      handlers.set(route, handler);
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

export { HEADERS };
