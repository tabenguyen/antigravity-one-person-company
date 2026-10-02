#!/usr/bin/env node
/**
 * company-mcp — tiny stdio MCP server for the agy-hq Phase 0 spike.
 *
 * Exposes two canned "company" tools so we can verify that a custom agy
 * agent, running headless in a per-agent workspace, can discover and call
 * workspace-scoped MCP tools:
 *
 *   - kb_search(query)         -> canned knowledge-base snippets
 *   - crm_get_contact(email)   -> canned CRM contact record
 *
 * Run with: npx tsx company-mcp.ts   (or: node dist/company-mcp.js after build)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const KB: Array<{ id: string; title: string; text: string }> = [
  {
    id: "pricing-001",
    title: "Makini Pricing",
    text:
      "Makini has three plans: Starter ($49/mo, 1 store), Growth ($199/mo, " +
      "up to 10 stores, multi-channel sync), and Scale (custom pricing, " +
      "unlimited stores, dedicated support). All plans include a 14-day " +
      "money-back guarantee.",
  },
  {
    id: "refund-001",
    title: "Refund Policy",
    text:
      "Makini offers a 14-day, no-questions-asked money-back guarantee on " +
      "all plans. Refund requests go through Customer Success, never " +
      "through Sales.",
  },
  {
    id: "product-001",
    title: "Product Overview",
    text:
      "Makini is an AI-powered inventory and order management platform for " +
      "small e-commerce retailers in Vietnam and Southeast Asia. It syncs " +
      "stock across Shopee, Lazada, TikTok Shop, and a retailer's own " +
      "website in real time to prevent overselling.",
  },
];

const CRM: Record<string, { name: string; company: string; stage: string; notes: string }> = {
  "linh@hanoifashion.example.com": {
    name: "Linh Nguyen",
    company: "Hanoi Fashion Chain (20 stores)",
    stage: "qualified",
    notes: "Overselling across Shopee + own site. Wants to go live before Tet.",
  },
  "hoa@hoaphatretail.example.com": {
    name: "Hoa Tran",
    company: "Hoa Phat Retail",
    stage: "customer-at-risk",
    notes: "Usage down 40% last month, 2 open support tickets, renewal in 10 days.",
  },
};

const server = new McpServer({
  name: "company-mcp",
  version: "0.1.0",
});

server.registerTool(
  "kb_search",
  {
    title: "Knowledge base search",
    description:
      "Search Makini's company knowledge base (pricing, product, policies) " +
      "and return matching snippets with citations.",
    inputSchema: {
      query: z.string().describe("Free-text search query"),
    },
  },
  async ({ query }) => {
    const q = query.toLowerCase();
    const hits = KB.filter(
      (doc) =>
        doc.title.toLowerCase().includes(q) ||
        doc.text.toLowerCase().includes(q) ||
        q.split(/\s+/).some((word) => word.length > 3 && doc.text.toLowerCase().includes(word))
    );
    const results = hits.length > 0 ? hits : KB;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              query,
              results: results.map((r) => ({ id: r.id, title: r.title, snippet: r.text })),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.registerTool(
  "crm_get_contact",
  {
    title: "CRM contact lookup",
    description: "Look up a Makini CRM contact record by email address.",
    inputSchema: {
      email: z.string().describe("Contact email address"),
    },
  },
  async ({ email }) => {
    const record = CRM[email.toLowerCase()];
    if (!record) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ email, found: false }, null, 2),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ email, found: true, ...record }, null, 2),
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
