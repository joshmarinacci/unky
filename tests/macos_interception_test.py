#!/usr/bin/env python3
"""Launch the macOS-only Tauri/WKContentRuleList smoke test and inspect server logs."""

import subprocess
import sys
import tempfile
import time
from pathlib import Path

if sys.platform != "darwin":
    raise SystemExit("This integration test requires macOS.")

server_log = tempfile.NamedTemporaryFile(mode="w+t", delete=False)
app_log = tempfile.TemporaryFile(mode="w+t")
server_log_path = Path(server_log.name)
server = subprocess.Popen([sys.executable, "tests/fixtures/server.py"], stdout=server_log, stderr=subprocess.STDOUT)
app = None
try:
    time.sleep(0.4)
    app = subprocess.Popen(["pnpm", "tauri", "dev", "--features", "macos-interception-test"], stdout=app_log, stderr=subprocess.STDOUT)
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline and app.poll() is None:
        current_log = server_log_path.read_text()
        if "RESOURCE /allowed.png" in current_log:
            time.sleep(1)  # Give a broken filter time to send the blocked request too.
            break
        time.sleep(1)
    if app.poll() is None:
        app.terminate()
    app.wait(timeout=15)
    server.terminate()
    server.wait(timeout=5)
    server_log.flush()
    server_log.seek(0)
    app_log.seek(0)
    server_output = server_log.read()
    app_output = app_log.read()
    requests = [line for line in server_output.splitlines() if line.startswith("RESOURCE ")]
    if "RESOURCE /allowed.png" not in requests:
        print(app_output)
        print(server_output)
        raise SystemExit("FAIL: allowed cross-origin image never reached the fixture server")
    if "RESOURCE /blocked.png" in requests:
        print(server_output)
        raise SystemExit("FAIL: blocked image reached the fixture server")
    print("PASS: allowed.png reached the server; blocked.png was not requested")
finally:
    for process in (app, server):
        if process is not None and process.poll() is None:
            process.terminate()
    server_log.close()
    app_log.close()
    server_log_path.unlink(missing_ok=True)
