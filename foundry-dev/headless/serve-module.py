#!/usr/bin/env python3
"""Serve a folder read-only over HTTP with CORS, so a Foundry page on another
host can import() this checkout's module scripts without changing that host.
Usage: python3 foundry-dev/headless/serve-module.py foundry-module [port]
Then run.cjs with MODULE_BASE=http://<this machine>:<port>/ ."""
import functools, http.server, sys

class CORS(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
    def do_POST(self): self.send_error(405)
    do_PUT = do_DELETE = do_POST

root, port = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 8765
http.server.ThreadingHTTPServer(("0.0.0.0", port), functools.partial(CORS, directory=root)).serve_forever()
