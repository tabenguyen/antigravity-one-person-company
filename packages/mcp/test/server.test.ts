import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HEADERS, McpTools, mcpRoute } from "@agyhq/core";
import type { McpToolName } from "@agyhq/core";

import { createCompanyMcpServer } from "../src/server.ts";
import { HqClient } from "../src/hq-client.ts";
import { startMockDaemon, type MockDaemon } from "./mock-daemon.ts";

const AGENT_ID = "sdr-01";
const TASK_ID = "task_01ABC";
const TOKEN = "test-token-123";

/** One valid minimal input per tool, used for the "every tool wires up" sweep. */
const VALID_INPUT: { [N in McpToolName]: unknown } = {
  kb_search: { query: "refund policy" },
  memory_list: { subject: "contact:jane@acme.com" },
  memory_propose: { content: "Prefers Vietnamese over English." },
  crm_find_contact: { email: "jane@acme.com" },
  crm_upsert_contact: { email: "jane@acme.com", name: "Jane" },
  crm_add_note: { contactId: "contact_1", body: "Called, left voicemail." },
  crm_set_stage: { contactId: "contact_1", stage: "qualified", reason: "Confirmed budget and timeline." },
  task_create: { kind: "sdr.follow_up", title: "Follow up with Jane", input: { note: "in 3 days" } },
  contact_handoff: { contactId: "contact_1", toRole: "account-manager", summary: "Signed the order form; wants onboarding next week." },
  outbox_draft_email: {
    to: "jane@acme.com",
    subject: "Following up",
    body: "Hi Jane, following up on our call.",
    reason: "scheduled follow-up",
  },
};

async function connectedClient(server: ReturnType<typeof createCompanyMcpServer>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function okClient(daemon: MockDaemon, overrides: Partial<ConstructorParameters<typeof HqClient>[0]> = {}): HqClient {
  return new HqClient({ apiUrl: daemon.baseUrl, token: TOKEN, agentId: AGENT_ID, taskId: TASK_ID, ...overrides });
}

describe("createCompanyMcpServer — tool registration", () => {
  it("registers exactly the tools in core McpTools, with matching descriptions", async () => {
    const daemon = await startMockDaemon(() => ({ status: 200, body: { ok: true, data: {} } }));
    try {
      const server = createCompanyMcpServer({ client: okClient(daemon) });
      const client = await connectedClient(server);
      const { tools } = await client.listTools();

      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(Object.keys(McpTools).sort());

      for (const tool of tools) {
        const expected = McpTools[tool.name as McpToolName];
        expect(tool.description).toBe(expected.description);
      }
    } finally {
      await daemon.close();
    }
  });
});

describe("createCompanyMcpServer — happy path per tool", () => {
  let daemon: MockDaemon;

  beforeEach(async () => {
    daemon = await startMockDaemon(() => ({ status: 200, body: { ok: true, data: { echoed: true } } }));
  });

  afterEach(async () => {
    await daemon.close();
  });

  for (const toolName of Object.keys(McpTools) as McpToolName[]) {
    it(`${toolName}: posts to mcpRoute with the right headers and validated body`, async () => {
      const server = createCompanyMcpServer({ client: okClient(daemon) });
      const client = await connectedClient(server);

      const result = await client.callTool({ name: toolName, arguments: VALID_INPUT[toolName] as Record<string, unknown> });

      expect(result.isError).not.toBe(true);
      expect(daemon.captured).toHaveLength(1);
      const req = daemon.captured[0]!;
      expect(req.method).toBe("POST");
      expect(req.url).toBe(mcpRoute(toolName));
      expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(req.headers[HEADERS.agentId]).toBe(AGENT_ID);
      expect(req.headers[HEADERS.taskId]).toBe(TASK_ID);

      const expectedParsed = McpTools[toolName].input.parse(VALID_INPUT[toolName]);
      expect(req.body).toEqual(expectedParsed);

      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.type).toBe("text");
      expect(JSON.parse(content[0]!.text)).toEqual({ echoed: true });
    });
  }

  it("omits the x-agyhq-task-id header when no taskId is configured", async () => {
    const server = createCompanyMcpServer({ client: okClient(daemon, { taskId: null }) });
    const client = await connectedClient(server);
    await client.callTool({ name: "kb_search", arguments: VALID_INPUT.kb_search as Record<string, unknown> });
    expect(daemon.captured[0]!.headers[HEADERS.taskId]).toBeUndefined();
  });
});

