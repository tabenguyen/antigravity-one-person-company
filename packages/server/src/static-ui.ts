// Serves the built agy-ui SPA (config.uiDist) at "/", with client-side-route
// fallback to index.html — only when the directory actually exists (agy-ui
// is being built concurrently and may not have a dist/ yet), and never for
// anything under /v1/* (the API always wins).

import fs from "node:fs";
import path from "node:path";
import type { MiddlewareHandler } from "hono";

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function mimeFor(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** Build the Hono middleware that serves `uiDist`. A no-op (calls next()) when uiDist doesn't exist. */
export function createUiStaticMiddleware(uiDist: string): MiddlewareHandler {
  const root = path.resolve(uiDist);
  const indexPath = path.join(root, "index.html");

  return async (c, next) => {
    if (c.req.path.startsWith("/v1/")) return next(); // the API always wins — never shadowed.
    if (!fs.existsSync(root)) return next();

    const relPath = c.req.path === "/" ? "index.html" : c.req.path.slice(1);
    const candidate = path.resolve(path.join(root, relPath));
    if (candidate === root || candidate.startsWith(`${root}${path.sep}`)) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return c.body(fs.readFileSync(candidate), 200, { "content-type": mimeFor(candidate) });
      }
    }

    // SPA fallback: any other GET under "/" resolves to index.html so client-side routing works.
    // Paths that look like files (have an extension) are real misses → 404, not HTML posing as JS.
    if (c.req.method === "GET" && !path.extname(c.req.path) && fs.existsSync(indexPath)) {
      return c.body(fs.readFileSync(indexPath), 200, { "content-type": "text/html; charset=utf-8" });
    }
    return next();
  };
}
