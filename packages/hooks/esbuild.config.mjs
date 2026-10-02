// Bundles each hook entrypoint into a single, dependency-free ESM file so a
// workspace's .agents/hooks.json can just `node <abs path>/dist/<name>.mjs`
// with no node_modules alongside it. Bundles @agyhq/core (incl. zod) — no
// new deps introduced here; esbuild is already a repo devDependency.
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [
    path.join(dir, "src/bin/pre-tool-use.ts"),
    path.join(dir, "src/bin/audit.ts"),
    path.join(dir, "src/bin/context.ts"),
    path.join(dir, "src/bin/stop.ts"),
  ],
  outdir: path.join(dir, "dist"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  logLevel: "info",
});
