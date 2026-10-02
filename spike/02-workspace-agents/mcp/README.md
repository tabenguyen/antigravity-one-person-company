# company-mcp (spike)

Tiny stdio MCP server exposing `kb_search(query)` and `crm_get_contact(email)`
with canned Makini data, built with `@modelcontextprotocol/sdk`.

Build: `npm install && npx tsc -p tsconfig.json` (emits `dist/company-mcp.js`).

Run directly (for manual testing): `node dist/company-mcp.js` (speaks MCP
over stdio — feed it JSON-RPC lines, see raw/ for an example handshake).

Register it in a workspace by pointing a `command`/`args` entry at
`dist/company-mcp.js` from that workspace's `.agents/mcp_config.json` (see
`../workspaces/sales-01/.agents/mcp_config.json` for a working example) —
no global `agy mcp add` required.