describe("createCompanyMcpServer — validation errors never reach the daemon", () => {
  let daemon: MockDaemon;

  beforeEach(async () => {
    daemon = await startMockDaemon(() => ({ status: 200, body: { ok: true, data: {} } }));
  });

  afterEach(async () => {
    await daemon.close();
  });

  it("crm_find_contact with none of email/id/query fails the .refine() and never calls the daemon", async () => {
    const server = createCompanyMcpServer({ client: okClient(daemon) });
    const client = await connectedClient(server);

    const result = await client.callTool({ name: "crm_find_contact", arguments: {} });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toMatch(/invalid arguments/i);
    expect(daemon.captured).toHaveLength(0);
  });

  it("outbox_draft_email with an invalid email fails validation and never calls the daemon", async () => {
    const server = createCompanyMcpServer({ client: okClient(daemon) });
    const client = await connectedClient(server);

    const result = await client.callTool({
      name: "outbox_draft_email",
      arguments: { to: "not-an-email", subject: "Hi", body: "body", reason: "because" },
    });

    expect(result.isError).toBe(true);
    expect(daemon.captured).toHaveLength(0);
  });

  it("missing required field (kb_search without query) fails validation and never calls the daemon", async () => {
    const server = createCompanyMcpServer({ client: okClient(daemon) });
    const client = await connectedClient(server);

    const result = await client.callTool({ name: "kb_search", arguments: {} });

    expect(result.isError).toBe(true);
    expect(daemon.captured).toHaveLength(0);
  });
});

describe("createCompanyMcpServer — daemon error envelope", () => {
  it("surfaces the daemon's ApiEnvelope error as isError with code and message", async () => {
    const daemon = await startMockDaemon(() => ({
      status: 403,
      body: { ok: false, error: { code: "forbidden", message: "agent not permitted to search this scope" } },
    }));
    try {
      const server = createCompanyMcpServer({ client: okClient(daemon) });
      const client = await connectedClient(server);

      const result = await client.callTool({ name: "kb_search", arguments: { query: "pricing" } });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toMatch(/forbidden/);
      expect(content[0]!.text).toMatch(/agent not permitted to search this scope/);
    } finally {
      await daemon.close();
    }
  });

  it("surfaces a non-JSON daemon response as isError instead of throwing", async () => {
    const daemon = await startMockDaemon(() => ({ status: 200, body: undefined as unknown }));
    // Overwrite with a raw non-JSON body by closing over a custom server would be more work;
    // simplest: respond 500 with HTML-ish text via the JSON.stringify(undefined) -> "undefined"
    // which is invalid JSON, exercising the client's non-JSON-response branch.
    try {
      const server = createCompanyMcpServer({ client: okClient(daemon) });
      const client = await connectedClient(server);

      const result = await client.callTool({ name: "kb_search", arguments: { query: "pricing" } });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toMatch(/kb_search failed/);
    } finally {
      await daemon.close();
    }
  });
});

describe("createCompanyMcpServer — daemon unreachable / timeout", () => {
  it("daemon down (connection refused) yields isError, not a crash", async () => {
    // Bind then immediately close a server to get a port nothing is listening on.
    const daemon = await startMockDaemon(() => ({ status: 200, body: { ok: true, data: {} } }));
    const deadPort = daemon.port;
    await daemon.close();

    const client = new HqClient({ apiUrl: `http://127.0.0.1:${deadPort}`, token: TOKEN, agentId: AGENT_ID });
    const server = createCompanyMcpServer({ client });
    const mcpClient = await connectedClient(server);

    const result = await mcpClient.callTool({ name: "kb_search", arguments: { query: "pricing" } });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toMatch(/kb_search failed/);
  });

  it("a hung daemon yields isError via the request timeout, not an unhandled rejection", async () => {
    const neverResolves: typeof fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;

    const client = new HqClient({
      apiUrl: "http://127.0.0.1:65535",
      token: TOKEN,
      agentId: AGENT_ID,
      timeoutMs: 25,
      fetchImpl: neverResolves,
    });
    const server = createCompanyMcpServer({ client });
    const mcpClient = await connectedClient(server);

    const result = await mcpClient.callTool({ name: "kb_search", arguments: { query: "pricing" } });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toMatch(/timed out/);
  });
});

describe("createCompanyMcpServer — missing env", () => {
  it("every tool call errors with an actionable message, and the server still starts", async () => {
    const server = createCompanyMcpServer({ client: null, envError: { missing: ["AGYHQ_API_URL", "AGYHQ_TOKEN"] } });
    const client = await connectedClient(server);

    const result = await client.callTool({ name: "kb_search", arguments: { query: "pricing" } });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toMatch(/not configured/i);
    expect(content[0]!.text).toMatch(/AGYHQ_API_URL/);
    expect(content[0]!.text).toMatch(/AGYHQ_TOKEN/);
  });
});

describe("HqClient.fromEnv", () => {
  it("reports every missing AGYHQ_* var", () => {
    const result = HqClient.fromEnv({});
    expect(result.client).toBeNull();
    if (result.client) throw new Error("unreachable");
    expect(result.error.missing.sort()).toEqual(["AGYHQ_AGENT_ID", "AGYHQ_API_URL", "AGYHQ_TOKEN"].sort());
  });

  it("builds a client when all required vars are present, taskId optional", () => {
    const result = HqClient.fromEnv({
      AGYHQ_API_URL: "http://127.0.0.1:7317",
      AGYHQ_TOKEN: "t",
      AGYHQ_AGENT_ID: "sdr-01",
    });
    expect(result.client).not.toBeNull();
  });
});
