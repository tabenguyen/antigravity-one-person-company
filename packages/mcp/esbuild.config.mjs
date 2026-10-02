// Bundles the stdio entrypoint into a single, dependency-free ESM file so a
// workspace's .agents/mcp_config.json can just `node <abs path>/dist/company-mcp.mjs`
// with no node_modules alongside it. Bundles the MCP SDK + zod (no new deps
// introduced here; esbuild is already a repo devDependency).
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [path.join(dir, "src/bin/company-mcp.ts")],
  outfile: path.join(dir, "dist/company-mcp.mjs"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: {
    // Some bundled CJS deps call require(); esbuild's ESM output has no
    // ambient require, so synthesize one bound to this file's URL.
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  logLevel: "info",
});
