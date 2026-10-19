// A tiny static server for the repo root: the harness page and the module's
// scripts, served as plain files so ES module imports resolve.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp" };

export function serveStatic(root, port) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      let file = path.join(root, decodeURIComponent(url.pathname));
      if (!file.startsWith(root)) throw new Error("outside root");
      if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise(resolve => server.listen(port, "0.0.0.0", () => resolve(server)));
}
