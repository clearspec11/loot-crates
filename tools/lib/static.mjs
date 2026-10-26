// A tiny static server for the repo root: the harness page and the module's
// scripts, served as plain files so ES module imports resolve.
//
// In a world, the module's stylesheet borrows dnd5e's textures and fonts and
// Foundry's own (module.css reaches them as ../../../systems/dnd5e/...). With
// FOUNDRY_URL set, requests for those paths are passed through to that
// Foundry server so the harness renders with the real assets; without it they
// 404 and the stylesheet's fallbacks apply.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".woff2": "font/woff2", ".ttf": "font/ttf" };
// What a Foundry world serves that the harness may borrow: system and core
// fonts, dnd5e's textures and art, Foundry's ui textures and item icons.
const FOUNDRY_PATHS = /^\/(systems\/dnd5e\/(fonts|ui)\/|fonts\/|ui\/|icons\/)/;

async function passThrough(base, pathname, res) {
  const upstream = await fetch(new URL(pathname, base), { signal: AbortSignal.timeout(4000) });
  if (!upstream.ok) throw new Error(String(upstream.status));
  const body = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, { "content-type": upstream.headers.get("content-type") ?? TYPES[path.extname(pathname)] ?? "application/octet-stream", "cache-control": "max-age=3600" });
  res.end(body);
}

export function serveStatic(root, port, { foundry = process.env.FOUNDRY_URL } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      const pathname = decodeURIComponent(url.pathname);
      if (foundry && FOUNDRY_PATHS.test(pathname)) return await passThrough(foundry, pathname, res);
      let file = path.join(root, pathname);
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
