// Shared test helper: a minimal HTTP "daemon" stand-in for the agy-hq
// control plane, used to assert what the company MCP server actually sends
// (method, route, headers, body) and to script canned responses.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export type MockDaemonHandler = (req: CapturedRequest) => { status: number; body: unknown };

export interface MockDaemon {
  server: Server;
  port: number;
  baseUrl: string;
  captured: CapturedRequest[];
  setHandler: (handler: MockDaemonHandler) => void;
  close: () => Promise<void>;
}

export async function startMockDaemon(initialHandler: MockDaemonHandler): Promise<MockDaemon> {
  const captured: CapturedRequest[] = [];
  let handler = initialHandler;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const record: CapturedRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      captured.push(record);
      const { status, body: responseBody } = handler(record);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    captured,
    setHandler: (next) => {
      handler = next;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
