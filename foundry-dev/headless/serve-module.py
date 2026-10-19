#!/usr/bin/env python3
"""Serve a folder read-only over HTTP with CORS, so a Foundry page on another
host can import() this checkout's module scripts without changing that host.
Usage: python3 foundry-dev/headless/serve-module.py module [port] [foundry-url]

The module's stylesheet borrows dnd5e's and Foundry's textures by relative
path (../../../systems/dnd5e/..., ../../../ui/...), which from here resolve
to this server's root. Given a Foundry URL (third argument or FOUNDRY_URL),
those paths are passed through to it, as they are when Foundry itself serves
an installed module."""
import functools, http.server, os, sys, urllib.request

FOUNDRY = (sys.argv[3] if len(sys.argv) > 3 else os.environ.get("FOUNDRY_URL", "")).rstrip("/")
BORROWED = ("/systems/dnd5e/", "/ui/", "/fonts/", "/icons/")

class CORS(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if FOUNDRY and path.startswith(BORROWED):
            try:
                with urllib.request.urlopen(FOUNDRY + path, timeout=5) as r:
                    body = r.read()
                    self.send_response(200)
                    self.send_header("Content-Type", r.headers.get("Content-Type", "application/octet-stream"))
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
            except Exception:
                self.send_error(404)
                return
        super().do_GET()
    def do_POST(self): self.send_error(405)
    do_PUT = do_DELETE = do_POST

root, port = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 8765
http.server.ThreadingHTTPServer(("0.0.0.0", port), functools.partial(CORS, directory=root)).serve_forever()
