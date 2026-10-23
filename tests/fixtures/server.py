from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import time
import os

ROOT = Path(__file__).parent
PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c020000000b4944415478da6360fcff1f0003030200efbf9d770000000049454e44ae426082")
os.chdir(ROOT)

class PageHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/favicon.svg":
            payload = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#7c5cbf"/></svg>'
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if self.path == "/download.txt":
            payload = ("native webview download fixture\n" * 8192).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Disposition", 'attachment; filename="fixture-download.txt"')
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            for offset in range(0, len(payload), 8192):
                self.wfile.write(payload[offset:offset + 8192])
                self.wfile.flush()
                time.sleep(0.025)
            print(f"DOWNLOAD {self.path} {len(payload)}", flush=True)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        print(f"PAGE {fmt % args}", flush=True)

class ResourceHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        print(f"RESOURCE {self.path}", flush=True)
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(PNG)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(PNG)

    def log_message(self, fmt, *args):
        pass

if __name__ == "__main__":
    page_server = ThreadingHTTPServer(("127.0.0.1", 4179), PageHandler)
    resource_server = ThreadingHTTPServer(("127.0.0.1", 4180), ResourceHandler)
    Thread(target=resource_server.serve_forever, daemon=True).start()
    print("Fixture origins: page http://127.0.0.1:4179, resource http://127.0.0.1:4180", flush=True)
    page_server.serve_forever()
